"""
doraemon_engine.py
==================
Doraemon-style limited-animation engine for Universe of NULL.

CPU only, pure Python (opencv-python + numpy + librosa). No GPU. Produces a
1080x1920 portrait clip from pre-built character part PNGs.

CLI is a superset of scene_animator_v3.py / metro_engine_v4.py (same core args,
same [Engine]-style log prefix and exit codes — exit 0 + output >10KB == success
— so renderService.ts detects success identically). Unknown --emotion /
--scene_type values map to defaults instead of erroring (no argparse choices=).

────────────────────────────────────────────────────────────────────────────
COMPOSITE MODEL (portrait talking-head)
────────────────────────────────────────────────────────────────────────────
The Veer parts are NOT a layered feature rig. They are:
  * body_* / walk_*  : full-body wide shots (1024x1536), face already drawn.
  * mouth_* eyes_* brow_* : complete head-and-shoulders close-up portraits
    (1254x1254), each a full face with one feature varied.
So we do NOT overlay tiny sprites. We pick ONE asset per frame:

  WALK mode (--walk):       full-body walk_01..08 cycle, no face overlay.
  PORTRAIT mode (has audio): swap a face portrait per frame for lip-sync:
        silence        -> mouth_closed
        low amplitude  -> mouth_open_e
        medium         -> mouth_open_a
        high           -> mouth_open_o
        happy+silence  -> mouth_smile
        happy+talking  -> mouth_smile_open
     Blink overrides the mouth for 2 frames every 3-5s (eyes_half, eyes_closed).
     First 8 frames hold an expression portrait before audio kicks in.
     Portrait fills the centre 70% of frame width, anchored in the upper frame.
  WIDE mode (character, no audio): static full-body, breathing only.
  BACKGROUND mode (NARRATOR / no parts): background only, no character.

All portraits are cropped to a single shared bounding box so only the mouth/eyes
change between frames (the head stays locked — no lip-sync jitter).

Usage:
  py doraemon_engine.py \
    --background bg.png --character_name veer \
    --parts_dir E:/s2v-aistudio/assets/characters/veer \
    --audio narration.wav --output out.mp4 \
    --duration 10 --emotion curious --scene_type bedroom --fps 24
"""

import argparse
import json
import math
import os
import random
import sys
import time

import cv2
import numpy as np

# ═══════════════════════════════════════════════════════════════════════════
# CONFIG
# ═══════════════════════════════════════════════════════════════════════════

OUT_W, OUT_H = 1080, 1920
PORTRAIT_FILL_W = 0.85          # portrait spans centre 85% of frame width
PORTRAIT_CENTER_Y = 0.40        # portrait vertical centre, fraction of height (legacy)
PORTRAIT_BOTTOM_MARGIN = 80     # gap between portrait bottom edge and frame bottom
PORTRAIT_FADE_PX = 200          # bottom alpha ramp height (px) to hide the hard cut
BODY_HEIGHT_FRAC = 0.65         # full-body character height, fraction of frame
BODY_COMPOSITE_HEIGHT_FRAC = 0.56  # body_composite target char height; only scales UP small characters
FEET_Y = 1800                   # full-body feet anchor (px)
CENTER_X = OUT_W // 2
WALK_SPEED = 2.0                # walk bob frequency (Hz)
FADE_FRAMES = 12                # fade in/out length
KEN_BURNS_ZOOM = 0.04           # background zoom over the whole clip

# Audio amplitude -> mouth state thresholds (Section 3)
AMP_SILENCE = 0.05
AMP_LOW     = 0.15
AMP_MED     = 0.30

# Canonical part keys the engine knows about (count reported as X/25).
CANONICAL_PARTS = [
    'body_neutral', 'body_talking', 'body_thinking', 'body_surprised',
    'mouth_closed', 'mouth_open_a', 'mouth_open_e', 'mouth_open_o',
    'mouth_smile', 'mouth_smile_open',
    'eyes_open', 'eyes_half', 'eyes_closed', 'eyes_wide',
    'brow_neutral', 'brow_raised', 'brow_furrowed',
    'walk_01', 'walk_02', 'walk_03', 'walk_04',
    'walk_05', 'walk_06', 'walk_07', 'walk_08',
]

# Real on-disk filenames differ from the canonical keys for three parts
# (double-dot, swapped word order, misspelling). Tolerate them.
PART_ALIASES = {
    'mouth_open_e':    ['mouth_open_e.png', 'mouth_open_e..png'],
    'mouth_smile_open': ['mouth_smile_open.png', 'mouth_open_smile.png'],
    'brow_furrowed':   ['brow_furrowed.png', 'brow_forrowed.png'],
}

# Expression -> (body, brow, eyes) — eyes/body inform the start-frame portrait.
EXPRESSIONS = {
    'neutral':  {'body': 'body_neutral',   'brow': 'brow_neutral',  'eyes': 'eyes_open'},
    'curious':  {'body': 'body_neutral',   'brow': 'brow_raised',   'eyes': 'eyes_open'},
    'worried':  {'body': 'body_neutral',   'brow': 'brow_furrowed', 'eyes': 'eyes_half'},
    'happy':    {'body': 'body_talking',   'brow': 'brow_raised',   'eyes': 'eyes_open'},
    'shocked':  {'body': 'body_surprised', 'brow': 'brow_raised',   'eyes': 'eyes_wide'},
    'thinking': {'body': 'body_thinking',  'brow': 'brow_furrowed', 'eyes': 'eyes_half'},
    'tense':    {'body': 'body_neutral',   'brow': 'brow_furrowed', 'eyes': 'eyes_open'},
    'sad':      {'body': 'body_neutral',   'brow': 'brow_furrowed', 'eyes': 'eyes_half'},
    'empty':    {'body': 'body_neutral',   'brow': 'brow_neutral',  'eyes': 'eyes_half'},
}

# Portrait shown for the first 8 frames before audio-driven lip-sync starts.
START_PORTRAIT = {
    'curious':  'eyes_open',
    'worried':  'eyes_half',
    'shocked':  'eyes_wide',
    'thinking': 'eyes_half',
}

