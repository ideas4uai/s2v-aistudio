"""Burn the SEO agent's thumbnailText onto a captured thumbnail frame.

── Why this imports motion_overlay rather than drawing its own type ───────────
There is already exactly one text renderer in this project: the PIL sprite path in
motion_overlay.py, which the on-screen overlays use and which the burned-in captions
mirror (heavy face, white fill, black stroke). A thumbnail drawn any other way would
be a second typographic voice on the same channel, and ffmpeg's drawtext cannot do
the fitting this needs anyway. So find_font/_sprite/_paste come from there and this
file only adds what is genuinely new: line breaking, a size search, and a scrim.

── Where the type can go ─────────────────────────────────────────────────────
Measured on a real frame rather than assumed. The bottom of a rendered frame is
already spoken for: burned-in captions sit at ~0.78H, the channel watermark bottom-
left at ~0.95H, and the entity attribution credit bottom-right at 0.982H. The top is
the only band that is reliably clear, which is also where thumbnail type belongs —
it survives the corner crop YouTube applies in some surfaces, and it is furthest from
the duration badge YouTube stamps bottom-right.

── Legible at the size people actually see ───────────────────────────────────
A thumbnail is judged at ~168px wide in the suggested-videos rail, not at 1080. That
is a 6.4x downscale, so type set at a "reasonable looking" size on the full frame
turns to mush. Everything here is driven by that: uppercase, a heavy face, a stroke
that survives resampling, and a scrim so the contrast does not depend on whatever the
generated image happened to put behind the words.
"""

import argparse
import os
import sys

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from motion_overlay import find_font, _sprite, _paste  # noqa: E402

# Fractions of frame height/width. The block is top-anchored: type that grows downward
# from a fixed top edge stays put as the line count changes, where centring it would
# make a two-line and a three-line thumbnail sit differently.
TOP_FRAC = 0.055
SIDE_FRAC = 0.06
MAX_LINES = 3
SIZE_CAP_FRAC = 0.082      # of H, per line
SIZE_MIN_FRAC = 0.032
LINE_SPACING = 1.06        # of the line box; tight, because these are 1-3 word lines
BLOCK_MAX_FRAC = 0.32      # of H — never let the type reach the middle of the frame
SCRIM_ALPHA = 0.62
JPEG_QUALITY = 92
# YouTube rejects a thumbnail over 2MB outright, so this is a hard ceiling, not a hint.
MAX_BYTES = 2 * 1024 * 1024


def _measure(text: str, font_path: str, size: int):
    """(width, height) of one line, ink box only."""
    font = ImageFont.truetype(font_path, size)
    probe = ImageDraw.Draw(Image.new('RGBA', (1, 1)))
    x0, y0, x1, y1 = probe.textbbox((0, 0), text, font=font)
    return x1 - x0, y1 - y0


def wrap(text: str, font_path: str, size: int, max_w: int):
    """Greedy word wrap. A single word wider than max_w gets its own line and overflows —
    the size search above is what actually resolves that."""
    words = text.split()
    if not words:
        return []
    lines, current = [], words[0]
    for word in words[1:]:
        candidate = f'{current} {word}'
        if _measure(candidate, font_path, size)[0] <= max_w:
            current = candidate
        else:
            lines.append(current)
            current = word
    lines.append(current)
    return lines


def fit(text: str, font_path: str, max_w: int, cap: int, floor: int, max_h: int):
    """Largest size whose wrap fits the line budget and the block height.

    Steps down rather than binary-searching: the search space is ~30 sizes and each
    probe is a text measurement, so the loop is already imperceptible and this way the
    first size that fits is the one used.
    """
    size = cap
    while size > floor:
        lines = wrap(text, font_path, size, max_w)
        if len(lines) <= MAX_LINES:
            boxes = [_measure(ln, font_path, size) for ln in lines]
            line_h = max(b[1] for b in boxes)
            # Width is checked per line, not just via the wrap: wrap() has to put a word
            # wider than max_w on a line of its own, and that line still overflows. Only
            # a smaller size fixes it, so the widest LINE is the thing that has to fit —
            # testing the line COUNT alone shipped a thumbnail reading "NBREAKABLE",
            # clipped at both frame edges.
            if max(b[0] for b in boxes) <= max_w and len(lines) * line_h * LINE_SPACING <= max_h:
                return size, lines
        size = int(size * 0.94)
    return floor, wrap(text, font_path, floor, max_w)[:MAX_LINES]


def scrim(frame: np.ndarray, bottom: int) -> None:
    """Darken from the top edge down to `bottom`, fading out.

    In place. Without it legibility is a property of whatever the image generator put
    behind the words — fine over the dark server rack this was measured on, useless
    over a bright sky. The gradient is what keeps it from reading as a black bar.
    """
    h, w = frame.shape[:2]
    bottom = max(1, min(h, bottom))
    ramp = np.linspace(SCRIM_ALPHA, 0.0, bottom, dtype=np.float32).reshape(-1, 1, 1)
    band = frame[:bottom, :, :3].astype(np.float32)
    frame[:bottom, :, :3] = (band * (1.0 - ramp)).astype(np.uint8)


def composite(image_path: str, text: str, output_path: str) -> bool:
    img = cv2.imread(image_path, cv2.IMREAD_COLOR)
    if img is None or img.size == 0:
        print(f'[Thumb] Cannot read {image_path}')
        return False
    text = ' '.join((text or '').split()).upper()
    if not text:
        print('[Thumb] No text to draw')
        return False

    font_path = find_font()
    if not font_path:
        print('[Thumb] No usable font found')
        return False

    h, w = img.shape[:2]
    max_w = int(w * (1 - SIDE_FRAC * 2))
    size, lines = fit(text, font_path, max_w,
                      cap=int(h * SIZE_CAP_FRAC), floor=int(h * SIZE_MIN_FRAC),
                      max_h=int(h * BLOCK_MAX_FRAC))
    if not lines:
        return False

    sprites = [_sprite(ln, size, font_path, stroke=max(3, size // 9)) for ln in lines]
    step = int(max(s.shape[0] for s in sprites) * LINE_SPACING)
    top = int(h * TOP_FRAC)

    scrim(img, top + step * len(sprites) + int(h * 0.05))

    canvas = np.dstack([img, np.full(img.shape[:2], 255, np.uint8)])
    for i, sprite in enumerate(sprites):
        _paste(canvas, sprite, (w - sprite.shape[1]) // 2, top + step * i)

    out = canvas[:, :, :3]
    quality = JPEG_QUALITY
    while quality >= 55:
        cv2.imwrite(output_path, out, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
        if os.path.getsize(output_path) <= MAX_BYTES:
            break
        quality -= 12
    print(f'[Thumb] {len(lines)} line(s) at {size}px, '
          f'{os.path.getsize(output_path)} bytes, q{quality}')
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=True)
    ap.add_argument('--text', required=True)
    ap.add_argument('--output', required=True)
    args = ap.parse_args()
    ok = False
    try:
        ok = composite(args.input, args.text, args.output)
    except Exception as exc:                             # pragma: no cover
        print(f'[Thumb] Compositing failed ({exc})')
    # Non-zero only when there is no usable output: the caller falls back to the plain
    # captured frame, which is still a perfectly good thumbnail.
    raise SystemExit(0 if ok and os.path.exists(args.output) else 1)


if __name__ == '__main__':
    main()
