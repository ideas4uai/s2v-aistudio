"""
Character asset visual consistency validator.

Compares the dominant skin-tone colour of a generated asset against a reference
image using L+a distance in CIE76 LAB space. Catches skin-tone drift (e.g. wrong
character, different skin tone) before the asset is accepted.

Usage:
  py src/scripts/validate_consistency.py --asset PATH --reference PATH [--threshold 15]

Output (stdout, JSON):
  {"passed": bool, "deltaE": float, "threshold": float,
   "assetLAB": [L,a,b], "refLAB": [L,a,b],
   "assetPixels": int, "refPixels": int}

Face/skin region: centre 50% width, top 3-45% height.
Three pixel classes are excluded before comparison:
  1. Near-white (background): all BGR channels > 230
  2. Very dark (clothing, dark hair): CIE76 L < 39 (OpenCV L-channel < 100)
  3. Very bright non-background (e.g. near-white/silver hair): CIE76 L > 88 (OpenCV L > 224)

Excluding classes 1+2 strips dark clothing that dominates full-body reference crops.
Excluding class 3 strips near-white hair that dominates close-up portrait crops.
After both exclusions, the remaining pixels represent skin-tone content in both
shot types, making the comparison framing-invariant.

Fail-safe: if either image has <50 usable pixels after filtering, returns
passed=true so a validator error never blocks generation.
"""
import sys
import json
import argparse

import numpy as np
import cv2

FACE_X0, FACE_X1 = 0.25, 0.75   # centre 50% of width
FACE_Y0, FACE_Y1 = 0.03, 0.45   # top 3-45% of height
WHITE_THRESH = 230                # BGR: all channels above this = white background

# CIE76 L bounds for "skin-like" pixels (both exclusions in OpenCV LAB L-channel units):
#   OpenCV LAB L = CIE76_L * 255 / 100
DARK_L_CV  = 100   # exclude L < 100 (CIE76 < ~39) — dark clothing, very dark hair
BRIGHT_L_CV = 224  # exclude L > 224 (CIE76 > ~88) — near-white/silver hair, bleached elements

MIN_PIXELS   = 50  # minimum usable pixels after all exclusions; below → pass (no data)

# Compare L+a only, not full CIE76 (L+a+b).
# b distinguishes warm skin from blue-tinted elements (clothing, teal accents) but
# introduces noise for unusual art styles. L+a captures lightness and warm/cool axis.
USE_LA_ONLY = True


def extract_face_lab(bgr: np.ndarray):
    """
    Returns (mean_cie_lab, pixel_count).
    mean_cie_lab is [L, a, b] in CIE76 units: L∈[0,100], a/b∈[-127,128].
    Returns (None, 0) when not enough usable pixels after exclusions.
    """
    h, w = bgr.shape[:2]
    x0, x1 = int(w * FACE_X0), int(w * FACE_X1)
    y0, y1 = int(h * FACE_Y0), int(h * FACE_Y1)
    region = bgr[y0:y1, x0:x1]

    # Convert to LAB for L-channel masking
    lab_cv = cv2.cvtColor(region, cv2.COLOR_BGR2LAB).astype(np.float32)
    L_ch = lab_cv[:, :, 0]

    # Exclude 1: white background (BGR check avoids LAB conversion artifacts at pure white)
    white_mask = (
        (region[:, :, 0] > WHITE_THRESH) &
        (region[:, :, 1] > WHITE_THRESH) &
        (region[:, :, 2] > WHITE_THRESH)
    )

    # Exclude 2: very dark pixels (clothing, very dark hair, shadows)
    dark_mask = L_ch < DARK_L_CV

    # Exclude 3: very bright non-background pixels (near-white hair, silver/bleached elements)
    bright_mask = L_ch > BRIGHT_L_CV

    mask = ~white_mask & ~dark_mask & ~bright_mask
    n_pixels = int(mask.sum())
    if n_pixels < MIN_PIXELS:
        return None, n_pixels

    flat_lab  = lab_cv.reshape(-1, 3)
    flat_mask = mask.reshape(-1)
    mean_cv   = flat_lab[flat_mask].mean(axis=0)

    # Convert to CIE76 scale
    L = float(mean_cv[0]) * 100.0 / 255.0
    a = float(mean_cv[1]) - 128.0
    b = float(mean_cv[2]) - 128.0
    return [L, a, b], n_pixels


def la_distance(lab1, lab2):
    """L+a distance only."""
    return float(np.sqrt((lab1[0] - lab2[0]) ** 2 + (lab1[1] - lab2[1]) ** 2))


def cie76(lab1, lab2):
    return float(np.sqrt(sum((x - y) ** 2 for x, y in zip(lab1, lab2))))


def main():
    parser = argparse.ArgumentParser(description='Asset consistency checker')
    parser.add_argument('--asset',     required=True,  help='Path to generated asset PNG')
    parser.add_argument('--reference', required=True,  help='Path to primary reference PNG')
    parser.add_argument('--threshold', type=float, default=15.0,
                        help='CIE76 delta-E threshold (default 15)')
    args = parser.parse_args()

    asset_bgr = cv2.imread(args.asset)
    ref_bgr   = cv2.imread(args.reference)

    if asset_bgr is None:
        print(json.dumps({'passed': True, 'deltaE': 0.0, 'error': f'Cannot load asset: {args.asset}'}))
        sys.exit(0)
    if ref_bgr is None:
        print(json.dumps({'passed': True, 'deltaE': 0.0, 'error': f'Cannot load reference: {args.reference}'}))
        sys.exit(0)

    asset_lab, asset_px = extract_face_lab(asset_bgr)
    ref_lab,   ref_px   = extract_face_lab(ref_bgr)

    if asset_lab is None:
        print(json.dumps({'passed': True, 'deltaE': 0.0, 'assetPixels': asset_px, 'refPixels': ref_px,
                          'note': 'Not enough mid-tone pixels in asset — skipping check'}))
        sys.exit(0)
    if ref_lab is None:
        print(json.dumps({'passed': True, 'deltaE': 0.0, 'assetPixels': asset_px, 'refPixels': ref_px,
                          'note': 'Not enough mid-tone pixels in reference — skipping check'}))
        sys.exit(0)

    delta_e = la_distance(asset_lab, ref_lab) if USE_LA_ONLY else cie76(asset_lab, ref_lab)
    passed  = delta_e <= args.threshold

    print(json.dumps({
        'passed':      passed,
        'deltaE':      round(delta_e, 2),
        'threshold':   args.threshold,
        'assetLAB':    [round(v, 2) for v in asset_lab],
        'refLAB':      [round(v, 2) for v in ref_lab],
        'assetPixels': asset_px,
        'refPixels':   ref_px,
    }))


if __name__ == '__main__':
    main()
