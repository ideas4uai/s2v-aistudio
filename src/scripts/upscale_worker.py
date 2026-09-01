"""Sharpen a generated still before it enters the render.

The image model is fixed at 1.03 MP (768x1344 / 1344x768) and ignores every request for
more — imageSize 1K, 2K and 4K all return the same size. The render then magnifies that
by ~1.6x to fill a 1080p frame, and more once letterbox bars are stripped off a still
that was already small. So the pixels have to come from somewhere else: this runs
Real-ESRGAN x4plus locally and hands the render a source it can DOWNsample instead.

Model, fully local after a one-time weight download:
  RealESRGAN_x4plus  BSD 3-Clause  general photo model, every scene

Only the official x4plus general model is used. Several popular community ESRGAN
variants (4x-AnimeSharp, 4x-UltraSharp) are CC-BY-NC-SA and cannot be used commercially.

GFPGAN face restoration was built, measured and removed. It restores every face at a
fixed 512x512 internally and pastes the result back, so on a 2x-upscaled still — where
a close-up face measures ~863px — it downscales the face and re-enlarges it 1.69x. On
the sharpest test image that took detail (laplacian variance) from 310.8 back to 88.8,
barely above the 77.4 of not upscaling at all: it smoothed away exactly what this pass
had just recovered. It also could not fit on a 2GB card even loaded alone, so it always
fell back to CPU. The mismatch is structural, not a tuning problem — GFPGAN exists to
rescue small degraded faces, not to improve already-large ones.

Runs on whatever is available: the 940MX here is sm_50, which has no fast fp16, so this
stays in fp32 and tiles the image to hold VRAM down.
"""
import argparse
import json
import os
import sys
import time

# basicsr still imports torchvision.transforms.functional_tensor, which torchvision
# removed in 0.17. Aliasing the module is enough — rgb_to_grayscale, the only name it
# wants, lives in torchvision.transforms.functional — and unlike editing the installed
# package it survives a reinstall.
import torchvision.transforms.functional as _tvf
sys.modules.setdefault('torchvision.transforms.functional_tensor', _tvf)

import cv2
import torch
from basicsr.archs.rrdbnet_arch import RRDBNet
from realesrgan import RealESRGANer

MODEL_DIR = os.environ.get('UPSCALE_MODEL_DIR', 'upscale-models')
# Tile size trades VRAM for overhead. 192 measured 1.12 GB reserved on a 2 GB card.
TILE = int(os.environ.get('UPSCALE_TILE', '192'))


def build_upsampler() -> RealESRGANer:
    net = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23,
                  num_grow_ch=32, scale=4)
    return RealESRGANer(
        scale=4,
        model_path=os.path.join(MODEL_DIR, 'RealESRGAN_x4plus.pth'),
        model=net, tile=TILE, tile_pad=10, pre_pad=0,
        half=False,                       # sm_50 has no fast fp16
        gpu_id=0 if torch.cuda.is_available() else None,
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('dst')
    # x2 lands at 4.1 MP, so the render DOWNsamples to 1080p rather than up. x4 is
    # 16.5 MP for no visible gain once it is resized back down, and costs the render
    # real memory and disk on every scene.
    ap.add_argument('--scale', type=float, default=2.0)
    args = ap.parse_args()

    img = cv2.imread(args.src, cv2.IMREAD_COLOR)
    if img is None:
        print(json.dumps({'ok': False, 'error': f'unreadable: {args.src}'}))
        return 1

    h, w = img.shape[:2]
    t0 = time.time()
    if torch.cuda.is_available():
        torch.cuda.reset_peak_memory_stats()

    upsampler = build_upsampler()
    out, _ = upsampler.enhance(img, outscale=args.scale)

    dt = time.time() - t0
    cv2.imwrite(args.dst, out)
    peak = (torch.cuda.max_memory_reserved() / 1024**3) if torch.cuda.is_available() else 0.0
    print(json.dumps({
        'ok': True, 'src': f'{w}x{h}', 'dst': f'{out.shape[1]}x{out.shape[0]}',
        'seconds': round(dt, 1), 'peak_vram_gb': round(peak, 2),
        'device': torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'cpu',
    }))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