GRADE_EMOTIONS = {'curious', 'tense', 'sad', 'happy', 'empty'}

# ── body_composite mode: headless poses available in parts_dir/_headless/ ────
# body_thinking is intentionally excluded: the forearm in that pose connects to
# the torso without a gap in the centre column, making automatic collar-top
# detection ambiguous.  Deferred until a re-generated pose with a clearer
# neck/collar gap is available.
HEADLESS_BODY_POSES = [
    'body_neutral', 'body_talking', 'body_surprised',
    'body_idle', 'body_explaining', 'body_pointing',
]

# Emotion → headless body pose for body_composite mode.
# 'thinking' falls back to body_neutral (see HEADLESS_BODY_POSES note above);
# the emotional read still comes through via the face/eyes/brow on the head layer.
BODY_COMPOSITE_BODY_MAP = {
    'neutral':  'body_idle',        # standing still, listening
    'curious':  'body_explaining',  # arm extended, presenting
    'worried':  'body_neutral',     # contained stance
    'happy':    'body_talking',     # animated gesture
    'shocked':  'body_surprised',   # hands raised
    'thinking': 'body_neutral',     # body_thinking deferred; emotion reads via face
    'tense':    'body_neutral',     # arms at sides, contained
    'sad':      'body_neutral',     # arms at sides
    'empty':    'body_idle',        # still
}

# Head height as a fraction of total character height (derived from full-body
# portrait analysis: head region ≈ 18.75% of character bbox height).
HEAD_BODY_FRAC = 0.1875


# ═══════════════════════════════════════════════════════════════════════════
# MATH
# ═══════════════════════════════════════════════════════════════════════════

def clamp(v, lo, hi):
    return max(lo, min(hi, v))


# ═══════════════════════════════════════════════════════════════════════════
# IMAGE LOADING — white background -> transparent
# ═══════════════════════════════════════════════════════════════════════════

def white_to_alpha(img: np.ndarray) -> np.ndarray:
    """
    Return a BGRA image with the white background turned transparent.

    If the source already has an alpha channel it is used as-is. Otherwise we
    build a near-white mask (cv2.inRange, RGB all > 240) and flood-fill from the
    corners so only border-connected white becomes transparent — interior whites
    (eye sclera, sneaker highlights) stay opaque, which a naive global threshold
    would punch holes through.
    """
    if img is None:
        return None
    if img.ndim == 3 and img.shape[2] == 4:
        return img
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    bgr = img[:, :, :3]
    white = cv2.inRange(bgr, (241, 241, 241), (255, 255, 255))
    h, w = white.shape
    ff = white.copy()
    mask = np.zeros((h + 2, w + 2), np.uint8)
    for sx, sy in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        if ff[sy, sx] == 255:
            cv2.floodFill(ff, mask, (sx, sy), 128)
    bg = ff == 128
    if not bg.any():
        bg = white == 255  # fall back to the literal Section-2 global threshold
    alpha = np.full((h, w), 255, np.uint8)
    alpha[bg] = 0
    return np.dstack([bgr, alpha])


def content_bbox(bgra: np.ndarray, thr: int = 10):
    a = bgra[:, :, 3]
    ys, xs = np.where(a > thr)
    if len(ys) == 0:
        return (0, 0, bgra.shape[1], bgra.shape[0])
    return (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)


def union_bbox(bgras):
    x0 = y0 = 10 ** 9
    x1 = y1 = -1
    for b in bgras:
        bx0, by0, bx1, by1 = content_bbox(b)
        x0, y0 = min(x0, bx0), min(y0, by0)
        x1, y1 = max(x1, bx1), max(y1, by1)
    if x1 < 0:
        return (0, 0, bgras[0].shape[1], bgras[0].shape[0])
    return (x0, y0, x1, y1)


def crop(bgra, box):
    x0, y0, x1, y1 = box
    return bgra[y0:y1, x0:x1]


def fade_bottom_alpha(bgra: np.ndarray, frac: float = 0.20) -> np.ndarray:
    """Ramp the alpha to zero over the bottom `frac` of the sprite so a
    head-and-shoulders portrait dissolves into the scene instead of ending on a
    hard horizontal cut."""
    out = bgra.copy()
    h = out.shape[0]
    band = max(1, int(h * frac))
    ramp = np.linspace(1.0, 0.0, band, dtype=np.float32)[:, None]
    a = out[h - band:, :, 3].astype(np.float32) * ramp
    out[h - band:, :, 3] = a.astype(np.uint8)
    return out


def fade_bottom_to_color(bgra: np.ndarray, color_bgr: tuple, fade_px: int = 35) -> np.ndarray:
    """
    Crossfade the bottom `fade_px` rows from portrait pixels to a solid color
    at full opacity.  Alpha stays 255 throughout — no transparency.

    Used in portrait mode so the chest/shirt area dissolves into the shirt
    color rather than fading to transparent and revealing the background.
    """
    out = bgra.copy()
    h = out.shape[0]
    band = min(max(1, fade_px), h)
    # ramp: 0.0 at top of band (portrait), 1.0 at bottom (solid color)
    ramp = np.linspace(0.0, 1.0, band, dtype=np.float32)[:, None, None]
    color = np.array(color_bgr[:3], dtype=np.float32)[None, None, :]
    rgb = out[h - band:, :, :3].astype(np.float32)
    out[h - band:, :, :3] = np.clip(rgb * (1.0 - ramp) + color * ramp, 0, 255).astype(np.uint8)
    out[h - band:, :, 3] = 255  # fully opaque — no background bleed
    return out


def scale_to_width(bgra, target_w):
    s = target_w / bgra.shape[1]
    return cv2.resize(bgra, (target_w, max(1, int(bgra.shape[0] * s))),
                      interpolation=cv2.INTER_LANCZOS4)


def scale_to_height(bgra, target_h):
    s = target_h / bgra.shape[0]
    return cv2.resize(bgra, (max(1, int(bgra.shape[1] * s)), target_h),
                      interpolation=cv2.INTER_LANCZOS4)


