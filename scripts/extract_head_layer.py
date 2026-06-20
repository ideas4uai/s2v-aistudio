#!/usr/bin/env python3
"""
Phase 2: Extract head layer from an existing approved portrait asset.

Takes mouth_closed.png (white-background portrait PNG), extracts the
head+neck region via white-background subtraction, keeps only the largest
connected component (removes floating art elements like Nova's notepad icon),
applies the same feather_alpha used in metro_engine_v4.py, adds a bottom-edge
neck-fade gradient so the head composites cleanly onto the headless body layer.

Usage:
  py scripts/extract_head_layer.py --char_dir assets/characters/veer
  py scripts/extract_head_layer.py --char_dir assets/characters/3da9733b-1f11-4365-9e90-a0043f76c187

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


# ── Tuning constants ─────────────────────────────────────────────────────────
WHITE_THRESH   = 240    # all BGR channels above this ->background pixel
NECK_FADE_PX   = 35     # vertical span of bottom alpha fade (portrait px)
HEAD_FRAC      = 0.75   # keep top 75% of character bbox height (head+neck+collar stub)
PAD_TOP        = 25     # extra transparent rows above hairline
PAD_SIDE       = 15     # extra transparent cols left/right of character


def feather_alpha(alpha: np.ndarray) -> np.ndarray:
    """
    Identical to metro_engine_v4.feather_alpha:
    1px erode to kill white fringe, then 21x21 Gaussian to soften silhouette.
    """
    eroded = cv2.erode(alpha, np.ones((3, 3), np.uint8), iterations=1)
    return cv2.GaussianBlur(eroded, (21, 21), 0)


def largest_component(binary_mask: np.ndarray) -> np.ndarray:
    """
    Return mask of the single largest connected component.
    Removes small floating elements (e.g. Nova's notepad icon).
    """
    n, labels, stats, _ = cv2.connectedComponentsWithStats(
        binary_mask.astype(np.uint8), connectivity=8
    )
    if n <= 1:
        return binary_mask
    # Skip label 0 (background), find the rest by area
    areas = stats[1:, cv2.CC_STAT_AREA]
    largest_label = int(np.argmax(areas)) + 1
    return ((labels == largest_label) * 255).astype(np.uint8)


def extract_head(char_dir: Path) -> dict:
    input_path = char_dir / 'mouth_closed.png'
    if not input_path.exists():
        raise FileNotFoundError(f'mouth_closed.png not found in {char_dir}')

    bgr = cv2.imread(str(input_path))
    if bgr is None:
        raise RuntimeError(f'cv2 could not load {input_path}')

    h, w = bgr.shape[:2]
    print(f'  Input  : {input_path}')
    print(f'  Size   : {w}×{h}px')

    # ── 1. Background subtraction ─────────────────────────────────────────────
    # White/near-white pixels are background; everything else is the character.
    bg_mask   = np.all(bgr > WHITE_THRESH, axis=2).astype(np.uint8) * 255
    char_mask = cv2.bitwise_not(bg_mask)

    # Morphological close: fill small gaps inside the silhouette (e.g. between
    # hair strands), then keep only the largest blob to drop floating elements.
    close_k   = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    char_mask = cv2.morphologyEx(char_mask, cv2.MORPH_CLOSE, close_k)
    char_mask = largest_component(char_mask)

    # ── 2. Character bounding box ─────────────────────────────────────────────
    ys, xs = np.where(char_mask > 0)
    if not len(ys):
        raise RuntimeError('No character pixels found — check WHITE_THRESH')

    cx0, cx1 = int(xs.min()), int(xs.max())
    cy0, cy1 = int(ys.min()), int(ys.max())
    char_h = cy1 - cy0
    char_w = cx1 - cx0
    print(f'  Char bbox : ({cx0},{cy0}) ->({cx1},{cy1})  {char_w}×{char_h}px')

    # ── 3. Head crop region ───────────────────────────────────────────────────
    # Take the top HEAD_FRAC of the character's height: catches hair + face +
    # neck + a short collar stub; fades the rest away in step 6.
    head_y1 = cy0 + int(char_h * HEAD_FRAC)

    # Add padding: breathing room for hair wisps above and sides
    out_x0 = max(0,  cx0 - PAD_SIDE)
    out_x1 = min(w,  cx1 + PAD_SIDE)
    out_y0 = max(0,  cy0 - PAD_TOP)
    out_y1 = min(h,  head_y1)

    crop_bgr  = bgr      [out_y0:out_y1, out_x0:out_x1]
    crop_mask = char_mask[out_y0:out_y1, out_x0:out_x1]

    cw, ch = crop_bgr.shape[1], crop_bgr.shape[0]
    print(f'  Head crop : ({out_x0},{out_y0}) ->({out_x1},{out_y1})  {cw}×{ch}px')

    # ── 4. Build RGBA ─────────────────────────────────────────────────────────
    rgba = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2BGRA)
    rgba[:, :, 3] = crop_mask

    # ── 5. Feather alpha edges (mirrors metro_engine_v4.feather_alpha exactly) ─
    rgba[:, :, 3] = feather_alpha(rgba[:, :, 3])

    # ── 6. Bottom neck fade ───────────────────────────────────────────────────
    # Ramp alpha 255→0 over the last NECK_FADE_PX rows so the head composites
    # smoothly into the body layer's collar region rather than cutting off hard.
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

    print(f'  Output : {out_path.name}  {cw}×{ch}px  {kb}KB')
    print(f'  Neck fade starts at y={fade_start} (of {ch} rows)')

    # ── 8. JSON metadata for Phase 3 ─────────────────────────────────────────
    meta = {
        'source_file':   str(input_path),
        'canvas_wh':     [cw, ch],
        # char bbox in original portrait coordinate space
        'char_bbox_orig':   [cx0, cy0, cx1, cy1],
        # the crop we actually took (= head_isolated.png frame in portrait coords)
        'crop_rect_orig':   [out_x0, out_y0, out_x1, out_y1],
        # Within head_isolated.png: y where neck fade begins (= effective bottom of opaque head)
        'neck_anchor_y':    fade_start,
        # Within head_isolated.png: y of the center of the face (estimated as 35% down)
        'face_center_y':    int(ch * 0.35),
        'neck_fade_px':     NECK_FADE_PX,
        'head_frac_used':   HEAD_FRAC,
    }
    meta_path = char_dir / 'head_meta.json'
    meta_path.write_text(json.dumps(meta, indent=2))
    print(f'  Metadata : neck_anchor_y={meta["neck_anchor_y"]}  face_center_y={meta["face_center_y"]}')
    return meta


def main() -> None:
    parser = argparse.ArgumentParser(description='Extract head layer from portrait asset')
    parser.add_argument('--char_dir', required=True,
                        help='Character asset directory (contains mouth_closed.png)')
    args = parser.parse_args()

    char_dir = Path(args.char_dir)
    if not char_dir.is_dir():
        print(f'ERROR: Not a directory: {char_dir}', file=sys.stderr)
        sys.exit(1)

    print(f'\n[extract_head_layer] {char_dir.name}')
    meta = extract_head(char_dir)
    print(f'\n  Done — head_isolated.png and head_meta.json written to {char_dir}\n')


if __name__ == '__main__':
    main()
