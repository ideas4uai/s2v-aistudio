#!/usr/bin/env python3
"""
Phase 2 (rembg path): Extract head layer using neural background removal.

For characters with color-ambiguous hair (e.g. Nova's silver/white hair
against a white source background), the color-threshold approach in
extract_head_layer.py cannot cleanly separate hair from background.
This script uses rembg's semantic segmentation instead — no color
thresholds, no white-fringe / dark-blotch tradeoff.

Post-processing is identical to extract_head_layer.py:
  - largest_component: removes floating art elements (Nova's notepad icon)
  - head crop: top HEAD_FRAC of character height
  - feather_alpha: 1px erode + 21x21 Gaussian
  - neck_fade: linear ramp 255->0 over NECK_FADE_PX rows at bottom

Usage:
  py scripts/extract_head_rembg.py --char_dir assets/characters/3da9733b-...

Output (both in --char_dir):
  head_isolated.png  — RGBA, transparent bg, feathered edges, neck fade
  head_meta.json     — canvas size + neck_anchor_y for Phase 3 positioning
"""

import sys
import json
import argparse
from pathlib import Path

import cv2
import numpy as np
from rembg import remove

NECK_FADE_PX = 35
HEAD_FRAC    = 0.75
PAD_TOP      = 25
PAD_SIDE     = 15


def largest_component(binary_mask: np.ndarray) -> np.ndarray:
    n, labels, stats, _ = cv2.connectedComponentsWithStats(
        binary_mask.astype(np.uint8), connectivity=8
    )
    if n <= 1:
        return binary_mask
    areas = stats[1:, cv2.CC_STAT_AREA]
    largest_label = int(np.argmax(areas)) + 1
    return ((labels == largest_label) * 255).astype(np.uint8)


def extract_head_rembg(char_dir: Path) -> dict:
    input_path = char_dir / 'mouth_closed.png'
    if not input_path.exists():
        raise FileNotFoundError(f'mouth_closed.png not found in {char_dir}')

    print(f'  Input  : {input_path}')
    raw_bytes = input_path.read_bytes()

    # ── 1. Neural background removal (rembg) ─────────────────────────────────
    print('  Running rembg...')
    rgba_bytes = remove(raw_bytes)
    buf = np.frombuffer(rgba_bytes, dtype=np.uint8)
    rgba_full = cv2.imdecode(buf, cv2.IMREAD_UNCHANGED)
    if rgba_full is None or rgba_full.shape[2] != 4:
        raise RuntimeError('rembg did not return a 4-channel image')

    h, w = rgba_full.shape[:2]
    print(f'  Size   : {w}x{h}px  alpha range: {rgba_full[:,:,3].min()}-{rgba_full[:,:,3].max()}')

    bgr_full  = rgba_full[:, :, :3]
    alpha_raw = rgba_full[:, :, 3]

    # ── 2. Binarise alpha + keep largest component ────────────────────────────
    char_mask = (alpha_raw > 30).astype(np.uint8) * 255
    close_k   = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    char_mask = cv2.morphologyEx(char_mask, cv2.MORPH_CLOSE, close_k)
    char_mask = largest_component(char_mask)

    # ── 3. Character bounding box ─────────────────────────────────────────────
    ys, xs = np.where(char_mask > 0)
    if not len(ys):
        raise RuntimeError('No character pixels found after rembg')

    cx0, cx1 = int(xs.min()), int(xs.max())
    cy0, cy1 = int(ys.min()), int(ys.max())
    char_h = cy1 - cy0
    char_w = cx1 - cx0
    print(f'  Char bbox : ({cx0},{cy0}) ->({cx1},{cy1})  {char_w}x{char_h}px')

    # ── 4. Head crop region ───────────────────────────────────────────────────
    head_y1 = cy0 + int(char_h * HEAD_FRAC)

    out_x0 = max(0, cx0 - PAD_SIDE)
    out_x1 = min(w, cx1 + PAD_SIDE)
    out_y0 = max(0, cy0 - PAD_TOP)
    out_y1 = min(h, head_y1)

    crop_bgr  = bgr_full  [out_y0:out_y1, out_x0:out_x1]
    crop_mask = char_mask [out_y0:out_y1, out_x0:out_x1]

    cw, ch = crop_bgr.shape[1], crop_bgr.shape[0]
    print(f'  Head crop : ({out_x0},{out_y0}) ->({out_x1},{out_y1})  {cw}x{ch}px')

    # ── 5. Feather alpha ──────────────────────────────────────────────────────
    eroded = cv2.erode(crop_mask, np.ones((3, 3), np.uint8), iterations=1)
    alpha_f = cv2.GaussianBlur(eroded, (21, 21), 0)

    rgba = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2BGRA)
    rgba[:, :, 3] = alpha_f

    # ── 6. Bottom neck fade ───────────────────────────────────────────────────
    fade_rows  = min(NECK_FADE_PX, ch)
    fade_start = ch - fade_rows
    ramp = np.linspace(1.0, 0.0, fade_rows, dtype=np.float32)
    alpha_col = rgba[:, :, 3].astype(np.float32)
    for i, factor in enumerate(ramp):
        alpha_col[fade_start + i, :] *= factor
    rgba[:, :, 3] = np.clip(alpha_col, 0, 255).astype(np.uint8)

    # ── 7. Save PNG ───────────────────────────────────────────────────────────
    out_path = char_dir / 'head_isolated.png'
    cv2.imwrite(str(out_path), rgba)
    kb = out_path.stat().st_size // 1024
    print(f'  Output : {out_path.name}  {cw}x{ch}px  {kb}KB')
    print(f'  Neck fade starts at y={fade_start} (of {ch} rows)')

    # ── 8. JSON metadata for Phase 3 ─────────────────────────────────────────
    meta = {
        'source_file':      str(input_path),
        'extraction_method': 'rembg',
        'canvas_wh':        [cw, ch],
        'char_bbox_orig':   [cx0, cy0, cx1, cy1],
        'crop_rect_orig':   [out_x0, out_y0, out_x1, out_y1],
        'neck_anchor_y':    fade_start,
        'face_center_y':    int(ch * 0.35),
        'neck_fade_px':     NECK_FADE_PX,
        'head_frac_used':   HEAD_FRAC,
    }
    meta_path = char_dir / 'head_meta.json'
    meta_path.write_text(json.dumps(meta, indent=2))
    print(f'  Metadata : neck_anchor_y={meta["neck_anchor_y"]}  face_center_y={meta["face_center_y"]}')
    return meta


def main() -> None:
    parser = argparse.ArgumentParser(description='Extract head layer using rembg neural background removal')
    parser.add_argument('--char_dir', required=True,
                        help='Character asset directory (contains mouth_closed.png)')
    args = parser.parse_args()

    char_dir = Path(args.char_dir)
    if not char_dir.is_dir():
        print(f'ERROR: Not a directory: {char_dir}', file=sys.stderr)
        sys.exit(1)

    print(f'\n[extract_head_rembg] {char_dir.name}')
    extract_head_rembg(char_dir)
    print(f'\n  Done — head_isolated.png and head_meta.json written to {char_dir}\n')


if __name__ == '__main__':
    main()
