"""Defocus the regions of a generated still that came back carrying fake text.

The image model draws garbled lettering on its own initiative. A controlled A/B over
16 images showed the prompt-level ban barely moves it (text in 6/8 images without the
ban, 5/8 with it), and it fired on a prompt that named no screen at all -- so this is a
bias in the model, not a prompt-following problem, and the only place left to fix it is
after generation. That is the same conclusion the letterbox work reached for black bars.

What this does NOT do: reject the image. A regenerate costs another call and re-rolls
the same bias, so the region is softened in place and everything outside it is left
byte-identical.

Defocus, not blur-to-mush: the region is resolution-reduced (down with INTER_AREA, back
up with INTER_LINEAR) and then lightly smoothed. Removing the resolution is what kills
glyph structure -- a plain gaussian of the same visual strength leaves a legible smear
that still reads as rows of characters. The result looks like a screen that is out of
the lens's focal plane, which is what it should have been.

The mask is feathered before blending, so there is no rectangle edge. A hard-edged blur
patch is its own generated-image tell, and would survive the upscaler just as readably
as the text it replaced.
"""
import argparse
import json
import sys

import cv2
import numpy as np

# How far the softened area extends past the reported box, as a fraction of the box.
# The detector tends to bound the glyphs rather than the panel they sit on, and a
# character clipped at the boundary stays sharp and legible on its own.
PAD_FRAC = 0.04

# Resolution left in the region, as a fraction. 1/8 puts a 10px glyph under 2px, which
# is below the size at which stroke direction can be read.
KEEP_RES = 0.125

# Feather width as a fraction of the smaller box side, and its floor in pixels.
FEATHER_FRAC = 0.10
FEATHER_MIN = 6.0

# --- Text written ON something that is not a screen -------------------------------
# Kernel for the top-hat that isolates the glyph strokes: structures thinner than this
# and brighter than what surrounds them.
STROKE_KERNEL = 9
# Only the brightest few percent of the top-hat response are strokes. Measured on the
# proving frame the strokes are 3.2% of the box, so a 97th percentile cut lands on them.
STROKE_PCTL = 97
STROKE_FLOOR = 12
# Grown to cover the stroke's own soft edge, then feathered so nothing has a hard rim.
#
# Deliberately a constant, and scaling it to the box was tried and measured worse. The
# theory was that a fixed growth eats proportionally more of a small box, since one real
# frame kept 85% of its face detail on a 592x407 box and another only 51% on 130x162
# boxes. The numbers do not support it: at the same 7px the dilated mask covers 12.9% of
# the first box and 15.6% of the second, both frames carry 3.2% raw stroke pixels, and
# both sit on the SAME curve of growth against detail. The gap is what is inside the box
# — the large box spans mostly smooth forehead, the small ones hug text lying across
# eyes and brow — and no growth rule reaches that. Scaling by the short side made things
# worse at both ends: 9px on the large box (face 86.6% -> 80.4%) and 3px on the small
# ones, where the glyphs stay legible (stroke energy 8.7% -> 27.8%).
#
# What the sweep does say is that 7 was past the knee. Growth trades face detail against
# suppression along one curve, and 5 buys back real detail at both sizes — 86.6% -> 91.5%
# and 51.0% -> 60.5% — while the lettering stays illegible in both. At 3 it does not:
# characters are still readable on the cheek.
STROKE_GROW = 5
STROKE_FEATHER = 2.0
# Wide enough to swallow a grown stroke whole; a median of this size removes thin bright
# marks and leaves real edges (a spectacle frame, an eyelid) where they are.
STROKE_MEDIAN = 15


def stroke_mask(img: np.ndarray, box: tuple) -> np.ndarray:
    """A float mask over just the glyph strokes inside `box`, feathered at their edges."""
    h, w = img.shape[:2]
    x0, y0, x1, y1 = (max(0, box[0]), max(0, box[1]), min(w, box[2]), min(h, box[3]))
    m = np.zeros((h, w), np.float32)
    if x1 - x0 < 4 or y1 - y0 < 4:
        return m
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    top = cv2.morphologyEx(
        g, cv2.MORPH_TOPHAT,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (STROKE_KERNEL, STROKE_KERNEL)))
    inbox = np.zeros((h, w), bool)
    inbox[y0:y1, x0:x1] = True
    thr = max(STROKE_FLOOR, int(np.percentile(top[inbox], STROKE_PCTL)))
    hit = ((top >= thr) & inbox).astype(np.uint8)
    hit = cv2.dilate(hit, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (STROKE_GROW, STROKE_GROW)))
    hit[~inbox] = 0
    return np.clip(cv2.GaussianBlur(hit.astype(np.float32), (0, 0), STROKE_FEATHER), 0.0, 1.0)