def load_parts(parts_dir: str):
    """Load every canonical part (handling filename aliases). White-key each to
    BGRA, full-canvas (cropping happens per render mode). Returns
    (parts dict, loaded list, missing list)."""
    parts, loaded, missing = {}, [], []
    for key in CANONICAL_PARTS:
        candidates = PART_ALIASES.get(key, [key + '.png'])
        path = None
        for name in candidates:
            p = os.path.join(parts_dir, name)
            if os.path.exists(p):
                path = p
                break
        if path is None:
            missing.append(key)
            continue
        img = cv2.imread(path, cv2.IMREAD_UNCHANGED)
        keyed = white_to_alpha(img)
        if keyed is None:
            missing.append(key)
            continue
        parts[key] = keyed
        loaded.append(key)
    return parts, loaded, missing


# ═══════════════════════════════════════════════════════════════════════════
# AUDIO ANALYSIS
# ═══════════════════════════════════════════════════════════════════════════

def audio_amplitudes(audio_path: str, fps: int, n_frames: int) -> np.ndarray:
    """RMS amplitude per video frame, normalised 0..1. Zeros (silence) when no
    audio is provided or librosa is unavailable."""
    if not audio_path or not os.path.exists(audio_path):
        return np.zeros(n_frames, dtype=np.float32)
    try:
        import librosa
    except Exception as e:  # pragma: no cover
        print(f'[DoraemonEngine] WARNING: librosa unavailable ({e}); mouths stay closed')
        return np.zeros(n_frames, dtype=np.float32)
    try:
        y, sr = librosa.load(audio_path, sr=22050)
        hop = max(1, int(sr / fps))
        rms = librosa.feature.rms(y=y, frame_length=hop * 2, hop_length=hop)[0]
        peak = float(rms.max())
        if peak > 1e-6:
            rms = rms / peak
        out = np.zeros(n_frames, dtype=np.float32)
        for i in range(n_frames):
            out[i] = float(rms[min(i, len(rms) - 1)]) if len(rms) else 0.0
        return out
    except Exception as e:
        print(f'[DoraemonEngine] WARNING: audio analysis failed ({e}); mouths stay closed')
        return np.zeros(n_frames, dtype=np.float32)


def mouth_key_for(amp: float, emotion: str) -> str:
    if emotion == 'happy':
        return 'mouth_smile' if amp < AMP_LOW else 'mouth_smile_open'
    if amp < AMP_SILENCE:
        return 'mouth_closed'
    if amp < AMP_LOW:
        return 'mouth_open_e'
    if amp < AMP_MED:
        return 'mouth_open_a'
    return 'mouth_open_o'


def build_blink_schedule(n_frames: int, fps: int, duration: float, seed: int):
    """Per-frame eye override: 'half' then 'closed' for 2 frames, every 3-5s.
    Seeded for determinism."""
    arr = [None] * n_frames
    rng = random.Random(seed)
    t = rng.uniform(2.0, 4.0)
    while t < duration:
        f0 = int(t * fps)
        if f0 < n_frames:
            arr[f0] = 'half'
        if f0 + 1 < n_frames:
            arr[f0 + 1] = 'closed'
        t += rng.uniform(3.0, 5.0)
    return arr


# ═══════════════════════════════════════════════════════════════════════════
# BODY-COMPOSITE HELPERS
# ═══════════════════════════════════════════════════════════════════════════

def detect_collar_y(bgra: np.ndarray, bgr_img: np.ndarray) -> int:
    """
    Find where the shirt collar starts in a headless body image.

    Strategy: longest opaque run in the centre column = the torso.
    The start of that run is the collar top (top of the collar interior where
    the neck enters the shirt).

    Works correctly for body_surprised (raised arms create a short run above
    the main torso run; the longest run wins) and all other included poses.
    body_thinking is excluded from HEADLESS_BODY_POSES because its raised
    forearm connects to the torso without a detectable gap.
    """
    alpha = bgra[:, :, 3]
    h, w = alpha.shape
    cx = w // 2
    col = alpha[:, cx]

    runs = []
    in_run = False
    run_start = 0
    for y in range(h):
        if col[y] > 30 and not in_run:
            run_start = y
            in_run = True
        elif col[y] <= 30 and in_run:
            runs.append((run_start, y - 1))
            in_run = False
    if in_run:
        runs.append((run_start, h - 1))
    if not runs:
        return h // 4

    return max(runs, key=lambda r: r[1] - r[0])[0]


def build_body_meta(headless_dir: str) -> dict:
    """
    Compute and cache per-pose collar_y in body_meta.json.
    Returns {pose: {'collar_y': int}, ...}.
    Loads from cache if body_meta.json already exists.
    """
    meta_path = os.path.join(headless_dir, 'body_meta.json')
    if os.path.exists(meta_path):
        with open(meta_path) as f:
            return json.load(f)

    if not os.path.isdir(headless_dir):
        raise RuntimeError(f'[DoraemonEngine] _headless dir not found: {headless_dir}')

    meta = {}
    for pose in HEADLESS_BODY_POSES:
        p = os.path.join(headless_dir, f'{pose}.png')
        if not os.path.exists(p):
            continue
        img = cv2.imread(p)
        bgra = white_to_alpha(img)
        if bgra is not None:
            meta[pose] = {'collar_y': detect_collar_y(bgra, img)}

    if not meta:
        raise RuntimeError(f'[DoraemonEngine] No headless poses found in: {headless_dir}')

    with open(meta_path, 'w') as f:
        json.dump(meta, f, indent=2)
    summary = ', '.join(f'{p}={v["collar_y"]}' for p, v in meta.items())
    print(f'[DoraemonEngine] body_meta.json written: {summary}')
    return meta


# ═══════════════════════════════════════════════════════════════════════════
# COMPOSITING (Section 6)
# ═══════════════════════════════════════════════════════════════════════════

