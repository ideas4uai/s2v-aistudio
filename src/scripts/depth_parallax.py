"""
depth_parallax.py
=================
Depth-map-based 2.5D parallax for static background images.

Importable module:
  generate_depth_map(bg_path, cache_path=None) -> np.ndarray (H,W) float32 [0..1]
    0 = far (background), 1 = near (foreground)

Standalone CLI (for testing):
  py src/scripts/depth_parallax.py \
      --background assets/backgrounds/bg04_street_day.png \
      --output outputs/depth_parallax_test.mp4 \
      --duration 10 --fps 24 --width 1080 --height 1920

Used by metro_engine_v4.py for unified (background-only) scenes.
Falls back cleanly to Ken Burns when Depth Anything is unavailable.
"""

import argparse
import os
import sys
import time

import cv2
import numpy as np

# ──────────────────────────────────────────────────────────────────────────────
# DEPTH MAP GENERATION
# ──────────────────────────────────────────────────────────────────────────────

_MODELS = [
    'depth-anything/Depth-Anything-V2-Small-hf',  # v2 preferred
    'LiheYoung/depth-anything-small-hf',           # v1 fallback
]


def generate_depth_map(bg_path: str, cache_path: str | None = None) -> np.ndarray:
    """Return depth map (H, W) float32 in [0, 1] where 1=near, 0=far.

    Loads from cache_path (.npy) when available; otherwise runs Depth Anything
    and saves the result for reuse. Raises RuntimeError if no model loads.
    """
    # Load from cache first
    if cache_path and os.path.exists(cache_path):
        arr = np.load(cache_path)
        print(f'[DepthParallax] Loaded depth cache: {os.path.basename(cache_path)}')
        return arr.astype(np.float32)

    try:
        from transformers import pipeline as hf_pipeline
        from PIL import Image
    except ImportError as exc:
        raise RuntimeError(f'transformers/Pillow not available: {exc}') from exc

    img = Image.open(bg_path).convert('RGB')
    depth_pipe = None
    last_err = None
    for model_id in _MODELS:
        try:
            depth_pipe = hf_pipeline('depth-estimation', model=model_id, device='cpu')
            print(f'[DepthParallax] Loaded model: {model_id}')
            break
        except Exception as e:
            last_err = e
    if depth_pipe is None:
        raise RuntimeError(f'Could not load any depth model: {last_err}')

    t0 = time.time()
    result = depth_pipe(img)
    elapsed = time.time() - t0
    print(f'[DepthParallax] Depth map generated in {elapsed:.1f}s')

    # predicted_depth: larger = closer (disparity convention in Depth Anything)
    raw = np.array(result['predicted_depth'])
    lo, hi = float(raw.min()), float(raw.max())
    if hi - lo < 1e-6:
        depth_norm = np.zeros_like(raw, dtype=np.float32)
    else:
        depth_norm = ((raw - lo) / (hi - lo)).astype(np.float32)
    # depth_norm: 0=far, 1=near — ready for speed multiplier

    if cache_path:
        np.save(cache_path, depth_norm)
        print(f'[DepthParallax] Depth cache saved: {os.path.basename(cache_path)}')

    return depth_norm


# ──────────────────────────────────────────────────────────────────────────────
# PARALLAX HELPERS (used by metro_engine_v4 inline and standalone CLI)
# ──────────────────────────────────────────────────────────────────────────────

def build_speed_map(depth_norm: np.ndarray) -> np.ndarray:
    """Convert depth (0=far, 1=near) to parallax speed multiplier [0.3..1.0].

    Far  (depth > 0.7): 0.3x — background barely moves
    Mid  (0.3..0.7):    0.6x — midground moves moderately
    Near (depth < 0.3): 1.0x — foreground moves the most
    """
    d = depth_norm
    speed = np.where(d > 0.7, 0.3,
            np.where(d > 0.3, 0.3 + (d - 0.3) / 0.4 * 0.3,   # lerp 0.3→0.6
                               0.6 + (0.3 - d) / 0.3 * 0.4))  # lerp 0.6→1.0
    return speed.astype(np.float32)


