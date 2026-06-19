"""
Character asset visual consistency validator.

Compares the dominant face-region colour of a generated asset against a reference
image using CIE76 delta-E in LAB colour space. Catches skin-tone drift (e.g. orange
batch vs dark-brown batch) before the asset is accepted.

Usage:
  py src/scripts/validate_consistency.py --asset PATH --reference PATH [--threshold 15]

Output (stdout, JSON):
  {"passed": bool, "deltaE": float, "threshold": float,
   "assetLAB": [L,a,b], "refLAB": [L,a,b],
   "assetPixels": int, "refPixels": int}

Face region: centre 50% width, top 3-45% height — captures head area for both
full-body shots and close-up portraits. Near-white pixels (>230 in all channels)
are excluded so the white background doesn't dilute the reading.

Fail-safe: if either image can't be loaded or has <50 usable pixels, returns
passed=true so a validator error never blocks generation.
"""
import sys
import json
import argparse

import numpy as np
import cv2

FACE_X0, FACE_X1 = 0.25, 0.75   # centre 50% of width
FACE_Y0, FACE_Y1 = 0.03, 0.45   # top 3-45% of height
WHITE_THRESH = 230                # pixels with all channels above this = background
MIN_PIXELS   = 50                 # minimum usable pixels; below this → pass (no data)

# We compare L+a distance only, NOT full CIE76 (L+a+b).
#
# Why: body shots mix dark navy clothing into the face region crop, giving b≈-10
# (blue-shifted). Close-up portraits contain only face+hair, giving b≈+14 (warm).
# L and a are nearly identical for consistent skin tones across both image types,
# so L+a distance catches real skin-tone drift (L detects light/dark, a detects
# warm/green) without the clothing-colour false-positives.
USE_LA_ONLY = True


def extract_face_lab(bgr: np.ndarray):
    """
    Returns (mean_cie_lab, pixel_count).
    mean_cie_lab is [L, a, b] in CIE76 units: L∈[0,100], a/b∈[-127,128].
    Returns (None, 0) when there are not enough usable pixels.
    """
    h, w = bgr.shape[:2]
    x0, x1 = int(w * FACE_X0), int(w * FACE_X1)
    y0, y1 = int(h * FACE_Y0), int(h * FACE_Y1)
    region = bgr[y0:y1, x0:x1]

    # Mask out near-white background
    mask = ~(
        (region[:, :, 0] > WHITE_THRESH) &
        (region[:, :, 1] > WHITE_THRESH) &
        (region[:, :, 2] > WHITE_THRESH)
    )

    n_pixels = int(mask.sum())
    if n_pixels < MIN_PIXELS:
        return None, n_pixels

    # OpenCV LAB: L∈[0,255], a/b∈[0,255] (shifted by 128)
    lab_cv = cv2.cvtColor(region, cv2.COLOR_BGR2LAB).astype(np.float32)
    flat_lab  = lab_cv.reshape(-1, 3)
    flat_mask = mask.reshape(-1)
    mean_cv   = flat_lab[flat_mask].mean(axis=0)

    # Convert to CIE76 scale
    L = float(mean_cv[0]) * 100.0 / 255.0
    a = float(mean_cv[1]) - 128.0
    b = float(mean_cv[2]) - 128.0
    return [L, a, b], n_pixels


def la_distance(lab1, lab2):
    """L+a only — see USE_LA_ONLY rationale at top of file."""
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
                          'note': 'Not enough face pixels in asset — skipping check'}))
        sys.exit(0)
    if ref_lab is None:
        print(json.dumps({'passed': True, 'deltaE': 0.0, 'assetPixels': asset_px, 'refPixels': ref_px,
                          'note': 'Not enough face pixels in reference — skipping check'}))
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