def composite_png(canvas: np.ndarray, overlay: np.ndarray, x, y, scale=1.0):
    """Alpha-composite a BGRA overlay onto a BGR canvas at (x, y) top-left.
    Resizes by `scale` (Lanczos), clips the paste region to the canvas, feathers
    the alpha edge with a 3x3 Gaussian, blends. Out-of-bounds is clipped."""
    if overlay is None:
        return
    if scale != 1.0:
        nw = max(1, int(round(overlay.shape[1] * scale)))
        nh = max(1, int(round(overlay.shape[0] * scale)))
        overlay = cv2.resize(overlay, (nw, nh), interpolation=cv2.INTER_LANCZOS4)
    oh, ow = overlay.shape[:2]
    x, y = int(round(x)), int(round(y))
    H, W = canvas.shape[:2]
    fx0, fy0 = max(0, x), max(0, y)
    fx1, fy1 = min(W, x + ow), min(H, y + oh)
    if fx1 <= fx0 or fy1 <= fy0:
        return
    sx0, sy0 = fx0 - x, fy0 - y
    sub = overlay[sy0:sy0 + (fy1 - fy0), sx0:sx0 + (fx1 - fx0)]
    if sub.shape[2] == 4:
        alpha = cv2.GaussianBlur(sub[:, :, 3].astype(np.float32), (3, 3), 0) / 255.0
        rgb = sub[:, :, :3].astype(np.float32)
    else:
        alpha = np.ones(sub.shape[:2], np.float32)
        rgb = sub.astype(np.float32)
    a = alpha[:, :, None]
    roi = canvas[fy0:fy1, fx0:fx1].astype(np.float32)
    canvas[fy0:fy1, fx0:fx1] = np.clip(rgb * a + roi * (1 - a), 0, 255).astype(np.uint8)


# ═══════════════════════════════════════════════════════════════════════════
# PIXEL EFFECTS
# ═══════════════════════════════════════════════════════════════════════════

def load_background(path: str, w: int, h: int) -> np.ndarray:
    img = cv2.imread(path)
    if img is None:
        raise FileNotFoundError(f'Cannot load background: {path}')
    ih, iw = img.shape[:2]
    s = max(w / iw, h / ih)
    nw, nh = int(iw * s), int(ih * s)
    img = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LANCZOS4)
    x0, y0 = (nw - w) // 2, (nh - h) // 2
    return img[y0:y0 + h, x0:x0 + w].copy()


def ken_burns(bg: np.ndarray, t: float, duration: float) -> np.ndarray:
    z = 1.0 + KEN_BURNS_ZOOM * clamp(t / max(duration, 1e-3), 0, 1)
    h, w = bg.shape[:2]
    M = np.float32([[z, 0, w * 0.5 * (1 - z)], [0, z, h * 0.5 * (1 - z)]])
    return cv2.warpAffine(bg, M, (w, h), flags=cv2.INTER_LINEAR,
                          borderMode=cv2.BORDER_REPLICATE)


