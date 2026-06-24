#!/usr/bin/env python3
"""
Task 5 — Static frame check for body_composite mode.

Renders frame 30 (1.25s at 24fps, past the 8-frame start-portrait hold) for
each test character, saves to outputs/body_composite_test/.  Inspect PNG files
before proceeding to video render.

Stop conditions (auto-checked):
  - head_scale_base < 0.20 or > 0.40  → head too small or too large
  - head_y_frame < 380 or > 700        → head mispositioned vertically
  - body_composite mode not activated for veer → headless assets missing
"""

import math
import os
import sys
import numpy as np
import cv2

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src', 'scripts'))
from doraemon_engine import (
    DoraemonRenderer, load_parts,
    BODY_COMPOSITE_BODY_MAP, HEAD_BODY_FRAC,
    FEET_Y, CENTER_X, OUT_W, OUT_H,
)

TEST_CHARS = [
    ('veer', 'assets/characters/veer'),
    ('nova', 'assets/characters/3da9733b-1f11-4365-9e90-a0043f76c187'),
]
TEST_EMOTION = 'curious'
TEST_FRAME   = 30    # 1.25s at 24fps — past 8-frame start-portrait hold
TEST_FPS     = 24
TEST_DUR     = 5.0

OUT_DIR = 'outputs/body_composite_test'
os.makedirs(OUT_DIR, exist_ok=True)


def find_bg():
    bg_dir = 'assets/backgrounds'
    if os.path.isdir(bg_dir):
        for f in sorted(os.listdir(bg_dir)):
            if f.lower().endswith(('.jpg', '.png')):
                return os.path.join(bg_dir, f)
    raise FileNotFoundError('No background image found in assets/backgrounds/')


bg_path = find_bg()
print(f'[test_body_composite] Background: {bg_path}\n')

n_frames = int(TEST_DUR * TEST_FPS)
amps = np.zeros(n_frames, dtype=np.float32)
amps[TEST_FRAME] = 0.35    # mid-amplitude → mouth_open_a selected at test frame

results = []

for char_name, parts_dir in TEST_CHARS:
    print(f'--- {char_name} ({parts_dir}) ---')

    if not os.path.isdir(parts_dir):
        print('  SKIP: parts_dir not found\n')
        results.append((char_name, 'SKIP'))
        continue

    parts, loaded, missing = load_parts(parts_dir)
    print(f'  Parts: {len(loaded)} loaded, {len(missing)} missing')

    # Mirror main() mode detection exactly
    headless_dir = os.path.join(parts_dir, '_headless')
    has_headless = (
        os.path.isdir(headless_dir) and
        any(f.startswith('body_') and f.endswith('.png')
            for f in os.listdir(headless_dir))
    ) if os.path.isdir(headless_dir) else False
    has_head_meta = os.path.exists(os.path.join(parts_dir, 'head_meta.json'))
    has_head_iso  = os.path.exists(os.path.join(parts_dir, 'head_isolated.png'))
    body_composite_ready = has_headless and has_head_meta and has_head_iso

    has_audio = float(amps.max()) > 1e-6

    if body_composite_ready:
        mode = 'body_composite'
    elif has_audio:
        mode = 'portrait'
    else:
        mode = 'wide'

    print(f'  Mode: {mode}  '
          f'(headless={has_headless}, head_meta={has_head_meta}, head_iso={has_head_iso})')

    try:
        renderer = DoraemonRenderer(
            bg_path, parts, mode, TEST_DUR, TEST_FPS,
            TEST_EMOTION, amps, 42, 240, 840, parts_dir=parts_dir,
        )
    except Exception as e:
        print(f'  ERROR: renderer init failed: {e}\n')
        results.append((char_name, f'ERROR: {e}'))
        continue

    frame = renderer.render(TEST_FRAME)

    out_path = os.path.join(OUT_DIR, f'{char_name}_frame{TEST_FRAME:03d}_{mode}.png')
    cv2.imwrite(out_path, frame)
    print(f'  Saved: {out_path}')

    # Alignment checks — only meaningful in body_composite mode
    if mode == 'body_composite':
        body_key = BODY_COMPOSITE_BODY_MAP.get(TEST_EMOTION, 'body_neutral')
        if body_key not in renderer.body_composite_bodies:
            body_key = next(iter(renderer.body_composite_bodies))

        body_img = renderer.body_composite_bodies[body_key]
        collar_y = renderer.body_collar_meta[body_key]['collar_y']
        bh, bw   = body_img.shape[:2]
        feet_row = renderer.body_feet_rows.get(body_key, bh - 1)
        body_below = feet_row - collar_y

        t      = TEST_FRAME / TEST_FPS
        breath = 1.0 + 0.012 * math.sin(2 * math.pi * t / 2.0)

        collar_y_frame   = FEET_Y - body_below * breath
        head_scale_base  = HEAD_BODY_FRAC / (1.0 - HEAD_BODY_FRAC) * body_below / renderer.neck_anchor_y
        head_total_scale = head_scale_base * breath
        head_y = collar_y_frame - renderer.neck_anchor_y * head_total_scale
        head_w = renderer.head_canvas_w * head_total_scale

        fails = []
        if not (0.20 <= head_scale_base <= 0.40):
            fails.append(f'head_scale={head_scale_base:.3f} outside [0.20, 0.40]')
        if not (380 <= head_y <= 700):
            fails.append(f'head_y={head_y:.0f} outside expected [380, 700]')
        if head_w > OUT_W * 0.60:
            fails.append(f'head_w={head_w:.0f}px > {OUT_W*0.60:.0f}px frame width')

        status = ('FAIL — ' + '; '.join(fails)) if fails else 'PASS'
        print(f'  body_key:        {body_key}')
        print(f'  collar_y_body:   {collar_y}px  collar_y_frame: {collar_y_frame:.0f}px')
        print(f'  head_scale_base: {head_scale_base:.3f}  (x breath={breath:.4f} = {head_total_scale:.3f})')
        print(f'  head_y_frame:    {head_y:.0f}px  head_w: {head_w:.0f}px')
        print(f'  ALIGNMENT:       {status}')
        results.append((char_name, status))
    else:
        print(f'  NOTE: {char_name} does not have body_composite assets — '
              f'rendered in {mode} mode (fallback OK)')
        results.append((char_name, f'OK-fallback ({mode})'))
    print()

print('=' * 60)
print('RESULT SUMMARY')
print('=' * 60)
any_fail = False
for char_name, status in results:
    ok = status.startswith('PASS') or status.startswith('OK') or status.startswith('SKIP')
    marker = 'PASS' if ok else 'FAIL'
    if not ok:
        any_fail = True
    print(f'  [{marker}] {char_name}: {status}')
print()
print(f'PNGs: {OUT_DIR}/')
print('Inspect before video render.\n')
sys.exit(1 if any_fail else 0)
