#!/usr/bin/env python3
"""Composite head_isolated.png over solid test backgrounds to verify edge quality."""
from pathlib import Path
import cv2
import numpy as np

TEST_BACKGROUNDS = [
    ('dark',    (20, 25, 30)),    # very dark near-black (BGR: dark warm)
    ('midtone', (55, 75, 100)),   # mid-tone warm brown/rust
]

CHARS = [
    ('veer', Path('assets/characters/veer')),
    ('nova', Path('assets/characters/3da9733b-1f11-4365-9e90-a0043f76c187')),
]

out_dir = Path('outputs/head_composite_test')
out_dir.mkdir(parents=True, exist_ok=True)

for char_name, char_dir in CHARS:
    head_path = char_dir / 'head_isolated.png'
    if not head_path.exists():
        print(f'SKIP {char_name}: {head_path} not found')
        continue

    rgba = cv2.imread(str(head_path), cv2.IMREAD_UNCHANGED)
    if rgba is None or rgba.ndim != 3 or rgba.shape[2] != 4:
        print(f'ERROR {char_name}: could not load RGBA from {head_path}')
        continue

    h, w = rgba.shape[:2]
    bgr_f  = rgba[:, :, :3].astype(np.float32)
    alpha  = rgba[:, :, 3].astype(np.float32) / 255.0

    for bg_name, bg_bgr in TEST_BACKGROUNDS:
        bg = np.full((h, w, 3), bg_bgr, dtype=np.float32)
        comp = bgr_f * alpha[:, :, None] + bg * (1.0 - alpha[:, :, None])
        comp = np.clip(comp, 0, 255).astype(np.uint8)
        out_path = out_dir / f'{char_name}_{bg_name}.png'
        cv2.imwrite(str(out_path), comp)
        print(f'  Saved: {out_path}  ({w}x{h}px)')

print('Done.')