def apply_depth_warp(frame: np.ndarray,
                     speed_map: np.ndarray,
                     grid_x: np.ndarray,
                     grid_y: np.ndarray,
                     cam_tx_px: float) -> np.ndarray:
    """Shift each pixel by cam_tx_px * speed_map[y,x].

    cam_tx_px > 0 → camera pans right → near content moves left (parallax).
    grid_x/grid_y must be (H, W) float32 base coordinate maps.
    """
    map_x = grid_x + cam_tx_px * speed_map
    return cv2.remap(frame, map_x, grid_y,
                     cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


# Pan amplitude (px) per emotion for depth parallax camera motion
DEPTH_PAN_AMP = {
    'curious': 55,
    'tense':   40,
    'sad':     50,
    'empty':   20,
    'warm':    55,
    'neutral': 60,
}


def depth_pan_position(t: float, duration: float, emotion: str) -> float:
    """Return camera x position in [-amp, +amp] at time t (smooth linear pan)."""
    amp = DEPTH_PAN_AMP.get(emotion, 50)
    # linear sweep -amp → +amp over the full duration
    progress = t / max(duration, 0.001)
    return amp * (2.0 * progress - 1.0)


# ──────────────────────────────────────────────────────────────────────────────
# STANDALONE CLI (for smoke-testing without Metro V4)
# ──────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description='Depth Anything 2.5D parallax test render')
    parser.add_argument('--background', required=True)
    parser.add_argument('--output',     required=True)
    parser.add_argument('--duration',   type=float, default=10.0)
    parser.add_argument('--fps',        type=int,   default=24)
    parser.add_argument('--width',      type=int,   default=1080)
    parser.add_argument('--height',     type=int,   default=1920)
    parser.add_argument('--emotion',    default='neutral')
    args = parser.parse_args()

    if not os.path.exists(args.background):
        print(f'[DepthParallax] ERROR: background not found: {args.background}',
              file=sys.stderr)
        sys.exit(1)

    t0 = time.time()
    print(f'[DepthParallax] Background: {os.path.basename(args.background)}')
    print(f'[DepthParallax] Output: {args.output}')
    print(f'[DepthParallax] {args.duration}s @ {args.fps}fps  '
          f'{args.width}x{args.height}  emotion={args.emotion}')

    # ── Depth map ──
    cache_path = os.path.splitext(args.background)[0] + '_depth.npy'
    try:
        depth_norm = generate_depth_map(args.background, cache_path)
    except RuntimeError as e:
        print(f'[DepthParallax] ERROR: {e}', file=sys.stderr)
        sys.exit(2)   # exit 2 = signal to caller: use Ken Burns fallback

    H, W = args.height, args.width

    # Load + resize background to output dimensions (letter/pillar-box aware)
    bg_full = cv2.imread(args.background, cv2.IMREAD_COLOR)
    if bg_full is None:
        print('[DepthParallax] ERROR: could not read background PNG', file=sys.stderr)
        sys.exit(1)
    # Fit inside W x H (preserving aspect ratio) then crop to fill
    bh, bw = bg_full.shape[:2]
    scale = max(W / bw, H / bh)
    rw, rh = int(bw * scale), int(bh * scale)
    bg_full = cv2.resize(bg_full, (rw, rh), interpolation=cv2.INTER_LANCZOS4)
    # Centre-crop to (W, H)
    y0 = (rh - H) // 2
    x0 = (rw - W) // 2
    bg = bg_full[y0:y0 + H, x0:x0 + W]

    # Resize depth map to match frame dimensions
    depth_resized = cv2.resize(depth_norm, (W, H), interpolation=cv2.INTER_LINEAR)
    speed_map = build_speed_map(depth_resized)

    # Precompute base coordinate grids
    grid_y, grid_x = np.mgrid[0:H, 0:W].astype(np.float32)

    # ── Render ──
    total_frames = max(1, int(args.duration * args.fps))
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)

    fourcc_candidates = [cv2.VideoWriter_fourcc(*'avc1'), cv2.VideoWriter_fourcc(*'mp4v')]
    writer = None
    for cc in fourcc_candidates:
        w_try = cv2.VideoWriter(args.output, cc, float(args.fps), (W, H))
        if w_try.isOpened():
            writer = w_try
            break
    if writer is None:
        print('[DepthParallax] ERROR: could not open VideoWriter', file=sys.stderr)
        sys.exit(1)

    print(f'[DepthParallax] Rendering {total_frames} frames...')
    for fi in range(total_frames):
        t = fi / args.fps
        cam_tx = depth_pan_position(t, args.duration, args.emotion)
        frame = apply_depth_warp(bg, speed_map, grid_x, grid_y, cam_tx)
        writer.write(frame)
        if fi and fi % 96 == 0:
            print(f'[DepthParallax] ... {fi}/{total_frames}')
    writer.release()

    if not os.path.exists(args.output) or os.path.getsize(args.output) < 10000:
        print('[DepthParallax] ERROR: output missing or too small', file=sys.stderr)
        sys.exit(1)

    elapsed = time.time() - t0
    size_kb = os.path.getsize(args.output) // 1024
    print(f'[DepthParallax] Done in {elapsed:.1f}s | {size_kb}KB')
    print(f'[DepthParallax] Output: {args.output}')


if __name__ == '__main__':
    main()