def soften_strokes(img: np.ndarray, box: tuple) -> np.ndarray:
    """Remove the lettering inside `box` without flattening what it is written on.

    For text sitting ON something -- projected across a face, reflected on a wall -- the
    whole-box treatment is the wrong trade. Measured on the frame that proved it: the
    strokes are 3.2% of the box and the face is 86%, so softening the box to hide the
    text cost 89% of the face's detail (162.2 -> 13.9) and still left the lettering
    faintly legible. Shrinking the box does not escape it, it just trades linearly --
    covering half the text keeps only 45% of the face.

    So blend a median only where the strokes are. The median is chosen over a blur or an
    inpaint on measurement: inpainting scored better on both metrics and looked worse,
    tearing a hole in the spectacle frame where strokes crossed it.
    """
    m = stroke_mask(img, box)
    if not m.any():
        return img
    med = cv2.medianBlur(img, STROKE_MEDIAN)
    m3 = m[..., None]
    return (img * (1.0 - m3) + med * m3).astype(img.dtype)


def defocus_region(img: np.ndarray, box: tuple, keep_res: float = KEEP_RES) -> np.ndarray:
    """Return `img` with the pixels inside `box` (x0, y0, x1, y1) resolution-reduced.

    Blends through a feathered mask, so the caller can apply several overlapping boxes
    without leaving seams where they meet.
    """
    h, w = img.shape[:2]
    x0, y0, x1, y1 = box
    px = int(round((x1 - x0) * PAD_FRAC))
    py = int(round((y1 - y0) * PAD_FRAC))
    x0 = max(0, x0 - px); y0 = max(0, y0 - py)
    x1 = min(w, x1 + px); y1 = min(h, y1 + py)
    bw, bh = x1 - x0, y1 - y0
    if bw < 4 or bh < 4:
        return img

    # Resolution removal on the padded region.
    small_w = max(2, int(bw * keep_res))
    small_h = max(2, int(bh * keep_res))
    region = img[y0:y1, x0:x1]
    soft = cv2.resize(region, (small_w, small_h), interpolation=cv2.INTER_AREA)
    soft = cv2.resize(soft, (bw, bh), interpolation=cv2.INTER_LINEAR)
    # Takes the staircase off the re-enlargement; without it the blocks are an edge the
    # upscaler is happy to sharpen.
    k = max(3, (int(min(bw, bh) * keep_res) | 1))
    soft = cv2.GaussianBlur(soft, (k, k), 0)

    feather = max(FEATHER_MIN, min(bw, bh) * FEATHER_FRAC)
    mask = np.zeros((bh, bw), np.float32)
    inset = int(round(feather))
    if bw > 2 * inset and bh > 2 * inset:
        mask[inset:bh - inset, inset:bw - inset] = 1.0
    else:
        mask[:] = 1.0
    mask = cv2.GaussianBlur(mask, (0, 0), feather / 2.0)
    mask = np.clip(mask, 0.0, 1.0)[..., None]

    out = img.copy()
    out[y0:y1, x0:x1] = (region * (1.0 - mask) + soft * mask).astype(img.dtype)
    return out


def apply_boxes(img: np.ndarray, boxes: list, modes: list | None = None) -> np.ndarray:
    """Soften each box, by the treatment its surface calls for.

    `modes[i]` is 'surface' for lettering written onto something that matters in its own
    right, anything else (including missing) for a screen. Screen is the default because
    it is the safe direction: it is what this has always done, and on a real panel the
    stroke-only treatment leaves the code plainly readable.
    """
    for i, b in enumerate(boxes):
        box = tuple(int(v) for v in b)
        mode = (modes[i] if modes and i < len(modes) else 'screen')
        img = soften_strokes(img, box) if mode == 'surface' else defocus_region(img, box)
    return img


def detail(img: np.ndarray) -> float:
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
    return float(cv2.Laplacian(g, cv2.CV_32F).var())


