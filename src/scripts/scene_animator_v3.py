"""
scene_animator_v3.py
====================
CLI wrapper for metro_engine_v3.
Called by renderService.ts instead of animator.py
when scene has background_path + transparent_path.

Usage:
  py scene_animator_v3.py \
    --background path/to/bg.png \
    --character  path/to/transparent.png \
    --output     path/to/output.mp4 \
    --duration   18.5 \
    --emotion    neutral \
    --scene_type street \
    --camera     ken_burns_in \
    --fps        24 \
    --width      1080 \
    --height     1920
"""

import argparse
import sys
import os
import cv2
import numpy as np
import time

# Add parent scripts dir to path
sys.path.insert(0, os.path.dirname(__file__))
from metro_engine_v3 import (
    EngineConfig, SceneConfig, ZoomPunch,
    render_scene_to_frames
)

# ── Scene type → particle mode mapping ──────────────────
PARTICLE_MAP = {
    'bedroom':   'dust',
    'street':    'dust',
    'grid':      'data_stream',
    'corridor':  'dust',
    'black':     'static_noise',
    'default':   'dust',
}

# ── Scene type → transition mapping ─────────────────────
TRANSITION_MAP = {
    'bedroom':   'crossfade',
    'street':    'iris_wipe',
    'grid':      'fade_black',
    'corridor':  'crossfade',
    'black':     'fade_black',
    'default':   'crossfade',
}

# ── Camera move defaults per scene type ─────────────────
CAMERA_MAP = {
    'bedroom':   'ken_burns_in',
    'street':    'pan_right',
    'grid':      'ken_burns_out',
    'corridor':  'pan_right',
    'black':     'static',
    'default':   'ken_burns_in',
}

# ── Wind defaults per scene type ────────────────────────
WIND_MAP = {
    'bedroom':   0.0,
    'street':   -5.0,
    'grid':      0.0,
    'corridor':  0.0,
    'black':     0.0,
    'default':   0.0,
}


def composite_character(frame: np.ndarray,
                        char_rgba: np.ndarray,
                        cfg: EngineConfig) -> np.ndarray:
    """
    Alpha-composite a transparent character PNG
    over the animated background frame.

    Character is scaled to 68% of frame height,
    horizontally centred, feet at 92% of frame height.
    """
    if char_rgba is None or char_rgba.shape[2] != 4:
        return frame

    target_h = int(cfg.h * 0.68)
    scale = target_h / char_rgba.shape[0]
    target_w = int(char_rgba.shape[1] * scale)

    char_resized = cv2.resize(
        char_rgba, (target_w, target_h),
        interpolation=cv2.INTER_LANCZOS4
    )

    # Position: centred horizontally, feet at 92%
    x = (cfg.w - target_w) // 2
    y = int(cfg.h * 0.92) - target_h
    y = max(0, y)

    # Clip to frame bounds
    y2 = min(y + target_h, cfg.h)
    x2 = min(x + target_w, cfg.w)
    ch = y2 - y
    cw = x2 - x

    if ch <= 0 or cw <= 0:
        return frame

    # Extract alpha and RGB
    alpha = char_resized[:ch, :cw, 3:4].astype(
        np.float32) / 255.0
    rgb = char_resized[:ch, :cw, :3].astype(
        np.float32)

    # Drop shadow — blur the alpha, offset down-right
    shadow_alpha = cv2.GaussianBlur(
        char_resized[:ch, :cw, 3], (35, 35), 0
    ).astype(np.float32) / 255.0
    shadow_offset_x = 8
    shadow_offset_y = 12
    shadow_darkness = 0.30

    # Apply shadow first (below character)
    sy1 = min(y + shadow_offset_y, cfg.h)
    sy2 = min(sy1 + ch, cfg.h)
    sx1 = min(x + shadow_offset_x, cfg.w)
    sx2 = min(sx1 + cw, cfg.w)
    sch = sy2 - sy1
    scw = sx2 - sx1

    if sch > 0 and scw > 0:
        s_roi = frame[sy1:sy2, sx1:sx2].astype(
            np.float32)
        s_alpha = shadow_alpha[:sch, :scw, np.newaxis]
        frame[sy1:sy2, sx1:sx2] = np.clip(
            s_roi * (1 - s_alpha * shadow_darkness),
            0, 255
        ).astype(np.uint8)

    # Composite character over background
    roi = frame[y:y2, x:x2].astype(np.float32)
    frame[y:y2, x:x2] = np.clip(
        rgb * alpha + roi * (1 - alpha),
        0, 255
    ).astype(np.uint8)

    return frame


