"""Compose a thumbnail as a designed layout, not a frame with words on it.

── What was wrong with the old one ───────────────────────────────────────────
It grabbed frame 1.5s out of the finished mp4 and drew the headline across the
top. Three things made that read as a screenshot: the base was h.264 output
(~185KB, compression artefacts, whatever the video happened to be showing), it
still carried the burned-in caption from that moment, and the type floated over
arbitrary picture content because there was nowhere in the frame it was meant to
go.

── What this does instead ───────────────────────────────────────────────────
The base is one of the episode's own generated scene images — original art at
~1.2MB rather than a compressed frame, with no caption burned into it, chosen
for how well it carries a thumbnail rather than sampled at an arbitrary second.

Then the frame is built rather than overlaid: the picture takes the upper zone,
cropped to its most interesting region, and the type sits in a colour block
below it that is filled from the picture's own dominant hue. Type on a field
made for type, image where the image belongs. That structure is what a thumbnail
in this niche actually looks like, and it is the part that cannot be fixed by
improving the base image alone.

The channel watermark has to be drawn here. The old thumbnail inherited it for
free because the frame came from an already-watermarked video; a scene image has
never been near the renderer, so an unbranded thumbnail is the failure mode.
"""

import argparse
import os
import sys

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from motion_overlay import find_font, _sprite, _paste  # noqa: E402

# The picture's share of the height. Just over half: enough for the art to be the
# first thing seen, leaving a block deep enough for three lines of real display type.
IMAGE_FRAC = 0.54
SIDE_FRAC = 0.055
MAX_LINES = 3
HEAD_CAP_FRAC = 0.088          # of full height, per line
HEAD_MIN_FRAC = 0.034
LINE_SPACING = 1.02
KICKER_FRAC = 0.023
# The seam between picture and block, as a fraction of height. A slight rake stops the
# join reading as two stacked rectangles.
RAKE_FRAC = 0.022
LOGO_FRAC = 0.085
JPEG_QUALITY = 92
MAX_BYTES = 2 * 1024 * 1024


# ── choosing and preparing the picture ────────────────────────────────────────

def strip_letterbox(img: np.ndarray, thresh: int = 18) -> np.ndarray:
    """Drop the black bars a 16:9 render leaves on a generated still.

    Cropping to a subject with the bars still attached pulls dead black into the
    frame and drags the dominant-colour reading toward neutral.
    """
    grey = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    rows = np.where(grey.mean(axis=1) > thresh)[0]
    cols = np.where(grey.mean(axis=0) > thresh)[0]
    if rows.size < 8 or cols.size < 8:
        return img
    return img[rows[0]:rows[-1] + 1, cols[0]:cols[-1] + 1]


def interest(patch: np.ndarray) -> float:
    """How much a region earns its place in a thumbnail.

    Detail plus colour: edge energy finds the subject, saturation keeps it from
    settling on a busy but grey corner, and mid-tone brightness avoids crops that are
    all highlight or all shadow.
    """
    if patch.size == 0:
        return 0.0
    small = cv2.resize(patch, (160, 160), interpolation=cv2.INTER_AREA)
    grey = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    edges = float(np.abs(cv2.Laplacian(grey, cv2.CV_32F)).mean())
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
    sat = float(hsv[:, :, 1].mean())
    lum = float(grey.mean())
    tone = 1.0 - abs(lum - 128.0) / 128.0
    return edges * 2.2 + sat * 0.9 + tone * 26.0


def subject_crop(img: np.ndarray, aspect: float) -> np.ndarray:
    """The window of `img` at `aspect` that scores highest.

    A centre crop is the obvious alternative and it is wrong often enough to matter —
    generated stills put the subject off-centre all the time, and the whole point of
    this zone is that the subject is in it.
    """
    h, w = img.shape[:2]
    if h == 0 or w == 0:
        return img
    cw, ch = (int(h * aspect), h) if w / h > aspect else (w, int(w / aspect))
    cw, ch = max(1, min(w, cw)), max(1, min(h, ch))
    best, best_score = (0, 0), -1.0
    # 9 positions per axis is plenty: the score surface is smooth, and this is one
    # resize per candidate at build time.
    for x in np.linspace(0, w - cw, 9 if w > cw else 1).astype(int):
        for y in np.linspace(0, h - ch, 9 if h > ch else 1).astype(int):
            s = interest(img[y:y + ch, x:x + cw])
            if s > best_score:
                best, best_score = (int(x), int(y)), s
    x, y = best
    return img[y:y + ch, x:x + cw]