def selftest() -> int:
    rng = np.random.default_rng(0)
    img = np.full((400, 600, 3), 30, np.uint8)
    # Rows of bright bars standing in for lines of code: the structure that has to die.
    for row in range(120, 260, 12):
        for col in range(220, 420, 7):
            img[row:row + 5, col:col + 4] = 220
    # Detail outside the box that must survive untouched.
    img[300:380, 60:180] = rng.integers(0, 255, (80, 120, 3), dtype=np.uint8)

    box = (200, 100, 440, 280)
    out = apply_boxes(img.copy(), [box])

    inner_before = detail(img[130:250, 230:410])
    inner_after = detail(out[130:250, 230:410])
    assert inner_after < inner_before * 0.05, f'text not destroyed: {inner_before:.1f} -> {inner_after:.1f}'

    # Everything well outside the padded box is byte-identical.
    assert np.array_equal(img[300:380, 60:180], out[300:380, 60:180]), 'detail outside the box was touched'

    # No hard step at the boundary: the largest single-pixel jump along a row crossing
    # the edge stays small, which a rectangle paste would not.
    row_b = img[190, :, 0].astype(np.int32)
    row_a = out[190, :, 0].astype(np.int32)
    edge = np.abs(np.diff(row_a[180:210]))
    assert edge.max() <= max(12, np.abs(np.diff(row_b[180:210])).max()), f'hard seam at edge: {edge.max()}'

    # A box larger than the image is clamped rather than throwing.
    apply_boxes(img.copy(), [(-50, -50, 9999, 9999)])
    # A degenerate box is a no-op, not a crash.
    assert np.array_equal(img, apply_boxes(img.copy(), [(10, 10, 12, 12)]))

    # --- surface mode: kill the strokes, keep what they are written on -------------
    # A textured field standing in for a face, with thin bright strokes laid over it.
    face = rng.integers(90, 170, (180, 240, 3), dtype=np.uint8)
    scene = np.full((400, 600, 3), 30, np.uint8)
    scene[100:280, 200:440] = face
    for row in range(110, 270, 11):
        scene[row:row + 2, 210:430] = 240

    sbox = (200, 100, 440, 280)
    surf = apply_boxes(scene.copy(), [sbox], ['surface'])
    scr = apply_boxes(scene.copy(), [sbox], ['screen'])

    m = stroke_mask(scene, sbox) > 0.5
    keep = np.zeros(scene.shape[:2], bool)
    keep[100:280, 200:440] = True
    keep &= ~m

    def var_on(a, sel):
        g = cv2.cvtColor(a, cv2.COLOR_BGR2GRAY).astype(np.float32)
        return float(cv2.Laplacian(g, cv2.CV_32F)[sel].var())

    base = var_on(scene, keep)
    # The surface itself survives; the whole-box treatment is what flattens it.
    assert var_on(surf, keep) > base * 0.5, 'surface mode flattened what the text sat on'
    assert var_on(scr, keep) < base * 0.5, 'screen mode unexpectedly preserved the surface'
    # And the lettering still goes: stroke contrast has to drop hard.
    top = lambda a: cv2.morphologyEx(
        cv2.cvtColor(a, cv2.COLOR_BGR2GRAY), cv2.MORPH_TOPHAT,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (STROKE_KERNEL, STROKE_KERNEL)))
    # The bars here sit 11px apart against a 9px top-hat kernel, so neighbours interfere
    # and the synthetic residual is far worse than a real frame's: 0.36 here against a
    # measured 0.15 on an actual still at the same setting. The bar is what proves the
    # mode still works, not a tuned constant — it fails outright if the mask stops
    # covering the strokes (0.46 at a 3px growth, where real glyphs stay readable too).
    assert top(surf)[m].mean() < top(scene)[m].mean() * 0.42, 'surface mode left the strokes'
    # Default is screen: an unlabelled box behaves exactly as it always has.
    assert np.array_equal(apply_boxes(scene.copy(), [sbox]), scr), 'default mode is not screen'

    print('selftest ok')
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('src', nargs='?')
    ap.add_argument('dst', nargs='?')
    ap.add_argument('--boxes', help='JSON list of [x0,y0,x1,y1] in pixels')
    ap.add_argument('--modes', help='JSON list of "screen"/"surface", one per box')
    ap.add_argument('--selftest', action='store_true')
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    if not a.src or not a.dst:
        ap.error('src and dst are required')

    # Nothing to do is decided before the image is touched: the caller should not have
    # to have a readable file on hand to be told there is no work.
    boxes = json.loads(a.boxes or '[]')
    modes = json.loads(a.modes or '[]')
    if not boxes:
        print(json.dumps({'ok': True, 'boxes': 0, 'changed': False}))
        return 0

    img = cv2.imread(a.src)
    if img is None:
        print(json.dumps({'ok': False, 'error': 'unreadable source'}))
        return 1

    before = detail(img)
    out = apply_boxes(img, boxes, modes)
    cv2.imwrite(a.dst, out)
    print(json.dumps({
        'ok': True, 'boxes': len(boxes), 'changed': True,
        'surface_boxes': sum(1 for m in modes if m == 'surface'),
        'detail_before': round(before, 1), 'detail_after': round(detail(out), 1),
    }))
    return 0


if __name__ == '__main__':
    sys.exit(main())