def main():
    parser = argparse.ArgumentParser(
        description='Scene animator v3 — Metro engine CLI'
    )
    parser.add_argument('--background', required=True,
        help='Path to background PNG')
    parser.add_argument('--character', default='',
        help='Path to transparent character PNG (optional)')
    parser.add_argument('--output', required=True,
        help='Output MP4 path')
    parser.add_argument('--duration', type=float,
        required=True, help='Scene duration in seconds')
    parser.add_argument('--emotion', default='neutral',
        choices=['neutral','tense','curious',
                 'sad','empty','warm'],
        help='Emotional color grade')
    parser.add_argument('--scene_type', default='street',
        choices=['bedroom','street','grid',
                 'corridor','black','default'],
        help='Scene type drives particles + transition')
    parser.add_argument('--camera', default='',
        help='Camera move override (optional)')
    parser.add_argument('--fps', type=int, default=24)
    parser.add_argument('--width', type=int, default=1080)
    parser.add_argument('--height', type=int, default=1920)

    args = parser.parse_args()

    # Validate inputs
    if not os.path.exists(args.background):
        print(f'[SceneAnimator] ERROR: background not '
              f'found: {args.background}', file=sys.stderr)
        sys.exit(1)

    if args.duration <= 0:
        print(f'[SceneAnimator] ERROR: duration must '
              f'be > 0', file=sys.stderr)
        sys.exit(1)

    t0 = time.time()
    print(f'[SceneAnimator] Starting v3 render')
    print(f'[SceneAnimator] Background: '
          f'{os.path.basename(args.background)}')
    print(f'[SceneAnimator] Character: '
          f'{os.path.basename(args.character) if args.character else "none"}')
    print(f'[SceneAnimator] Duration: {args.duration}s')
    print(f'[SceneAnimator] Emotion: {args.emotion}')
    print(f'[SceneAnimator] Scene type: {args.scene_type}')

    # Build engine config
    cfg = EngineConfig(
        w=args.width,
        h=args.height,
        fps=args.fps
    )

    # Resolve camera move
    camera = args.camera if args.camera else \
        CAMERA_MAP.get(args.scene_type,
                       CAMERA_MAP['default'])

    # Build scene config
    scene = SceneConfig(
        background_path=args.background,
        duration_sec=args.duration,
        emotion=args.emotion,
        particle_mode=PARTICLE_MAP.get(
            args.scene_type, 'dust'),
        transition_in=TRANSITION_MAP.get(
            args.scene_type, 'crossfade'),
        transition_out=TRANSITION_MAP.get(
            args.scene_type, 'crossfade'),
        camera_move=camera,
        wind=WIND_MAP.get(args.scene_type, 0.0),
    )

    # Load character PNG if provided
    char_rgba = None
    if args.character and os.path.exists(args.character):
        char_rgba = cv2.imread(
            args.character, cv2.IMREAD_UNCHANGED)
        if char_rgba is not None and \
                char_rgba.shape[2] == 4:
            print(f'[SceneAnimator] Character loaded: '
                  f'{char_rgba.shape[1]}×'
                  f'{char_rgba.shape[0]}px RGBA')
        else:
            print(f'[SceneAnimator] WARNING: character '
                  f'PNG has no alpha channel — skipping')
            char_rgba = None

    # Render frames
    print(f'[SceneAnimator] Rendering '
          f'{int(args.duration * args.fps)} frames...')
    frames = render_scene_to_frames(cfg, scene)

    # Composite character onto each frame
    if char_rgba is not None:
        print(f'[SceneAnimator] Compositing character...')
        frames = [
            composite_character(f, char_rgba, cfg)
            for f in frames
        ]

    # Write output MP4
    os.makedirs(
        os.path.dirname(args.output) or '.', exist_ok=True)
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    writer = cv2.VideoWriter(
        args.output, fourcc,
        float(args.fps), (args.width, args.height)
    )
    if not writer.isOpened():
        print(f'[SceneAnimator] ERROR: VideoWriter '
              f'failed: {args.output}', file=sys.stderr)
        sys.exit(1)

    for frame in frames:
        writer.write(frame)
    writer.release()

    elapsed = time.time() - t0
    size_kb = os.path.getsize(args.output) // 1024
    ms_per_frame = elapsed / len(frames) * 1000

    print(f'[SceneAnimator] Complete!')
    print(f'[SceneAnimator] Frames: {len(frames)}')
    print(f'[SceneAnimator] Output: {args.output}')
    print(f'[SceneAnimator] Size: {size_kb}KB')
    print(f'[SceneAnimator] Time: {elapsed:.1f}s '
          f'({ms_per_frame:.0f}ms/frame)')
    sys.exit(0)


if __name__ == '__main__':
    main()