def accent_from(img: np.ndarray) -> tuple:
    """A saturated colour the picture already contains, as BGR.

    Taken from the picture rather than from a fixed brand palette so the block reads
    as part of the composition. The most common hue among confidently coloured pixels,
    then pushed to a strength that can carry display type.
    """
    small = cv2.resize(img, (120, 120), interpolation=cv2.INTER_AREA)
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    strong = (s > 70) & (v > 60)
    if strong.sum() < 80:
        return (150, 60, 30)                       # deep blue when the art is greyscale
    hue = int(np.bincount(h[strong].ravel(), minlength=180).argmax())
    patch = np.uint8([[[hue, 210, 165]]])
    b, g, r = cv2.cvtColor(patch, cv2.COLOR_HSV2BGR)[0][0]
    return (int(b), int(g), int(r))


def ink_for(bgr: tuple) -> tuple:
    """Near-white or near-black, whichever survives on this block."""
    b, g, r = bgr
    lum = 0.114 * b + 0.587 * g + 0.299 * r
    return (18, 16, 16) if lum > 150 else (250, 250, 252)


# ── type ──────────────────────────────────────────────────────────────────────

def _measure(text: str, font_path: str, size: int):
    font = ImageFont.truetype(font_path, size)
    probe = ImageDraw.Draw(Image.new('RGBA', (1, 1)))
    x0, y0, x1, y1 = probe.textbbox((0, 0), text, font=font)
    return x1 - x0, y1 - y0


def wrap(text: str, font_path: str, size: int, max_w: int):
    words = text.split()
    if not words:
        return []
    lines, cur = [], words[0]
    for w in words[1:]:
        if _measure(f'{cur} {w}', font_path, size)[0] <= max_w:
            cur = f'{cur} {w}'
        else:
            lines.append(cur)
            cur = w
    lines.append(cur)
    return lines


def fit(text: str, font_path: str, max_w: int, cap: int, floor: int, max_h: int):
    """Largest size whose wrap fits the line budget, the block, AND the frame width.

    The width test is per LINE, not per line count: wrap() has to put a word wider than
    max_w on a line of its own and that line still overflows, which is how an earlier
    version of this shipped a headline clipped at both edges.
    """
    # A project whose SEO agent has not run yet has no headline at all. The layout is
    # still worth having — picture, kicker, watermark — so this returns nothing to draw
    # rather than raising, which is what an unguarded max() over zero lines did.
    if not text.strip():
        return floor, []
    size = cap
    while size > floor:
        lines = wrap(text, font_path, size, max_w)
        if len(lines) <= MAX_LINES:
            boxes = [_measure(ln, font_path, size) for ln in lines]
            if (max(b[0] for b in boxes) <= max_w
                    and len(lines) * max(b[1] for b in boxes) * LINE_SPACING <= max_h):
                return size, lines
        size = int(size * 0.94)
    return floor, wrap(text, font_path, floor, max_w)[:MAX_LINES]