def apply_grade(frame: np.ndarray, emotion: str) -> np.ndarray:
    """Emotion colour grade at half resolution then upscaled (BGR)."""
    if emotion not in GRADE_EMOTIONS:
        return frame
    h, w = frame.shape[:2]
    sm = cv2.resize(frame, (w // 2, h // 2), interpolation=cv2.INTER_LINEAR).astype(np.float32)
    if emotion == 'curious':            # +warm
        sm[:, :, 2] += 10; sm[:, :, 0] -= 5
    elif emotion == 'happy':            # slight warm boost
        sm[:, :, 2] += 8
    elif emotion == 'tense':            # cool + desaturate (sat *0.85)
        gray = sm.mean(axis=2, keepdims=True)
        sm = gray * 0.15 + sm * 0.85
        sm[:, :, 0] += 6
    elif emotion == 'sad':              # heavy desaturate (sat *0.6)
        gray = sm.mean(axis=2, keepdims=True)
        sm = gray * 0.40 + sm * 0.60
    elif emotion == 'empty':            # high contrast + slight red
        sm = (sm - 128) * 1.15 + 128
        sm[:, :, 2] *= 1.1
    sm = np.clip(sm, 0, 255).astype(np.uint8)
    return cv2.resize(sm, (w, h), interpolation=cv2.INTER_LINEAR)


def build_vignette(w: int, h: int, strength: float = 0.85) -> np.ndarray:
    ys = np.linspace(-1, 1, h, dtype=np.float32)
    xs = np.linspace(-1, 1, w, dtype=np.float32)
    xv, yv = np.meshgrid(xs, ys)
    d = np.sqrt(xv ** 2 + yv ** 2)
    vig = 1.0 - strength * np.clip(d, 0, 1) ** 1.6
    return np.clip(vig, 0.12, 1.0)[:, :, None]


def add_grain(frame: np.ndarray, strength: float = 0.02) -> np.ndarray:
    """Film grain, fresh random noise each frame (built at quarter res for
    speed, then upscaled)."""
    amt = max(1, int(strength * 255))
    h, w = frame.shape[:2]
    noise = np.random.randint(-amt, amt + 1, (h // 4, w // 4, 3)).astype(np.float32)
    noise = cv2.resize(noise, (w, h), interpolation=cv2.INTER_NEAREST).astype(np.int16)
    return np.clip(frame.astype(np.int16) + noise, 0, 255).astype(np.uint8)


def apply_fade(frame: np.ndarray, fi: int, total: int, n: int = FADE_FRAMES) -> np.ndarray:
    if fi < n:
        f = (fi + 1) / n
    elif fi >= total - n:
        f = clamp((total - fi) / n, 0.0, 1.0)
    else:
        return frame
    return np.clip(frame.astype(np.float32) * f, 0, 255).astype(np.uint8)


# ═══════════════════════════════════════════════════════════════════════════
# RENDERER
# ═══════════════════════════════════════════════════════════════════════════

class DoraemonRenderer:
    def __init__(self, background_path, parts, mode, duration, fps, emotion,
                 amps, seed, walk_start_x, walk_end_x, parts_dir=''):
        self.parts = parts
        self.parts_dir = parts_dir
        self.mode = mode
        self.fps = fps
        self.duration = duration
        self.total_frames = max(1, int(duration * fps))
        self.emotion = emotion
        self.amps = amps
        self.walk_start_x = walk_start_x
        self.walk_end_x = walk_end_x

        self.base_bg = load_background(background_path, OUT_W, OUT_H)
        self.vignette = build_vignette(OUT_W, OUT_H)

        self.portraits = {}
        self.portrait_pos = (0, 0)
        self.walk_frames = []
        self.wide_body = None
        self.wide_pos = (0, 0)
        self.blink = [None] * self.total_frames

        # body_composite members — populated by _prepare_body_composite
        self.body_composite_bodies = {}
        self.body_composite_heads = {}
        self.body_collar_meta = {}
        self.body_feet_rows = {}   # bottom-most opaque row per pose (for grounding)
        self.composite_scale = 1.0  # normalises char height for small/landscape-format bodies
        self.neck_anchor_y = 0
        self.head_canvas_w = 0
        self.head_canvas_h = 0
        self.contact_shadow = None
        self.shadow_x = 0
        self.shadow_y = 0

        if mode == 'portrait':
            self._prepare_portraits()
            self.blink = build_blink_schedule(self.total_frames, fps, duration, seed)
        elif mode == 'walk':
            self._prepare_walk()
        elif mode == 'wide':
            self._prepare_wide()
        elif mode == 'body_composite':
            self._prepare_body_composite()
            self.blink = build_blink_schedule(self.total_frames, fps, duration, seed)

    # ── prep ────────────────────────────────────────────────────────────────
    def _prepare_portraits(self):
        keys = ['mouth_closed', 'mouth_open_a', 'mouth_open_e', 'mouth_open_o',
                'mouth_smile', 'mouth_smile_open',
                'eyes_open', 'eyes_half', 'eyes_closed', 'eyes_wide']
        present = [self.parts[k] for k in keys if k in self.parts]
        if not present:
            return

        # Normalise all portraits to the same canvas (transparent padding at
        # bottom/right) before computing the shared crop box.  Without this,
        # mixed-size assets (e.g. 1344×768 landscape and 1024×1024 square) clip
        # to different heights inside union_bbox → different final portrait heights
        # → top_y computed from the first portrait mis-anchors all others.
        max_h = max(p.shape[0] for p in present)
        max_w = max(p.shape[1] for p in present)
        normed = {}
        for k in keys:
            if k in self.parts:
                p = self.parts[k]
                if p.shape[0] != max_h or p.shape[1] != max_w:
                    canvas = np.zeros((max_h, max_w, 4), dtype=p.dtype)
                    canvas[:p.shape[0], :p.shape[1]] = p
                    normed[k] = canvas
                else:
                    normed[k] = p

        box = union_bbox(list(normed.values()))        # shared crop -> head locked
        target_w = int(OUT_W * PORTRAIT_FILL_W)

        # Per-character portrait fade config: if character_meta.json provides
        # portrait_fade_color_bgr, crossfade the bottom pixels to that solid
        # color (no transparency) so the background doesn't show through the chest.
        # Falls back to the old alpha-fade when no config is present.
        portrait_fade_color = None
        portrait_fade_px    = 35
        if self.parts_dir:
            char_meta_path = os.path.join(self.parts_dir, 'character_meta.json')
            if os.path.exists(char_meta_path):
                try:
                    with open(char_meta_path) as _f:
                        _cm = json.load(_f)
                    portrait_fade_color = _cm.get('portrait_fade_color_bgr')
                    portrait_fade_px    = int(_cm.get('portrait_fade_px', 35))
                except Exception:
                    pass

        # Scale once to learn the portrait height; fade_frac only used in the
        # alpha-fade fallback path.
        sample = scale_to_width(crop(list(normed.values())[0], box), target_w)
        ph = sample.shape[0]
        fade_frac = min(0.5, PORTRAIT_FADE_PX / max(1, ph))
        for k in keys:
            if k in normed:
                scaled = scale_to_width(crop(normed[k], box), target_w)
                if portrait_fade_color:
                    self.portraits[k] = fade_bottom_to_color(
                        scaled, tuple(portrait_fade_color), fade_px=portrait_fade_px)
                else:
                    self.portraits[k] = fade_bottom_alpha(scaled, frac=fade_frac)
        any_p = next(iter(self.portraits.values()))
        ph, pw = any_p.shape[:2]
        # Bottom-anchor: portrait bottom edge sits PORTRAIT_BOTTOM_MARGIN above
        # the frame bottom so the character is grounded in the scene.
        top_y = OUT_H - PORTRAIT_BOTTOM_MARGIN - ph
        self.portrait_pos = (CENTER_X - pw // 2, top_y)

    def _prepare_walk(self):
        wkeys = [f'walk_{i:02d}' for i in range(1, 9) if f'walk_{i:02d}' in self.parts]
        if not wkeys:
            # fall back to a static body if no walk frames
            self._prepare_wide()
            return
        present = [self.parts[k] for k in wkeys]
        box = union_bbox(present)
        target_h = int(OUT_H * BODY_HEIGHT_FRAC)
        self.walk_frames = [scale_to_height(crop(self.parts[k], box), target_h) for k in wkeys]

    def _prepare_wide(self):
        body_key = EXPRESSIONS.get(self.emotion, EXPRESSIONS['neutral'])['body']
        if body_key not in self.parts:
            body_key = next((k for k in CANONICAL_PARTS if k.startswith('body') and k in self.parts), None)
        if body_key is None:
            return
        box = content_bbox(self.parts[body_key])
        body = scale_to_height(crop(self.parts[body_key], box), int(OUT_H * BODY_HEIGHT_FRAC))
        self.wide_body = body
        bh, bw = body.shape[:2]
        self.wide_pos = (CENTER_X - bw // 2, FEET_Y - bh)

    def _prepare_body_composite(self):
        """
        Load headless body poses + per-frame head composites for body_composite mode.

        Head frames: each portrait key (mouth_*, eyes_*) is cropped to the head
        region defined by crop_rect_orig in head_meta.json, then head_isolated.png's
        canonical alpha is applied.  This reuses Phase-2 extraction quality
        (clean edges + neck fade) across every face state without re-extracting.

        Body frames: white-keyed to BGRA from _headless/*.png.
        Collar positions loaded from body_meta.json (computed once, then cached).
        """
        parts_dir = self.parts_dir
        headless_dir = os.path.join(parts_dir, '_headless')

        # head_meta.json ─────────────────────────────────────────────────────
        meta_path = os.path.join(parts_dir, 'head_meta.json')
        if not os.path.exists(meta_path):
            raise RuntimeError(f'[DoraemonEngine] head_meta.json not found: {meta_path}')
        with open(meta_path) as f:
            head_meta = json.load(f)

        cw, ch = head_meta['canvas_wh']
        self.neck_anchor_y = head_meta['neck_anchor_y']
        self.head_canvas_w = cw
        self.head_canvas_h = ch
        rx0, ry0, rx1, ry1 = head_meta['crop_rect_orig']

        # canonical alpha from head_isolated.png (Phase-2 extraction quality) ─
        head_iso_path = os.path.join(parts_dir, 'head_isolated.png')
        if not os.path.exists(head_iso_path):
            raise RuntimeError(f'[DoraemonEngine] head_isolated.png not found: {head_iso_path}')
        head_iso = cv2.imread(head_iso_path, cv2.IMREAD_UNCHANGED)
        if head_iso is None or head_iso.ndim != 3 or head_iso.shape[2] != 4:
            raise RuntimeError(f'[DoraemonEngine] head_isolated.png is not BGRA: {head_iso_path}')
        canonical_alpha = head_iso[:, :, 3]   # (ch, cw)

        # per-key head frames ─────────────────────────────────────────────────
        portrait_keys = [
            'mouth_closed', 'mouth_open_a', 'mouth_open_e', 'mouth_open_o',
            'mouth_smile', 'mouth_smile_open',
            'eyes_open', 'eyes_half', 'eyes_closed', 'eyes_wide',
        ]
        for key in portrait_keys:
            if key not in self.parts:
                continue
            part = self.parts[key]          # BGRA at original portrait resolution
            ph, pw = part.shape[:2]
            x0c = max(0, min(rx0, pw - 1))
            y0c = max(0, min(ry0, ph - 1))
            x1c = max(x0c + 1, min(rx1, pw))
            y1c = max(y0c + 1, min(ry1, ph))
            head_crop = part[y0c:y1c, x0c:x1c, :].copy()
            if head_crop.shape[0] != ch or head_crop.shape[1] != cw:
                head_crop = cv2.resize(head_crop, (cw, ch), interpolation=cv2.INTER_LANCZOS4)
            head_crop[:, :, 3] = canonical_alpha
            # Zero transparent-area RGB so Lanczos scaling doesn't bleed white
            # background pixels into semi-transparent edge pixels (white blob fix).
            head_crop[canonical_alpha < 10, :3] = 0
            self.body_composite_heads[key] = head_crop

        if not self.body_composite_heads:
            raise RuntimeError('[DoraemonEngine] No portrait head frames built — '
                               'missing mouth_*/eyes_* parts')

        # body_meta.json (per-pose collar_y) ─────────────────────────────────
        self.body_collar_meta = build_body_meta(headless_dir)

        # headless body poses ─────────────────────────────────────────────────
        for pose in HEADLESS_BODY_POSES:
            if pose not in self.body_collar_meta:
                continue
            p = os.path.join(headless_dir, f'{pose}.png')
            if not os.path.exists(p):
                continue
            img = cv2.imread(p)
            bgra = white_to_alpha(img)
            if bgra is not None:
                self.body_composite_bodies[pose] = bgra
                # Bottom-most opaque row — used to ground feet at FEET_Y rather
                # than the image bottom edge (which may have transparent whitespace).
                col_max = bgra[:, :, 3].max(axis=1)
                opaque = np.where(col_max > 30)[0]
                self.body_feet_rows[pose] = int(opaque[-1]) if len(opaque) else bgra.shape[0] - 1

        if not self.body_composite_bodies:
            raise RuntimeError(f'[DoraemonEngine] No headless body PNGs loaded: {headless_dir}')

        # Size normalisation: scale UP characters whose body images are small or
        # landscape-format (e.g. Nova 1344x768) so they fill BODY_COMPOSITE_HEIGHT_FRAC
        # of the frame.  composite_scale is never < 1.0 — tall characters unchanged.
        norm_pose = ('body_idle' if 'body_idle' in self.body_composite_bodies
                     else next(iter(self.body_composite_bodies)))
        norm_feet  = self.body_feet_rows[norm_pose]
        norm_collar = self.body_collar_meta[norm_pose]['collar_y']
        target_body_below = BODY_COMPOSITE_HEIGHT_FRAC * OUT_H * (1.0 - HEAD_BODY_FRAC)
        self.composite_scale = max(1.0, target_body_below / max(1, norm_feet - norm_collar))
        if self.composite_scale > 1.005:
            print(f'[DoraemonEngine] Height normalisation x{self.composite_scale:.3f} '
                  f'(body_below={norm_feet - norm_collar}px -> target={target_body_below:.0f}px)')

        # contact shadow (built once, composited before body each frame) ──────
        rx, sh = 130, 60
        sw = rx * 2 + 140
        spr = np.zeros((sh, sw, 4), np.uint8)
        cv2.ellipse(spr, (sw // 2, sh // 2), (rx, 14), 0, 0, 360, (0, 0, 0, 200), -1)
        spr[:, :, 3] = cv2.GaussianBlur(spr[:, :, 3], (41, 41), 0)
        self.contact_shadow = spr
        self.shadow_x = CENTER_X - sw // 2
        self.shadow_y = FEET_Y - sh // 2

        print(f'[DoraemonEngine] body_composite ready: '
              f'{len(self.body_composite_bodies)} body poses, '
              f'{len(self.body_composite_heads)} head frames, '
              f'neck_anchor_y={self.neck_anchor_y}')

    # ── per-frame portrait key selection ─────────────────────────────────────
    def _portrait_key(self, fi: int) -> str:
        if fi < 8:
            k = START_PORTRAIT.get(self.emotion, 'mouth_closed')
        else:
            b = self.blink[fi]
            if b == 'half':
                k = 'eyes_half'
            elif b == 'closed':
                k = 'eyes_closed'
            else:
                k = mouth_key_for(float(self.amps[fi]), self.emotion)
        if k not in self.portraits:
            k = 'mouth_closed' if 'mouth_closed' in self.portraits else next(iter(self.portraits))
        return k

    def _head_key(self, fi: int) -> str:
        """Same selection logic as _portrait_key but indexes body_composite_heads."""
        if fi < 8:
            k = START_PORTRAIT.get(self.emotion, 'mouth_closed')
        else:
            b = self.blink[fi]
            if b == 'half':
                k = 'eyes_half'
            elif b == 'closed':
                k = 'eyes_closed'
            else:
                k = mouth_key_for(float(self.amps[fi]), self.emotion)
        if k not in self.body_composite_heads:
            k = ('mouth_closed' if 'mouth_closed' in self.body_composite_heads
                 else next(iter(self.body_composite_heads)))
        return k

    # ── render one frame ──────────────────────────────────────────────────────
    def render(self, fi: int) -> np.ndarray:
        t = fi / self.fps
        frame = ken_burns(self.base_bg, t, self.duration)

        if self.mode == 'portrait' and self.portraits:
            key = self._portrait_key(fi)
            portrait = self.portraits[key]
            ph, pw = portrait.shape[:2]
            px, py = self.portrait_pos
            breath = 1.0 + 0.012 * math.sin(2 * math.pi * t / 2.0)
            new_w = pw * breath
            bx = CENTER_X - new_w / 2.0
            by = (py + ph) - ph * breath          # keep neck/shoulders anchored
            composite_png(frame, portrait, bx, by, scale=breath)

        elif self.mode == 'walk' and self.walk_frames:
            idx = int(t * self.fps / 2) % len(self.walk_frames)
            fr = self.walk_frames[idx]
            fh, fw = fr.shape[:2]
            wx = self.walk_start_x + (self.walk_end_x - self.walk_start_x) * (t / self.duration)
            ybob = int(4 * abs(math.sin(2 * math.pi * t * WALK_SPEED)))
            composite_png(frame, fr, wx - fw / 2.0, (FEET_Y - fh) - ybob)

        elif self.mode == 'wide' and self.wide_body is not None:
            bh, bw = self.wide_body.shape[:2]
            px, py = self.wide_pos
            breath = 1.0 + 0.012 * math.sin(2 * math.pi * t / 2.0)
            new_w = bw * breath
            composite_png(frame, self.wide_body, CENTER_X - new_w / 2.0,
                          (py + bh) - bh * breath, scale=breath)

        elif self.mode == 'body_composite' and self.body_composite_bodies:
            # Body pose for this emotion
            body_key = BODY_COMPOSITE_BODY_MAP.get(self.emotion, 'body_neutral')
            if body_key not in self.body_composite_bodies:
                body_key = next(iter(self.body_composite_bodies))
            body_img = self.body_composite_bodies[body_key]
            collar_y = self.body_collar_meta[body_key]['collar_y']
            bh, bw = body_img.shape[:2]

            breath = 1.0 + 0.012 * math.sin(2 * math.pi * t / 2.0)
            # composite_scale normalises char height across different body formats
            body_scale = breath * self.composite_scale

            # Ground feet (bottom-most opaque pixel row) at FEET_Y.
            # Using feet_row instead of bh avoids floating caused by transparent
            # whitespace that Gemini leaves below the feet in generated images.
            feet_row = self.body_feet_rows.get(body_key, bh - 1)
            body_x = CENTER_X - bw * body_scale / 2.0
            body_y = FEET_Y - feet_row * body_scale

            # Collar y in frame: distance from collar to actual feet (not image bottom)
            body_below_collar = feet_row - collar_y
            collar_y_frame = FEET_Y - body_below_collar * body_scale

            # Head scale: head_height = HEAD_BODY_FRAC/(1-HEAD_BODY_FRAC) * body_below_collar
            head_scale_base = (HEAD_BODY_FRAC / (1.0 - HEAD_BODY_FRAC)
                               * body_below_collar * self.composite_scale / self.neck_anchor_y)
            head_total_scale = head_scale_base * breath

            head_x = CENTER_X - self.head_canvas_w * head_total_scale / 2.0
            head_y = collar_y_frame - self.neck_anchor_y * head_total_scale

            head_img = self.body_composite_heads[self._head_key(fi)]

            # Composite order: contact shadow → body → head (head always in front)
            if self.contact_shadow is not None:
                composite_png(frame, self.contact_shadow, self.shadow_x, self.shadow_y)
            composite_png(frame, body_img, body_x, body_y, scale=body_scale)
            composite_png(frame, head_img, head_x, head_y, scale=head_total_scale)

        # else BACKGROUND mode: no character

        frame = apply_grade(frame, self.emotion)
        frame = (frame.astype(np.float32) * self.vignette).astype(np.uint8)
        frame = add_grain(frame)
        frame = apply_fade(frame, fi, self.total_frames)
        return frame


# ═══════════════════════════════════════════════════════════════════════════
# VIDEO OUTPUT
# ═══════════════════════════════════════════════════════════════════════════

def open_writer(path: str, fps: int, w: int, h: int):
    for cc in ('avc1', 'mp4v', 'XVID'):
        writer = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*cc), float(fps), (w, h))
        if writer.isOpened():
            return writer, cc
    raise RuntimeError(f'VideoWriter failed for: {path}')


# ═══════════════════════════════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description='Doraemon Engine — cutout limited animation')
    parser.add_argument('--background', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--duration', type=float, required=True)
    # NOTE: no choices= anywhere — unknown values fall back to defaults.
    parser.add_argument('--emotion', default='neutral')
    parser.add_argument('--scene_type', default='street')
    parser.add_argument('--fps', type=int, default=24)
    parser.add_argument('--width', type=int, default=OUT_W)
    parser.add_argument('--height', type=int, default=OUT_H)
    parser.add_argument('--audio', default='')
    # Doraemon-specific
    parser.add_argument('--character_name', default='veer')
    parser.add_argument('--parts_dir', default='')
    parser.add_argument('--render_mode', default='cutout')
    parser.add_argument('--walk', action='store_true')
    parser.add_argument('--body_composite', action='store_true',
                        help='Enable body+head composite mode when assets exist '
                             '(default: portrait for audio, wide for no audio)')
    parser.add_argument('--walk_start_x', type=int, default=240)
    parser.add_argument('--walk_end_x', type=int, default=840)
    # Accepted for CLI compatibility with scene_animator_v3 / metro_engine_v4
    parser.add_argument('--character', default='')
    parser.add_argument('--camera', default='')
    parser.add_argument('--prev_scene_type', default='')
    parser.add_argument('--next_scene_type', default='')
    parser.add_argument('--seed', type=int, default=42)
    parser.add_argument('--no_idle', action='store_true')
    args = parser.parse_args()

    if not os.path.exists(args.background):
        print(f'[DoraemonEngine] ERROR: background not found: {args.background}', file=sys.stderr)
        sys.exit(1)
    if args.duration <= 0:
        print('[DoraemonEngine] ERROR: duration must be > 0', file=sys.stderr)
        sys.exit(1)

    emotion = args.emotion if args.emotion in EXPRESSIONS else 'neutral'
    char_name = (args.character_name or '').strip().lower()
    is_narrator = char_name in ('', 'narrator', 'none')
    fps = args.fps
    n_frames = max(1, int(args.duration * fps))

    t0 = time.time()
    print('[DoraemonEngine] Starting render...')
    print(f'[DoraemonEngine] Background: {os.path.basename(args.background)}')
    print(f'[DoraemonEngine] Character: {char_name or "(narrator)"} | Emotion: {emotion} | '
          f'Scene type: {args.scene_type}')
    print(f'[DoraemonEngine] Duration: {args.duration}s @ {fps}fps')

    # ── Load parts ──
    parts = {}
    if args.parts_dir and os.path.isdir(args.parts_dir):
        parts, loaded, missing = load_parts(args.parts_dir)
        print(f'[DoraemonEngine] Loaded {len(loaded)}/{len(CANONICAL_PARTS)} character parts')
        if missing:
            print(f'[DoraemonEngine] Missing parts (using fallbacks): {", ".join(missing)}')
    elif args.render_mode == 'cutout':
        print(f'[DoraemonEngine] WARNING: cutout requested but parts_dir not found '
              f'({args.parts_dir or "<empty>"}) — falling back to background-only '
              f'generative render')
    else:
        print(f'[DoraemonEngine] Loaded 0/{len(CANONICAL_PARTS)} character parts '
              f'(no parts_dir) — background only')

    # ── Audio ──
    amps = audio_amplitudes(args.audio, fps, n_frames)
    has_audio = bool(args.audio) and os.path.exists(args.audio) and float(amps.max()) > 1e-6

    # ── Mode selection ──
    headless_dir = os.path.join(args.parts_dir, '_headless') if args.parts_dir else ''
    has_headless = False
    if headless_dir and os.path.isdir(headless_dir):
        has_headless = any(
            f.startswith('body_') and f.endswith('.png')
            for f in os.listdir(headless_dir)
        )
    has_head_meta = bool(args.parts_dir) and os.path.exists(
        os.path.join(args.parts_dir, 'head_meta.json'))
    has_head_iso = bool(args.parts_dir) and os.path.exists(
        os.path.join(args.parts_dir, 'head_isolated.png'))
    body_composite_ready = has_headless and has_head_meta and has_head_iso

    if not parts or is_narrator:
        mode = 'background'
        mode_reason = 'no character parts or narrator scene'
    elif args.walk:
        mode = 'walk'
        mode_reason = '--walk flag set'
    elif args.body_composite and body_composite_ready:
        mode = 'body_composite'
        mode_reason = (f'--body_composite flag set; assets found '
                       f'in {os.path.basename(args.parts_dir or "")}')
    elif has_audio:
        mode = 'portrait'
        mode_reason = 'audio present; no headless assets - portrait lip-sync fallback'
    else:
        mode = 'wide'
        mode_reason = 'no audio and no headless assets - wide static pose fallback'

    print(f'[DoraemonEngine] Mode: {mode} — {mode_reason}')

    renderer = DoraemonRenderer(
        args.background, parts, mode, args.duration, fps, emotion, amps,
        args.seed, args.walk_start_x, args.walk_end_x,
        parts_dir=args.parts_dir)

    os.makedirs(os.path.dirname(args.output) or '.', exist_ok=True)
    writer, codec = open_writer(args.output, fps, OUT_W, OUT_H)
    print(f'[DoraemonEngine] Codec: {codec}')
    print(f'[DoraemonEngine] Rendering {renderer.total_frames} frames...')

    for fi in range(renderer.total_frames):
        writer.write(renderer.render(fi))
        if fi and fi % 48 == 0:
            print(f'[DoraemonEngine] Rendering frame {fi} of {renderer.total_frames}')
    writer.release()

    if not os.path.exists(args.output) or os.path.getsize(args.output) < 10000:
        print('[DoraemonEngine] ERROR: output missing or too small', file=sys.stderr)
        sys.exit(1)

    elapsed = time.time() - t0
    size_kb = os.path.getsize(args.output) // 1024
    print(f'[DoraemonEngine] Complete: {renderer.total_frames} frames, {args.duration}s duration')
    print(f'[DoraemonEngine] Output: {args.output} ({size_kb}KB) | codec {codec} | '
          f'{elapsed:.1f}s ({elapsed / renderer.total_frames * 1000:.0f}ms/frame)')
    sys.exit(0)


if __name__ == '__main__':
    main()
