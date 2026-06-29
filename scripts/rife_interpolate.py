#!/usr/bin/env python3
"""
RIFE frame interpolation for MP4 files.
Doubles frame rate (e.g. 24fps → 48fps) using RIFE-NCNN-Vulkan.

Usage:
    py scripts/rife_interpolate.py --input input.mp4 --output output.mp4

Environment:
    RIFE_BIN_PATH  — path to rife-ncnn-vulkan.exe (default: repo-relative)
"""

import argparse
import glob
import os
import shutil
import subprocess
import sys
import tempfile
import time

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT   = os.path.dirname(_SCRIPT_DIR)
RIFE_BIN_DEFAULT = os.path.join(
    _REPO_ROOT, 'rife', 'rife-ncnn-vulkan-20221029-windows', 'rife-ncnn-vulkan.exe'
)


def get_video_fps(video_path: str) -> float:
    """Return fps via ffprobe; falls back to 24.0 on failure."""
    try:
        res = subprocess.run(
            ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
             '-show_entries', 'stream=r_frame_rate',
             '-of', 'default=noprint_wrappers=1:nokey=1', video_path],
            capture_output=True, text=True, timeout=15,
        )
        fps_str = res.stdout.strip()
        if '/' in fps_str:
            num, den = fps_str.split('/')
            return float(num) / float(den)
        return float(fps_str)
    except Exception as exc:
        print(f'[RIFE] ffprobe unavailable ({exc}) — assuming 24fps')
        return 24.0


def run_rife(cmd: list, label: str) -> int:
    print(f'[RIFE] Running interpolation ({label})...')
    ret = subprocess.run(cmd, capture_output=True, text=True)
    if ret.stdout.strip():
        print(ret.stdout.strip())
    if ret.stderr.strip():
        print(ret.stderr.strip())
    return ret.returncode


def main():
    parser = argparse.ArgumentParser(description='RIFE MP4 frame interpolation (2× fps)')
    parser.add_argument('--input',  required=True,  help='Input MP4 path')
    parser.add_argument('--output', required=True,  help='Output MP4 path')
    parser.add_argument('--gpu',    type=int, default=1,
                        help='GPU ID (-1=cpu, 0=Intel UHD, 1=940MX, default=1)')
    parser.add_argument('--model',  default='rife-v4.6', help='RIFE model directory name')
    args = parser.parse_args()

    rife_bin  = os.environ.get('RIFE_BIN_PATH', RIFE_BIN_DEFAULT)
    rife_root = os.path.dirname(rife_bin)

    if not os.path.isfile(rife_bin):
        print(f'[RIFE] ERROR: Binary not found: {rife_bin}')
        print(f'[RIFE] Set RIFE_BIN_PATH or place binary at: {RIFE_BIN_DEFAULT}')
        sys.exit(1)

    if not os.path.isfile(args.input):
        print(f'[RIFE] ERROR: Input not found: {args.input}')
        sys.exit(1)

    model_path = os.path.join(rife_root, args.model)
    if not os.path.isdir(model_path):
        fallback = os.path.join(rife_root, 'rife-v2.3')
        print(f'[RIFE] Model {args.model} not found — falling back to rife-v2.3')
        model_path = fallback

    in_fps  = get_video_fps(args.input)
    out_fps = in_fps * 2
    print(f'[RIFE] {os.path.basename(args.input)}: {in_fps:.4g}fps -> {out_fps:.4g}fps')

    tmpdir       = tempfile.mkdtemp(prefix='rife_')
    frames_dir   = os.path.join(tmpdir, 'frames')
    rife_out_dir = os.path.join(tmpdir, 'rife_out')
    os.makedirs(frames_dir)
    os.makedirs(rife_out_dir)

    t_start = time.time()
    try:
        # ── Step 1: extract frames ──────────────────────────────────────────────
        print('[RIFE] Extracting frames...')
        ret = subprocess.run([
            'ffmpeg', '-hide_banner', '-loglevel', 'warning',
            '-i', args.input,
            '-vsync', '0',
            os.path.join(frames_dir, '%08d.png'),
            '-y',
        ])
        if ret.returncode != 0:
            print(f'[RIFE] ERROR: ffmpeg frame extraction failed (exit {ret.returncode})')
            sys.exit(1)

        frame_files = sorted(glob.glob(os.path.join(frames_dir, '*.png')))
        n_frames = len(frame_files)
        print(f'[RIFE] Extracted {n_frames} frames')
        if n_frames < 2:
            print('[RIFE] ERROR: need at least 2 frames for interpolation')
            sys.exit(1)

        # ── Step 2: RIFE interpolation ──────────────────────────────────────────
        rife_cmd = [
            rife_bin,
            '-i', frames_dir,
            '-o', rife_out_dir,
            '-m', model_path,
            '-g', str(args.gpu),
        ]

        rc = run_rife(rife_cmd, f'GPU {args.gpu}')
        if rc != 0 and args.gpu != 0:
            print(f'[RIFE] GPU {args.gpu} failed — trying GPU 0 (Intel UHD)...')
            rife_cmd[-1] = '0'
            rc = run_rife(rife_cmd, 'GPU 0')
        if rc != 0:
            print('[RIFE] ERROR: interpolation failed on all devices')
            sys.exit(1)

        rife_frames = sorted(glob.glob(os.path.join(rife_out_dir, '*.png')))
        n_rife = len(rife_frames)
        t_rife = time.time() - t_start
        print(f'[RIFE] {n_frames} -> {n_rife} frames in {t_rife:.1f}s')

        # ── Step 3: reassemble with original audio ──────────────────────────────
        out_fps_int = int(round(out_fps))
        print(f'[RIFE] Reassembling at {out_fps_int}fps...')
        os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
        ret = subprocess.run([
            'ffmpeg', '-hide_banner', '-loglevel', 'warning',
            '-r', str(out_fps_int),
            '-i', os.path.join(rife_out_dir, '%08d.png'),
            '-i', args.input,
            '-map', '0:v',
            '-map', '1:a?',          # optional — silent clips have no audio stream
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart',
            '-c:a', 'aac', '-b:a', '192k',
            '-shortest',
            '-y', args.output,
        ])
        if ret.returncode != 0:
            print(f'[RIFE] ERROR: ffmpeg reassemble failed (exit {ret.returncode})')
            sys.exit(1)

        t_total   = time.time() - t_start
        size_mb   = os.path.getsize(args.output) / 1024 / 1024
        in_size   = os.path.getsize(args.input)  / 1024 / 1024
        print(f'[RIFE] Done in {t_total:.1f}s | {in_size:.1f}MB -> {size_mb:.1f}MB')
        print(f'[RIFE] Output: {args.output}')

    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == '__main__':
    main()
