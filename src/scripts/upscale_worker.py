"""Sharpen a generated still before it enters the render.

The image model is fixed at 1.03 MP (768x1344 / 1344x768) and ignores every request for
more — imageSize 1K, 2K and 4K all return the same size. The render then magnifies that
by ~1.6x to fill a 1080p frame, and more once letterbox bars are stripped off a still
that was already small. So the pixels have to come from somewhere else: this runs
Real-ESRGAN x4plus locally and hands the render a source it can DOWNsample instead.

Models, both fully local after a one-time weight download:
  RealESRGAN_x4plus  BSD 3-Clause  general photo model, every scene
  GFPGANv1.4         Apache 2.0    face restoration, only where a scene has a character

Only the official x4plus general model is used. Several popular community ESRGAN
variants (4x-AnimeSharp, 4x-UltraSharp) are CC-BY-NC-SA and cannot be used commercially.

Runs on whatever is available: the 940MX here is sm_50, which has no fast fp16, so this
stays in fp32 and tiles the image to hold VRAM down.
"""
import argparse
import gc
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


def face_device():
    """Where to run GFPGAN.

    GFPGAN wants roughly 1.2 GB for the StyleGAN2 decoder at 512x512. On a 2 GB card
    that is already sharing with the desktop there is often not enough left even after
    Real-ESRGAN is freed, and GFPGAN answers an OOM by returning the face UNrestored —
    a silent no-op that looks like success. So the choice is made up front from what is
    actually free, and the CPU path is used rather than pretending. UPSCALE_FACE_DEVICE
    overrides for a machine with room to spare.
    """
    forced = os.environ.get('UPSCALE_FACE_DEVICE')
    if forced:
        return torch.device(forced)
    if not torch.cuda.is_available():
        return torch.device('cpu')
    free, _ = torch.cuda.mem_get_info()
    need = float(os.environ.get('UPSCALE_FACE_MIN_VRAM_GB', '1.4')) * 1024**3
    return torch.device('cuda' if free >= need else 'cpu')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('dst')
    # x2 lands at 4.1 MP, so the render DOWNsamples to 1080p rather than up. x4 is
    # 16.5 MP for no visible gain once it is resized back down, and costs the render
    # real memory and disk on every scene.
    ap.add_argument('--scale', type=float, default=2.0)
    ap.add_argument('--face', action='store_true',
                    help='also run GFPGAN; set by the caller when the scene has a character')
    args = ap.parse_args()

    img = cv2.imread(args.src, cv2.IMREAD_COLOR)
    if img is None:
        print(json.dumps({'ok': False, 'error': f'unreadable: {args.src}'}))
        return 1

    h, w = img.shape[:2]
    t0 = time.time()
    if torch.cuda.is_available():
        torch.cuda.reset_peak_memory_stats()

    # Two SEQUENTIAL passes, never both models resident.
    #
    # The obvious wiring — GFPGANer(bg_upsampler=upsampler) — holds the StyleGAN2
    # decoder, the RetinaFace detector, the parsing net AND the RRDBNet on the card at
    # once. On this 2 GB 940MX that OOMs at roughly 930 MB allocated, and realesrgan
    # swallows the error (`print('Error', error)`) and then dies on an unbound variable,
    # so the real cause never surfaces. Upscaling first and freeing before the face pass
    # keeps peak VRAM at whichever model is larger rather than their sum.
    upsampler = build_upsampler()
    out, _ = upsampler.enhance(img, outscale=args.scale)
    faces = 0
    face_dev = None
    if args.face:
        # RealESRGANer keeps the model and its last input/output as CUDA tensors, so
        # `del` on the wrapper alone leaves ~865 MB resident and GFPGAN still OOMs —
        # silently, because GFPGAN catches its own failure and pastes the UNrestored
        # face back. Dropping the model reference and collecting is what actually
        # returns the memory.
        upsampler.model = None
        upsampler.output = None
        upsampler.img = None
        del upsampler
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        from gfpgan import GFPGANer
        # upscale=1: Real-ESRGAN has already resized, so GFPGAN only restores the faces
        # it finds and pastes them back at the size they are.
        device = face_device()
        face_dev = device
        restorer = GFPGANer(
            model_path=os.path.join(MODEL_DIR, 'GFPGANv1.4.pth'),
            upscale=1, arch='clean', channel_multiplier=2, bg_upsampler=None,
            device=device,
        )
        cropped, _, restored = restorer.enhance(
            out, has_aligned=False, only_center_face=False, paste_back=True)
        faces = len(cropped or [])
        # A still with no detectable face keeps the Real-ESRGAN result untouched rather
        # than whatever a face restorer does to a frame with no face in it.
        if restored is not None and faces:
            out = restored

    dt = time.time() - t0
    cv2.imwrite(args.dst, out)
    peak = (torch.cuda.max_memory_reserved() / 1024**3) if torch.cuda.is_available() else 0.0
    print(json.dumps({
        'ok': True, 'src': f'{w}x{h}', 'dst': f'{out.shape[1]}x{out.shape[0]}',
        'seconds': round(dt, 1), 'peak_vram_gb': round(peak, 2),
        'device': torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'cpu',
        'face': bool(args.face), 'faces_restored': faces,
        'face_device': str(face_dev) if args.face else None,
    }))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
