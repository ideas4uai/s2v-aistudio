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


def apply_boxes(img: np.ndarray, boxes: list) -> np.ndarray:
    for b in boxes:
        img = defocus_region(img, tuple(int(v) for v in b))
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

    print('selftest ok')
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('src', nargs='?')
    ap.add_argument('dst', nargs='?')
    ap.add_argument('--boxes', help='JSON list of [x0,y0,x1,y1] in pixels')
    ap.add_argument('--selftest', action='store_true')
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    if not a.src or not a.dst:
        ap.error('src and dst are required')

    # Nothing to do is decided before the image is touched: the caller should not have
    # to have a readable file on hand to be told there is no work.
    boxes = json.loads(a.boxes or '[]')
    if not boxes:
        print(json.dumps({'ok': True, 'boxes': 0, 'changed': False}))
        return 0

    img = cv2.imread(a.src)
    if img is None:
        print(json.dumps({'ok': False, 'error': 'unreadable source'}))
        return 1

    before = detail(img)
    out = apply_boxes(img, boxes)
    cv2.imwrite(a.dst, out)
    print(json.dumps({
        'ok': True, 'boxes': len(boxes), 'changed': True,
        'detail_before': round(before, 1), 'detail_after': round(detail(out), 1),
    }))
    return 0


if __name__ == '__main__':
    sys.exit(main())
