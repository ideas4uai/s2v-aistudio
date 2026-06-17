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
                 amps, seed, walk_start_x, walk_end_x):
        self.parts = parts
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

        if mode == 'portrait':
            self._prepare_portraits()
            self.blink = build_blink_schedule(self.total_frames, fps, duration, seed)
        elif mode == 'walk':
            self._prepare_walk()
        elif mode == 'wide':
            self._prepare_wide()

    # ── prep ────────────────────────────────────────────────────────────────
    def _prepare_portraits(self):
        keys = ['mouth_closed', 'mouth_open_a', 'mouth_open_e', 'mouth_open_o',
                'mouth_smile', 'mouth_smile_open',
                'eyes_open', 'eyes_half', 'eyes_closed', 'eyes_wide']
        present = [self.parts[k] for k in keys if k in self.parts]
        if not present:
            return
        box = union_bbox(present)                      # shared crop -> head locked
        target_w = int(OUT_W * PORTRAIT_FILL_W)
        # Scale once to learn the portrait height, then fade the bottom over a
        # fixed PORTRAIT_FADE_PX band (not a fraction) so the dissolve sits at
        # the same pixel distance from the feet regardless of crop height.
        sample = scale_to_width(crop(present[0], box), target_w)
        ph = sample.shape[0]
        fade_frac = min(0.5, PORTRAIT_FADE_PX / max(1, ph))
        for k in keys:
            if k in self.parts:
                self.portraits[k] = fade_bottom_alpha(
                    scale_to_width(crop(self.parts[k], box), target_w), frac=fade_frac)
        any_p = next(iter(self.portraits.values()))
        ph, pw = any_p.shape[:2]
        # Bottom-anchor: portrait bottom edge sits PORTRAIT_BOTTOM_MARGIN above
        # the frame bottom so Veer is grounded in the scene, not floating centre.
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
    else:
        print(f'[DoraemonEngine] Loaded 0/{len(CANONICAL_PARTS)} character parts '
              f'(no parts_dir) — background only')

    # ── Audio ──
    amps = audio_amplitudes(args.audio, fps, n_frames)
    has_audio = bool(args.audio) and os.path.exists(args.audio) and float(amps.max()) > 1e-6

    # ── Mode selection ──
    if not parts or is_narrator:
        mode = 'background'
    elif args.walk:
        mode = 'walk'
    elif has_audio:
        mode = 'portrait'
    else:
        mode = 'wide'
    print(f'[DoraemonEngine] Mode: {mode}'
          f'{" (audio-driven lip-sync)" if mode == "portrait" else ""}')

    renderer = DoraemonRenderer(
        args.background, parts, mode, args.duration, fps, emotion, amps,
        args.seed, args.walk_start_x, args.walk_end_x)

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