def letterspaced(text: str, size: int, font_path: str, fill, tracking: int):
    """A kicker sprite with real tracking — PIL will not letterspace a string."""
    parts = [_sprite(c, size, font_path, fill=fill, stroke=0) for c in text]
    if not parts:
        return None
    h = max(p.shape[0] for p in parts)
    w = sum(p.shape[1] for p in parts) + tracking * (len(parts) - 1)
    strip = np.zeros((h, max(1, w), 4), np.uint8)
    x = 0
    for p in parts:
        _paste(strip, p, x, (h - p.shape[0]) // 2)
        x += p.shape[1] + tracking
    return strip


# ── the layout ────────────────────────────────────────────────────────────────

def best_of(paths):
    """The candidate scene image that carries a thumbnail best.

    Scored rather than "take the first": the opening shot is often an establishing wide,
    and the striking frame — the one worth putting in a feed — is usually a beat or two
    in. Cheap enough to score every image the episode produced, and deterministic, so
    the same episode always yields the same thumbnail.
    """
    best, best_score = None, -1.0
    for p in paths:
        img = cv2.imread(p, cv2.IMREAD_COLOR)
        if img is None or img.size == 0:
            continue
        s = interest(strip_letterbox(img))
        if s > best_score:
            best, best_score = img, s
    return best


def compose(image_paths, text, output, kicker='', logo_path='', width=1080, height=1920):
    src = best_of(image_paths if isinstance(image_paths, (list, tuple)) else [image_paths])
    if src is None or src.size == 0:
        print(f'[Thumb] No readable image among {len(image_paths)} candidate(s)')
        return False
    font_path = find_font()
    if not font_path:
        print('[Thumb] No usable font found')
        return False

    text = ' '.join((text or '').split()).upper()
    src = strip_letterbox(src)

    img_h = int(height * IMAGE_FRAC)
    picture = subject_crop(src, width / img_h)
    picture = cv2.resize(picture, (width, img_h), interpolation=cv2.INTER_AREA)

    accent = accent_from(picture)
    ink = ink_for(accent)

    canvas = np.zeros((height, width, 3), np.uint8)
    canvas[:, :] = accent
    canvas[:img_h] = picture

    # Rake the seam, and lay a hairline of ink along it so the two zones read as one
    # composition rather than a picture that happens to sit above a rectangle.
    rake = int(height * RAKE_FRAC)
    for x in range(width):
        cut = img_h - int(rake * (x / max(1, width - 1)))
        canvas[cut:img_h, x] = accent
        canvas[max(0, cut - 5):cut, x] = ink

    # A short, shallow sink toward the block. Deeper than this and the bottom of the
    # picture turns to a muddy wash of the accent instead of reading as picture.
    fade = int(img_h * 0.07)
    if fade > 4:
        ramp = np.linspace(0.0, 0.34, fade, dtype=np.float32).reshape(-1, 1, 1)
        top = img_h - rake - fade
        band = canvas[top:top + fade].astype(np.float32)
        canvas[top:top + fade] = (band * (1 - ramp) + np.float32(accent) * ramp).astype(np.uint8)

    canvas = np.dstack([canvas, np.full((height, width), 255, np.uint8)])

    pad = int(width * SIDE_FRAC)
    max_w = width - pad * 2
    block_top = img_h + int(height * 0.028)
    block_h = height - block_top - int(height * 0.10)

    ks = None
    kick_gap = 0
    if kicker:
        ks = letterspaced(kicker.upper()[:28], int(height * KICKER_FRAC), font_path, ink,
                          int(height * KICKER_FRAC * 0.22))
        if ks is not None:
            kick_gap = int(ks.shape[0] * 2.3)

    size, lines = fit(text, font_path, max_w,
                      cap=int(height * HEAD_CAP_FRAC), floor=int(height * HEAD_MIN_FRAC),
                      max_h=block_h - kick_gap)
    # No stroke: the block was chosen to contrast with the ink, so an outline here would
    # be decoration. The old overlay needed one because it sat on unknown picture.
    sprites = [_sprite(ln, size, font_path, fill=ink, stroke=0) for ln in lines]
    step = int(max(s.shape[0] for s in sprites) * LINE_SPACING) if sprites else 0

    # Centre kicker and headline together in the block rather than hanging them from its
    # top edge. Anchored to the top, a two-line headline left a third of the block empty
    # above the watermark and the whole panel read as unfinished.
    group_h = kick_gap + step * max(0, len(sprites) - 1) + (sprites[0].shape[0] if sprites else 0)
    y = block_top + max(0, (block_h - group_h) // 2)

    if ks is not None:
        _paste(canvas, ks, pad, y)
        y += kick_gap
    for i, sp in enumerate(sprites):
        _paste(canvas, sp, pad, y + step * i)

    if logo_path and os.path.exists(logo_path):
        logo = cv2.imread(logo_path, cv2.IMREAD_UNCHANGED)
        if logo is not None and logo.size:
            if logo.ndim == 2:
                logo = cv2.cvtColor(logo, cv2.COLOR_GRAY2BGR)
            if logo.shape[2] == 3:
                logo = np.dstack([logo, np.full(logo.shape[:2], 255, np.uint8)])
            lh = int(height * LOGO_FRAC)
            k = lh / max(1, logo.shape[0])
            logo = cv2.resize(logo, (max(1, int(logo.shape[1] * k)), lh), interpolation=cv2.INTER_AREA)
            _paste(canvas, logo, width - pad - logo.shape[1], height - pad - logo.shape[0])

    out = canvas[:, :, :3]
    q = JPEG_QUALITY
    while q >= 55:
        cv2.imwrite(output, out, [int(cv2.IMWRITE_JPEG_QUALITY), q])
        if os.path.getsize(output) <= MAX_BYTES:
            break
        q -= 12
    print(f'[Thumb] composed {len(lines)} line(s) @{size}px, accent bgr{accent}, '
          f'{os.path.getsize(output)} bytes, q{q}')
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=True, nargs='+')
    ap.add_argument('--text', required=True)
    ap.add_argument('--output', required=True)
    ap.add_argument('--kicker', default='')
    ap.add_argument('--logo', default='')
    ap.add_argument('--width', type=int, default=1080)
    ap.add_argument('--height', type=int, default=1920)
    args = ap.parse_args()
    ok = False
    try:
        ok = compose(args.input, args.text, args.output, args.kicker, args.logo,
                     args.width, args.height)
    except Exception as exc:                             # pragma: no cover
        print(f'[Thumb] Compose failed ({exc})')
    raise SystemExit(0 if ok and os.path.exists(args.output) else 1)


if __name__ == '__main__':
    main()
