"""
metro_engine_v4.py
==================
Metro Engine V4 — cinematic compositing engine for Universe of NULL.

Drop-in CLI replacement for scene_animator_v3.py (same args plus new optional
ones). Library + CLI in one file; metro_engine_v3.py stays untouched as the
USE_METRO_V4=false fallback.

What V4 adds over V3:
  1. Cinematic compositing — feathered alpha edges (Gaussian 21x21),
     light-direction-aware drop shadow, Reinhard LAB colour transfer from
     background to character, ambient-occlusion contact gradient at the feet.
  2. 3-layer parallax — background pans at 0.3x camera speed, character at
     1.0x, foreground particles at 1.5x.
  3. Character idle animation — breathing (scale 1.0->1.015 sine over 2s),
     +/-3px vertical drift over 4s, blink simulation on an approximate eye
     band every 3-5s (seeded, deterministic).
  4. Emotion-driven camera — curious: slow zoom in / tense: handheld shake /
     sad: slow zoom out / empty: static / neutral: gentle pan. Grades extended
     (empty gets a red shadow accent, sad gets heavy desaturation).
  5. Unified mode — when --character is empty the input is treated as a full
     scene image: pseudo-depth via low zoom anchor + stronger Ken Burns,
     idle/shadow/AO stages skipped.
  6. Location atmosphere — street: dust + warm bokeh discs / grid: teal data
     streams / bedroom: dust motes constrained to a light beam / black:
     static noise. All NumPy-generated, no assets.
  7. Transition system that survives FFmpeg `concat -c copy`: every
     transition splits into an OUT half (clip tail) and an IN half (next clip
     head) which both converge to a content-independent terminal state, so
     the hard cut between clips is seamless by construction.
       black -> any        glitch dissolve (chromatic aberration resolve)
       street -> street    whip pan blur
       any -> black        fade through deep red (NULL signature)
       grid -> any         teal data-stream curtain wipe (seeded => the
                           curtain texture is pixel-identical in both clips)
       default             fade through black

Usage (superset of scene_animator_v3.py):
  py metro_engine_v4.py \
    --background path/to/bg.png \
    --character  path/to/transparent.png \
    --output     path/to/output.mp4 \
    --duration   18.5 \
    --emotion    tense \
    --scene_type street \
    --camera     '' \
    --fps        24 \
    --width      1080 \
    --height     1920 \
    --prev_scene_type black \
    --next_scene_type street \
    --seed       42 \
    --no_idle            (flag: disable breathing/drift/blink)

Unknown --emotion / --scene_type values map to neutral/default instead of
erroring (v3's argparse `choices=` would exit(2)).
"""

import argparse
import math
import multiprocessing as mp
import os
import subprocess
import sys
import time
from dataclasses import dataclass

import cv2
import numpy as np

# Optional: Depth Anything 2.5D parallax for unified scenes (USE_DEPTH_PARALLAX != 'false')
try:
    import sys as _sys
    _sys.path.insert(0, os.path.dirname(__file__))
    from depth_parallax import (generate_depth_map as _gen_depth,
                                 build_speed_map as _build_speed,
                                 apply_depth_warp as _depth_warp,
                                 depth_pan_position as _pan_pos)
    _DEPTH_AVAILABLE = True
except Exception as _depth_import_err:
    _DEPTH_AVAILABLE = False

# ═══════════════════════════════════════════════════════════════════════════
# CONFIG
# ═══════════════════════════════════════════════════════════════════════════

@dataclass
class EngineConfig:
    w:   int = 1080
    h:   int = 1920
    fps: int = 24
    vignette_power: float = 1.5


# Deep red terminal colour for the any->black "fade through red" transition.
# Both the OUT half and the IN half converge to this exact frame, so the
# concat cut is invisible. BGR.
RED_TERMINAL = (10, 6, 88)

# Seed for the data-stream curtain texture. Must be a constant so the OUT
# half (clip N) and IN half (clip N+1) generate pixel-identical curtains in
# separate processes.
CURTAIN_SEED = 777


# ── Scene type maps (same keys as scene_animator_v3) ───────────────────────
PARTICLE_MAP = {
    'bedroom':  'beam_dust',
    'street':   'street',
    'grid':     'data_stream',
    'corridor': 'dust',
    'black':    'static_noise',
    'default':  'dust',
}

WIND_MAP = {
    'bedroom':  0.0,
    'street':  -5.0,
    'grid':     0.0,
    'corridor': 0.0,
    'black':    0.0,
    'default':  0.0,
}

# ═══════════════════════════════════════════════════════════════════════════
# EMOTION GRADES (V4 — extends the V3 palettes)
#   r/g/b: channel multipliers   br: brightness  co: contrast
#   st/sb: shadow blue threshold/boost   ds: desaturation  vs: vignette
#   ra: red accent in shadows (empty/NULL signature)
# ═══════════════════════════════════════════════════════════════════════════

EMOTION_PALETTES = {
    "neutral": {"r":1.02,"g":1.00,"b":0.98,"br":1.00,"co":1.00,"st":80, "sb":0.95,"ds":0.00,"vs":0.45,"ra":0.0},
    "tense":   {"r":0.94,"g":0.97,"b":1.06,"br":0.95,"co":1.12,"st":100,"sb":1.08,"ds":0.25,"vs":0.52,"ra":0.0},
    "curious": {"r":1.08,"g":1.05,"b":0.92,"br":1.03,"co":1.00,"st":70, "sb":0.90,"ds":0.00,"vs":0.38,"ra":0.0},
    "sad":     {"r":0.92,"g":0.94,"b":1.06,"br":0.88,"co":0.95,"st":90, "sb":1.05,"ds":0.45,"vs":0.55,"ra":0.0},
    "empty":   {"r":0.90,"g":0.90,"b":1.00,"br":0.86,"co":1.18,"st":120,"sb":1.03,"ds":0.55,"vs":0.62,"ra":1.0},
    "warm":    {"r":1.05,"g":1.02,"b":0.95,"br":1.00,"co":1.00,"st":80, "sb":0.92,"ds":0.00,"vs":0.45,"ra":0.0},
}

# ═══════════════════════════════════════════════════════════════════════════
# MATH
# ═══════════════════════════════════════════════════════════════════════════

def lerp(a, b, t):    return a + (b - a) * t
def clamp(v, lo, hi): return max(lo, min(hi, v))
def ease_in_out(t):   t = clamp(t, 0, 1); return t * t * (3 - 2 * t)
def ease_out(t):      t = clamp(t, 0, 1); return 1 - (1 - t) ** 3
def ease_in(t):       t = clamp(t, 0, 1); return t * t * t

# ═══════════════════════════════════════════════════════════════════════════
# IMAGE LOADING (proven v3 primitives, copied so v3 stays untouched)
# ═══════════════════════════════════════════════════════════════════════════

def load_tall_canvas(path: str, w: int, h: int,
                     extra_height_factor: float = 1.15) -> np.ndarray:
    """Load image scaled to w x (h * extra_height_factor) for vertical parallax."""
    img = cv2.imread(path)
    if img is None:
        raise FileNotFoundError(f"Cannot load: {path}")
    ih, iw = img.shape[:2]
    tall_h = int(h * extra_height_factor)
    scale  = max(w / iw, tall_h / ih)
    nw, nh = int(iw * scale), int(ih * scale)
    img    = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LANCZOS4)
    x1     = (nw - w) // 2
    img    = img[:, x1:x1 + w]
    if img.shape[0] > tall_h:
        y1  = (img.shape[0] - tall_h) // 2
        img = img[y1:y1 + tall_h, :]
    elif img.shape[0] < tall_h:
        pad = np.zeros((tall_h - img.shape[0], w, 3), dtype=np.uint8)
        img = np.vstack([img, pad])
    return img.copy()


def vertical_parallax_crop(tall_canvas: np.ndarray, y_offset: float,
                           w: int, h: int) -> np.ndarray:
    canvas_h = tall_canvas.shape[0]
    max_off  = canvas_h - h
    y0       = int(clamp(y_offset, 0, max_off))
    return tall_canvas[y0:y0 + h, :w].copy()


def build_vignette_mask(w: int, h: int, strength: float,
                        power: float = 1.5) -> np.ndarray:
    ys     = np.linspace(-1, 1, h, dtype=np.float32)
    xs     = np.linspace(-1, 1, w, dtype=np.float32)
    xv, yv = np.meshgrid(xs, ys)
    dist   = np.sqrt(xv ** 2 + yv ** 2)
    vig    = (1.0 - np.clip(dist * strength, 0.0, 1.0)) ** power
    return np.stack([vig, vig, vig], axis=2)

# ═══════════════════════════════════════════════════════════════════════════
# SCENE ANALYSIS — all precomputed once per scene
# ═══════════════════════════════════════════════════════════════════════════

def detect_light_direction(bg: np.ndarray):
    """
    Estimate dominant light direction from the background.
    Returns (light_dx, shadow_opacity):
      light_dx in [-1, 1]: -1 = light from the left, +1 = light from the right.
      shadow_opacity in [0.22, 0.35]: harder when the scene is top-lit.
    """
    small = cv2.resize(bg, (64, 114), interpolation=cv2.INTER_AREA)
    gray  = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY).astype(np.float32)
    h, w  = gray.shape
    top   = gray[:int(h * 0.6)]
    col_brightness = top.sum(axis=0)
    total = col_brightness.sum()
    if total < 1e-3:
        return 0.0, 0.22
    centroid_x = float((col_brightness * np.arange(w, dtype=np.float32)).sum() / total)
    light_dx   = clamp((centroid_x / (w - 1) - 0.5) * 2.0, -1.0, 1.0)
    top_mean    = float(top.mean())
    bottom_mean = float(gray[int(h * 0.6):].mean()) + 1e-3
    ratio   = top_mean / bottom_mean
    opacity = clamp(0.22 + 0.13 * clamp(ratio - 1.0, 0.0, 1.0), 0.22, 0.35)
    return light_dx, opacity


def match_character_to_bg(char_rgba: np.ndarray, bg: np.ndarray,
                          strength: float = 0.6) -> np.ndarray:
    """
    Reinhard mean/std colour transfer in LAB from background to character.
    Smooth (no banding/hue flips that CDF histogram matching produces on
    flat-colour illustration). Std ratio clamped to avoid blowouts; skipped
    entirely for near-black backgrounds (e.g. void scenes).
    """
    bg_gray = cv2.cvtColor(bg, cv2.COLOR_BGR2GRAY)
    if float(bg_gray.mean()) < 25.0:
        return char_rgba

    mask = char_rgba[:, :, 3] > 128
    if int(mask.sum()) < 100:
        return char_rgba

    char_bgr = np.ascontiguousarray(char_rgba[:, :, :3])
    char_lab = cv2.cvtColor(char_bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    bg_lab   = cv2.cvtColor(bg, cv2.COLOR_BGR2LAB).astype(np.float32)

    for c in range(3):
        ch_vals = char_lab[:, :, c][mask]
        cm, cs  = float(ch_vals.mean()), float(ch_vals.std()) + 1e-5
        bm, bs  = float(bg_lab[:, :, c].mean()), float(bg_lab[:, :, c].std()) + 1e-5
        ratio   = clamp(bs / cs, 0.6, 1.6)
        char_lab[:, :, c] = (char_lab[:, :, c] - cm) * ratio + bm

    matched = cv2.cvtColor(np.clip(char_lab, 0, 255).astype(np.uint8),
                           cv2.COLOR_LAB2BGR)
    out = char_rgba.copy()
    out[:, :, :3] = cv2.addWeighted(char_bgr, 1.0 - strength, matched, strength, 0)
    return out


def feather_alpha(alpha: np.ndarray) -> np.ndarray:
    """
    Soften the rembg cutout edge: 1px erode kills the bright fringe, then a
    21x21 Gaussian feathers the edge so the character sits in the scene
    instead of floating on it.
    """
    eroded = cv2.erode(alpha, np.ones((3, 3), np.uint8), iterations=1)
    return cv2.GaussianBlur(eroded, (21, 21), 0)


def build_shadow_sprite(alpha: np.ndarray, light_dx: float):
    """
    Directional ground shadow from the character silhouette: squash the alpha
    vertically, shear it away from the light, blur heavily.
    Returns (sprite float32 [h,w] in 0..1, x_offset of sprite left edge
    relative to the character's left edge).
    """
    ch, cw = alpha.shape[:2]
    sh_h   = max(8, int(ch * 0.30))
    squash = cv2.resize(alpha, (cw, sh_h), interpolation=cv2.INTER_AREA)

    shear  = -light_dx * 0.45
    margin = int(abs(shear) * sh_h) + 2
    canvas_w = cw + 2 * margin
    M = np.float32([[1, shear, margin - (shear * sh_h if shear > 0 else 0)],
                    [0, 1, 0]])
    sheared = cv2.warpAffine(squash, M, (canvas_w, sh_h),
                             flags=cv2.INTER_LINEAR,
                             borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    blurred = cv2.GaussianBlur(sheared, (41, 41), 0)
    sprite  = blurred.astype(np.float32) / 255.0
    return sprite, -margin


def build_ao_sprite(char_w: int):
    """
    Ambient-occlusion contact gradient under the feet: a soft horizontal
    ellipse that darkens the ground ~25% at the contact line and fades out.
    Returns float32 [h,w] in 0..1 (multiplied later by AO strength).
    """
    aw = max(16, int(char_w * 0.85))
    ah = 70
    ys = np.linspace(-1, 1, ah, dtype=np.float32)
    xs = np.linspace(-1, 1, aw, dtype=np.float32)
    xv, yv = np.meshgrid(xs, ys)
    return np.exp(-(xv ** 2 + yv ** 2 * 1.4) * 2.4).astype(np.float32)

# ═══════════════════════════════════════════════════════════════════════════
# IDLE ANIMATION — breathing, drift, blink
# ═══════════════════════════════════════════════════════════════════════════

class IdleAnimator:
    def __init__(self, duration: float, fps: int, seed: int, enabled: bool = True):
        self.enabled = enabled
        self.fps     = fps
        total_frames = max(1, int(duration * fps))
        self.blink_strength = np.zeros(total_frames, dtype=np.float32)
        if not enabled:
            return
        rng = np.random.RandomState(seed & 0xffff)
        t = float(rng.uniform(1.5, 3.5))     # first blink comes a bit early
        blink_dur = 0.12
        while t < duration - blink_dur:
            f0 = int(t * fps)
            f1 = min(total_frames - 1, int((t + blink_dur) * fps))
            n  = max(1, f1 - f0)
            for i in range(f0, f1 + 1):
                # triangular profile: ramp in, peak, ramp out
                p = (i - f0) / n
                self.blink_strength[i] = max(self.blink_strength[i],
                                             1.0 - abs(2 * p - 1))
            t += float(rng.uniform(3.0, 5.0))

    def state(self, t: float, fi: int):
        """Returns (breath_scale, drift_dy, blink_strength)."""
        if not self.enabled:
            return 1.0, 0.0, 0.0
        scale = 1.0 + 0.0075 * (1.0 - math.cos(2 * math.pi * t / 2.0))  # 1.0->1.015, 2s
        dy    = 3.0 * math.sin(2 * math.pi * t / 4.0)                    # +/-3px, 4s
        blink = float(self.blink_strength[min(fi, len(self.blink_strength) - 1)])
        return scale, dy, blink

# ═══════════════════════════════════════════════════════════════════════════
# CAMERA — emotion-driven path; one camera state feeds all three layers
# ═══════════════════════════════════════════════════════════════════════════

class CameraPath:
    """
    at(t) -> (zoom, tx, vscroll, shake_x, shake_y)
      zoom:    scale factor applied to the background
      tx:      horizontal camera translation in px (layers move -tx * factor)
      vscroll: 0..1 progress through the tall canvas' vertical pan room
      shake:   handheld shake in px, applied to the composed frame
    """
    def __init__(self, emotion: str, duration: float, unified: bool):
        self.emotion  = emotion if emotion in EMOTION_PALETTES else 'neutral'
        self.duration = max(duration, 0.001)
        self.unified  = unified
        # Unified full-scene images get a low zoom anchor (the floor moves
        # more than the sky = pseudo-depth) and a stronger Ken Burns range.
        self.cy = 0.62 if unified else 0.55
        self.zoom_boost = 0.03 if unified else 0.0

    def at(self, t: float):
        p = ease_in_out(t / self.duration)
        e = self.emotion
        shake_x = shake_y = 0.0
        if e == 'curious':
            zoom    = lerp(1.0, 1.06 + self.zoom_boost, p)
            tx      = lerp(0.0, 12.0, p)
            vscroll = lerp(0.0, 0.5, p)
        elif e == 'tense':
            zoom    = 1.035 + self.zoom_boost
            tx      = 0.0
            vscroll = 0.25
            shake_x = clamp(2.0 * math.sin(t * 23.7) * math.sin(t * 7.3), -2, 2)
            shake_y = clamp(2.0 * math.sin(t * 17.3) * math.sin(t * 5.1), -2, 2)
        elif e == 'sad':
            zoom    = lerp(1.07 + self.zoom_boost, 1.0, p)
            tx      = 0.0
            vscroll = lerp(0.5, 0.1, p)
        elif e == 'empty':
            zoom    = 1.0
            tx      = 0.0
            vscroll = 0.3
        elif e == 'warm':
            zoom    = lerp(1.0, 1.04 + self.zoom_boost, p)
            tx      = lerp(0.0, 8.0, p)
            vscroll = lerp(0.1, 0.4, p)
        else:  # neutral — gentle pan
            zoom    = 1.05 + self.zoom_boost
            tx      = lerp(-18.0, 18.0, t / self.duration)
            vscroll = 0.25
        return zoom, tx, vscroll, shake_x, shake_y

# ═══════════════════════════════════════════════════════════════════════════
# PIXEL EFFECTS
# ═══════════════════════════════════════════════════════════════════════════

def warp_zoom_translate(img, zoom, cx_ratio, cy_ratio, tx, ty):
    """Combined zoom + translation in one warpAffine (BORDER_REPLICATE)."""
    h, w   = img.shape[:2]
    cx, cy = w * cx_ratio, h * cy_ratio
    M = np.float32([[zoom, 0, cx * (1 - zoom) + tx],
                    [0, zoom, cy * (1 - zoom) + ty]])
    return cv2.warpAffine(img, M, (w, h), flags=cv2.INTER_LINEAR,
                          borderMode=cv2.BORDER_REPLICATE)


def apply_emotion_grade(frame, emotion, blend=1.0):
    p = EMOTION_PALETTES.get(emotion, EMOTION_PALETTES["neutral"])
    h, w = frame.shape[:2]
    sm   = cv2.resize(frame, (w // 2, h // 2), interpolation=cv2.INTER_LINEAR)
    f    = sm.astype(np.float32)
    f   *= p["br"]
    f    = (f - 128) * p["co"] + 128
    f[:, :, 2] *= p["r"]; f[:, :, 1] *= p["g"]; f[:, :, 0] *= p["b"]
    mask = f[:, :, 0] < p["st"]; f[:, :, 0][mask] *= p["sb"]
    f = np.clip(f, 0, 255)
    if p["ds"] > 0:
        grey = np.mean(f, axis=2, keepdims=True).repeat(3, axis=2)
        f = f * (1 - p["ds"]) + grey * p["ds"]
    if p["ra"] > 0:
        # NULL signature: red accent in the shadows (empty scenes)
        lum = f.mean(axis=2)
        dark = lum < 60
        f[:, :, 2][dark] = np.clip(f[:, :, 2][dark] * 1.30 + 8.0, 0, 255)
    res = np.clip(f, 0, 255).astype(np.uint8)
    res = cv2.resize(res, (w, h), interpolation=cv2.INTER_LINEAR)
    if blend < 1.0:
        res = cv2.addWeighted(frame, 1 - blend, res, blend, 0)
    return res


def apply_vignette_flicker(frame, mask, t, intensity=0.022):
    """Vignette and light flicker folded into one full-frame float pass."""
    f = 1.0 + intensity * math.sin(t * 47.3) * math.sin(t * 13.7)
    return np.clip(frame.astype(np.float32) * (mask * f), 0, 255).astype(np.uint8)


def build_grain_bank(w, h, amount=5, n=8, seed=42):
    """Pre-baked full-frame grain tiles, cycled per frame (no per-frame RNG)."""
    rng  = np.random.RandomState(seed)
    bank = []
    pw, ph = w // 4, h // 4
    ty, tx = math.ceil(h / ph), math.ceil(w / pw)
    for _ in range(n):
        p = rng.randint(-amount, amount + 1, (ph, pw, 3)).astype(np.int16)
        bank.append(np.tile(p, (ty, tx, 1))[:h, :w, :])
    return bank


def add_grain_from_bank(frame, bank, fi):
    tiled = bank[fi % len(bank)]
    return np.clip(frame.astype(np.int16) + tiled, 0, 255).astype(np.uint8)


def motion_blur_h(frame, strength):
    if strength < 2:
        return frame
    k = np.ones((1, strength), dtype=np.float32) / strength
    return cv2.filter2D(frame, -1, k)


def chromatic_aberration(frame, shift):
    if shift <= 0:
        return frame
    out = frame.copy()
    out[:, :, 2] = np.roll(frame[:, :, 2], shift, axis=1)
    out[:, :, 0] = np.roll(frame[:, :, 0], -shift, axis=1)
    return out

# ═══════════════════════════════════════════════════════════════════════════
# PARTICLE ATMOSPHERE — location-driven, NumPy only, drawn at 1.5x parallax
# ═══════════════════════════════════════════════════════════════════════════

def _build_bokeh_sprite(radius: int, color, intensity: float) -> np.ndarray:
    """Soft out-of-focus light disc, premultiplied for additive blending."""
    d  = radius * 2 + 1
    ys = np.linspace(-1, 1, d, dtype=np.float32)
    xv, yv = np.meshgrid(ys, ys)
    falloff = np.clip(1.0 - np.sqrt(xv ** 2 + yv ** 2), 0, 1) ** 1.5
    sprite  = np.zeros((d, d, 3), dtype=np.float32)
    for c in range(3):
        sprite[:, :, c] = falloff * color[c] * intensity
    return sprite


def _build_beam_mask(w: int, h: int, light_dx: float) -> np.ndarray:
    """
    Diagonal light-beam mask (float 0..1) entering from the lit top corner.
    Built at quarter res and upscaled.
    """
    sw, sh = w // 4, h // 4
    ys = np.arange(sh, dtype=np.float32)[:, None]
    xs = np.arange(sw, dtype=np.float32)[None, :]
    # Beam line from top corner on the light side toward lower frame centre
    x0  = sw * (0.85 if light_dx >= 0 else 0.15)
    x1  = sw * 0.5
    y1  = sh * 1.0
    dx, dy = x1 - x0, y1
    norm = math.sqrt(dx * dx + dy * dy) + 1e-5
    # perpendicular distance of each pixel to the beam centreline
    dist = np.abs((xs - x0) * dy - ys * dx) / norm
    width = sw * 0.22
    mask  = np.exp(-(dist / width) ** 2).astype(np.float32)
    # beam fades with depth (toward the floor)
    mask *= np.linspace(1.0, 0.25, sh, dtype=np.float32)[:, None]
    return cv2.resize(mask, (w, h), interpolation=cv2.INTER_LINEAR)


class ParticleSystemV4:
    """
    Persistent particle state with per-mode behaviour. draw() takes the
    foreground parallax offset so particles travel at 1.5x camera speed.
    """
    def __init__(self, mode: str, cfg: EngineConfig, light_dx: float = 0.0,
                 n: int = 40, seed: int = 42):
        self.mode = mode
        self.W    = cfg.w
        self.H    = cfg.h
        self.n    = n
        rng       = np.random.RandomState(seed)
        self.rng_seed = seed

        self.x      = rng.uniform(0, self.W, n).astype(np.float32)
        self.y      = rng.uniform(self.H * 0.15, self.H * 0.92, n).astype(np.float32)
        self.size   = rng.uniform(1.5, 5.0, n).astype(np.float32)
        self.spd_x  = rng.uniform(-6, 2, n).astype(np.float32)
        self.spd_y  = rng.uniform(-1.5, 1.5, n).astype(np.float32)
        self.bright = rng.uniform(120, 255, n).astype(np.float32)
        self.phase  = rng.uniform(0, math.pi * 2, n).astype(np.float32)
        self.length = rng.uniform(20, 100, n).astype(np.float32)
        self.fall   = rng.uniform(80, 200, n).astype(np.float32)

        self.beam_mask = None
        self.beam_overlays = None
        if mode == 'beam_dust':
            self.beam_mask = _build_beam_mask(self.W, self.H, light_dx)
            # Pre-bake 3 glow intensities; per-frame we just cv2.add one
            beam_color = np.array([70, 110, 150], dtype=np.float32)  # warm BGR
            self.beam_overlays = []
            for k in (0.05, 0.07, 0.09):
                ov = (self.beam_mask[:, :, None] * beam_color[None, None, :] * k * 3.0)
                self.beam_overlays.append(np.clip(ov, 0, 255).astype(np.uint8))

        self.bokeh = []
        if mode == 'street':
            warm = (60, 160, 255)   # amber, BGR
            teal = (200, 180, 60)
            for i in range(7):
                r      = int(rng.uniform(25, 70))
                color  = warm if i % 3 else teal
                inten  = float(rng.uniform(0.18, 0.40))
                sprite = _build_bokeh_sprite(r, color, inten)
                self.bokeh.append({
                    'sprite': sprite,
                    'x': float(rng.uniform(0, self.W)),
                    'y': float(rng.uniform(self.H * 0.1, self.H * 0.85)),
                    'vx': float(rng.uniform(-4, 4)),
                    'vy': float(rng.uniform(-2.5, -0.5)),
                    'phase': float(rng.uniform(0, math.pi * 2)),
                })

    def warm_to(self, frame_index: int, dt: float, wind: float = 0.0):
        """Advance particle state to what it would be at `frame_index`.

        render(fi) is NOT a pure function of fi: it calls step() every frame, and
        step() integrates position, so frame N's particles depend on the N calls
        before it. A worker that starts mid-clip must replay those calls or its
        first frame gets frame-0 particles and dust visibly restarts at every range
        boundary.

        Replaying is used rather than solving for position directly: step() has
        wrap-around branches per mode, and reproducing them in closed form is a
        second implementation to keep in sync. This one is correct by construction.
        It is also cheap — vectorised numpy with no drawing, roughly three orders of
        magnitude below the cost of rendering the frames being skipped.
        """
        for _ in range(max(0, frame_index)):
            self.step(dt, wind)

    def step(self, dt: float, wind: float = 0.0):
        W, H = self.W, self.H
        if self.mode == 'data_stream':
            self.y += self.fall * dt
            self.y[self.y > H + 100] = -100.0
        elif self.mode == 'static_noise':
            pass
        else:  # dust / street dust / beam_dust
            self.x += (self.spd_x + wind) * dt
            self.y += self.spd_y * dt * 0.5
            self.x[self.x < 0]        = float(W)
            self.x[self.x > W]        = 0.0
            self.y[self.y < H * 0.1]  = float(H * 0.9)
            self.y[self.y > H * 0.92] = float(H * 0.12)
        for b in self.bokeh:
            b['x'] += b['vx'] * dt
            b['y'] += b['vy'] * dt
            if b['y'] < -80:        b['y'] = H + 80.0
            if b['x'] < -80:        b['x'] = W + 80.0
            elif b['x'] > W + 80:   b['x'] = -80.0

    def draw(self, frame: np.ndarray, t: float, fg_dx: float = 0.0):
        if self.mode == 'data_stream':
            self._data_stream(frame, fg_dx)
        elif self.mode == 'static_noise':
            self._static(frame, t)
        elif self.mode == 'beam_dust':
            self._beam(frame, t, fg_dx)
        elif self.mode == 'street':
            self._dust(frame, t, fg_dx)
            self._bokeh(frame, t, fg_dx)
        else:
            self._dust(frame, t, fg_dx)

    def _dust(self, frame, t, fg_dx, alpha_mask=None):
        W, H = self.W, self.H
        for i in range(self.n):
            a = 0.35 + 0.65 * abs(math.sin(t * 1.3 + float(self.phase[i])))
            cx, cy = int(self.x[i] + fg_dx), int(self.y[i])
            if not (0 < cx < W and 0 < cy < H):
                continue
            if alpha_mask is not None:
                a *= float(alpha_mask[cy, cx])
                if a < 0.04:
                    continue
            b = int(self.bright[i] * a)
            cv2.circle(frame, (cx, cy), max(1, int(self.size[i])),
                       (b, b, int(b * .85)), -1, cv2.LINE_AA)

    def _beam(self, frame, t, fg_dx):
        # glow overlay first (one cv2.add of a pre-baked image)
        k = int((math.sin(t * 0.8) + 1) * 1.49)  # 0..2
        cv2.add(frame, self.beam_overlays[k], dst=frame)
        # dust motes only visible inside the beam
        self._dust(frame, t, fg_dx, alpha_mask=self.beam_mask)

    def _bokeh(self, frame, t, fg_dx):
        H, W = self.H, self.W
        for b in self.bokeh:
            pulse  = 0.6 + 0.4 * abs(math.sin(t * 0.9 + b['phase']))
            sprite = b['sprite']
            sh, sw = sprite.shape[:2]
            x0 = int(b['x'] + fg_dx * 1.15) - sw // 2
            y0 = int(b['y']) - sh // 2
            x1, y1 = x0 + sw, y0 + sh
            fx0, fy0 = max(0, x0), max(0, y0)
            fx1, fy1 = min(W, x1), min(H, y1)
            if fx1 <= fx0 or fy1 <= fy0:
                continue
            sx0, sy0 = fx0 - x0, fy0 - y0
            roi = frame[fy0:fy1, fx0:fx1].astype(np.float32)
            roi += sprite[sy0:sy0 + (fy1 - fy0), sx0:sx0 + (fx1 - fx0)] * pulse
            frame[fy0:fy1, fx0:fx1] = np.clip(roi, 0, 255).astype(np.uint8)

    def _data_stream(self, frame, fg_dx):
        W, H = self.W, self.H
        for i in range(self.n):
            cx, cy = int(self.x[i] + fg_dx), int(self.y[i])
            ln = int(self.length[i])
            if not (0 <= cx < W):
                continue
            for j in range(ln):
                py = cy - j
                if 0 <= py < H:
                    fade = 1.0 - j / ln
                    if j < 3:
                        frame[py, cx] = (255, 255, 255)
                    else:
                        add = np.array([int(220 * fade), int(255 * fade), int(120 * fade)],
                                       dtype=np.int16)
                        frame[py, cx] = np.clip(frame[py, cx].astype(np.int16) + add // 3,
                                                0, 255).astype(np.uint8)

    def _static(self, frame, t):
        rng = np.random.RandomState(int(t * 1000) % 10000)
        xs = rng.randint(0, self.W, 300)
        ys = rng.randint(0, self.H, 300)
        vs = rng.randint(80, 220, 300)
        for i in range(300):
            frame[ys[i], xs[i]] = (vs[i], vs[i], vs[i])
        if math.sin(t * 13.7) > 0.85:
            gy = rng.randint(0, self.H)
            shift = rng.randint(8, 40)
            row = frame[gy, :].copy()
            frame[gy, shift:] = row[:-shift]

# ═══════════════════════════════════════════════════════════════════════════
# TRANSITIONS — split halves converging to content-independent terminals
# ═══════════════════════════════════════════════════════════════════════════

def choose_transition(from_type: str, to_type: str):
    a = (from_type or '').lower()
    b = (to_type or '').lower()
    if not a or not b:
        return None
    if b == 'black':
        return 'fade_red'
    if a == 'black':
        return 'glitch'
    if a == 'street' and b == 'street':
        return 'whip'
    if a == 'grid':
        return 'data_wipe'
    return 'fade_black'


def build_data_curtain(w: int, h: int, seed: int = CURTAIN_SEED) -> np.ndarray:
    """Full-frame teal data field. Seeded so both clips at a grid boundary
    generate the exact same pixels — the concat cut lands on identical frames."""
    rng = np.random.RandomState(seed)
    img = np.zeros((h, w, 3), dtype=np.uint8)
    img[:] = (24, 14, 6)  # near-black teal base, BGR
    for _ in range(260):
        x  = int(rng.randint(0, w))
        y0 = int(rng.randint(-h // 2, h))
        ln = int(rng.randint(h // 8, h // 2))
        bright = float(rng.uniform(0.4, 1.0))
        y1 = min(h - 1, y0 + ln)
        if y1 <= max(0, y0):
            continue
        ys = np.arange(max(0, y0), y1)
        fade = (1.0 - (ys - y0) / max(1, ln)) * bright
        img[ys, x, 0] = np.clip(220 * fade, 0, 255).astype(np.uint8)
        img[ys, x, 1] = np.clip(255 * fade, 0, 255).astype(np.uint8)
        img[ys, x, 2] = np.clip(110 * fade, 0, 255).astype(np.uint8)
    img = cv2.GaussianBlur(img, (3, 3), 0)
    return img


class TransitionFX:
    """OUT half runs at the clip tail (p: 0->1 reaches the terminal state at
    the final frame). IN half runs at the clip head (p: 0 starts exactly at
    the terminal state, 1 = fully revealed)."""

    def __init__(self, w: int, h: int):
        self.w = w
        self.h = h
        self._curtain = None

    def curtain(self):
        if self._curtain is None:
            self._curtain = build_data_curtain(self.w, self.h)
        return self._curtain

    # ── OUT halves (tail of the earlier clip) ──────────────────────────────
    def trans_out(self, frame, p, kind, fi=0):
        if kind == 'fade_red':
            red = np.full_like(frame, RED_TERMINAL, dtype=np.uint8)
            if p < 0.55:
                q = p / 0.55
                f = frame.astype(np.float32)
                f[:, :, 2] = np.clip(f[:, :, 2] * (1 + 0.6 * q) + 10 * q, 0, 255)
                f[:, :, 0] *= (1 - 0.45 * q)
                f[:, :, 1] *= (1 - 0.45 * q)
                return cv2.addWeighted(np.clip(f, 0, 255).astype(np.uint8),
                                       1.0, red, 0.0, 0)
            q = ease_in_out((p - 0.55) / 0.45)
            f = frame.astype(np.float32)
            f[:, :, 2] = np.clip(f[:, :, 2] * 1.6 + 10, 0, 255)
            f[:, :, 0] *= 0.55
            f[:, :, 1] *= 0.55
            tinted = np.clip(f, 0, 255).astype(np.uint8)
            return cv2.addWeighted(tinted, 1 - q, red, q, 0)
        if kind == 'glitch':
            # black scene ending: collapse to pure black with a little static
            q = ease_in(p)
            f = np.clip(frame.astype(np.float32) * (1 - q), 0, 255).astype(np.uint8)
            if p < 0.85:
                rng = np.random.RandomState(1000 + fi)
                for _ in range(int((1 - p) * 4)):
                    gy = int(rng.randint(0, self.h))
                    shift = int(rng.randint(6, 30))
                    row = f[gy, :].copy()
                    f[gy, shift:] = row[:-shift]
            return f
        if kind == 'whip':
            q = ease_in(p)
            k = int(q * 80)
            shoved = np.roll(frame, int(q * 60), axis=1) if q > 0.05 else frame
            return motion_blur_h(shoved, k)
        if kind == 'data_wipe':
            curtain = self.curtain()
            edge = int(ease_in_out(p) * (self.h + 60))
            out  = frame.copy()
            y_hard = clamp(edge - 60, 0, self.h)
            if y_hard > 0:
                out[:y_hard] = curtain[:y_hard]
            y_soft0, y_soft1 = int(y_hard), int(clamp(edge, 0, self.h))
            if y_soft1 > y_soft0:
                band = np.linspace(1, 0, y_soft1 - y_soft0,
                                   dtype=np.float32)[:, None, None]
                out[y_soft0:y_soft1] = (
                    curtain[y_soft0:y_soft1].astype(np.float32) * band +
                    out[y_soft0:y_soft1].astype(np.float32) * (1 - band)
                ).astype(np.uint8)
            return out
        # default: fade to black
        q = ease_in_out(p)
        return np.clip(frame.astype(np.float32) * (1 - q), 0, 255).astype(np.uint8)

    # ── IN halves (head of the later clip) ─────────────────────────────────
    def trans_in(self, frame, p, kind, fi=0):
        if kind == 'fade_red':
            red = np.full_like(frame, RED_TERMINAL, dtype=np.uint8)
            q = ease_out(p)
            return cv2.addWeighted(frame, q, red, 1 - q, 0)
        if kind == 'glitch':
            vis = ease_out(p)
            f = np.clip(frame.astype(np.float32) * vis, 0, 255).astype(np.uint8)
            f = chromatic_aberration(f, int((1 - p) * 16))
            rng = np.random.RandomState(2000 + fi)
            for _ in range(int((1 - p) * 10)):
                gy = int(rng.randint(0, self.h))
                shift = int(rng.randint(6, 40)) * (1 if rng.rand() > 0.5 else -1)
                row = f[gy, :].copy()
                f[gy] = np.roll(row, shift, axis=0)
            n_static = int((1 - p) * 400)
            if n_static > 0:
                xs = rng.randint(0, self.w, n_static)
                ys = rng.randint(0, self.h, n_static)
                vs = rng.randint(60, 200, n_static)
                f[ys, xs] = np.stack([vs, vs, vs], axis=1).astype(np.uint8)
            return f
        if kind == 'whip':
            q = ease_out(p)
            k = int((1 - q) * 80)
            shoved = np.roll(frame, -int((1 - q) * 60), axis=1) if q < 0.95 else frame
            return motion_blur_h(shoved, k)
        if kind == 'data_wipe':
            curtain = self.curtain()
            edge = int(ease_in_out(p) * (self.h + 60))
            out  = frame.copy()
            y_hard = clamp(edge, 0, self.h)
            # curtain still covers everything BELOW the reveal edge
            if y_hard < self.h:
                out[y_hard:] = curtain[y_hard:]
            y_soft0, y_soft1 = int(clamp(edge - 60, 0, self.h)), int(y_hard)
            if y_soft1 > y_soft0:
                band = np.linspace(0, 1, y_soft1 - y_soft0,
                                   dtype=np.float32)[:, None, None]
                out[y_soft0:y_soft1] = (
                    curtain[y_soft0:y_soft1].astype(np.float32) * band +
                    frame[y_soft0:y_soft1].astype(np.float32) * (1 - band)
                ).astype(np.uint8)
            return out
        # default: fade from black
        q = ease_in_out(p)
        return np.clip(frame.astype(np.float32) * q, 0, 255).astype(np.uint8)

# ═══════════════════════════════════════════════════════════════════════════
# SCENE RENDERER V4
# ═══════════════════════════════════════════════════════════════════════════

class SceneRendererV4:
    def __init__(self, cfg: EngineConfig, background_path: str,
                 char_rgba, duration: float, emotion: str, scene_type: str,
                 prev_scene_type: str = '', next_scene_type: str = '',
                 seed: int = 42, idle: bool = True):
        self.cfg = cfg
        self.W, self.H, self.FPS = cfg.w, cfg.h, cfg.fps
        self.duration = duration
        self.total_frames = max(1, int(duration * cfg.fps))
        self.emotion = emotion if emotion in EMOTION_PALETTES else 'neutral'
        self.scene_type = scene_type if scene_type in PARTICLE_MAP else 'default'
        self.unified = char_rgba is None

        # ── Background ──
        self.tall_canvas = load_tall_canvas(background_path, self.W, self.H)
        self.v_pan_room  = self.tall_canvas.shape[0] - self.H
        bg_ref = vertical_parallax_crop(self.tall_canvas,
                                        self.v_pan_room * 0.25, self.W, self.H)

        # ── Scene analysis ──
        self.light_dx, self.shadow_opacity = detect_light_direction(bg_ref)

        # ── Camera + idle + particles ──
        self.camera = CameraPath(self.emotion, duration, self.unified)
        self.idle   = IdleAnimator(duration, cfg.fps, seed, enabled=idle and not self.unified)
        self.particles = ParticleSystemV4(
            PARTICLE_MAP.get(self.scene_type, 'dust'), cfg,
            light_dx=self.light_dx, n=40, seed=seed)
        self.wind = WIND_MAP.get(self.scene_type, 0.0)

        # ── Character precompute (skipped in unified mode) ──
        self.char = None
        if char_rgba is not None:
            self._prepare_character(char_rgba, bg_ref)

        # ── Grade / vignette ──
        p = EMOTION_PALETTES[self.emotion]
        self.vignette_mask = build_vignette_mask(self.W, self.H,
                                                 strength=p["vs"],
                                                 power=cfg.vignette_power)
        self.grain_bank = build_grain_bank(self.W, self.H, amount=5, seed=seed)

        # ── Depth parallax (unified scenes only, optional) ──
        self.depth_speed_map = None
        self.depth_grid_x    = None
        self.depth_grid_y    = None
        if self.unified and _DEPTH_AVAILABLE and os.environ.get('USE_DEPTH_PARALLAX', 'true') != 'false':
            try:
                cache_path = os.path.splitext(background_path)[0] + '_depth.npy'
                depth_norm = _gen_depth(background_path, cache_path)
                # Align the depth map with the cover-cropped tall canvas.
                # A plain resize to frame size stretched the map whenever the
                # source aspect != frame aspect, so parallax speeds landed on
                # the wrong pixels and objects split/smeared during the pan.
                sh, sw  = cv2.imread(background_path).shape[:2]
                tall_h  = self.tall_canvas.shape[0]
                s       = max(self.W / sw, tall_h / sh)
                nw, nh  = sw * s, sh * s
                fx0     = ((nw - self.W) / 2.0) / nw
                fy0     = ((nh - tall_h) / 2.0) / nh
                dh, dw  = depth_norm.shape[:2]
                x0, x1  = int(fx0 * dw), int(round((fx0 + self.W / nw) * dw))
                y0, y1  = int(fy0 * dh), int(round((fy0 + tall_h / nh) * dh))
                crop    = depth_norm[y0:max(y1, y0 + 1), x0:max(x1, x0 + 1)]
                depth_tall = cv2.resize(crop, (self.W, tall_h),
                                        interpolation=cv2.INTER_LINEAR)
                # Tall speed map; render() crops the frame's window per-frame.
                self.depth_speed_map = _build_speed(depth_tall)
                self.depth_grid_y, self.depth_grid_x = np.mgrid[
                    0:self.H, 0:self.W].astype(np.float32)
                print('[MetroV4] Depth parallax active — 2.5D pan enabled')
            except Exception as _de:
                print(f'[MetroV4] Depth parallax unavailable ({_de}) — using Ken Burns')

        # ── Transitions ──
        self.fx = TransitionFX(self.W, self.H)
        half = min(0.5, duration * 0.15)
        self.in_kind  = choose_transition(prev_scene_type, self.scene_type)
        self.out_kind = choose_transition(self.scene_type, next_scene_type)
        self.head_frames = int(half * cfg.fps) if self.in_kind else 0
        self.tail_frames = int(half * cfg.fps) if self.out_kind else 0

    # ────────────────────────────────────────────────────────────────────
    def _prepare_character(self, char_rgba: np.ndarray, bg_ref: np.ndarray):
        """All per-scene character work: resize, colour match, feather,
        shadow sprite, AO sprite, eye band. Per-frame work is just one
        warpAffine + ROI blits."""
        # Scale to 68% of frame height (same framing contract as v3)
        target_h = int(self.H * 0.68)
        scale    = target_h / char_rgba.shape[0]
        target_w = max(1, int(char_rgba.shape[1] * scale))
        char = cv2.resize(char_rgba, (target_w, target_h),
                          interpolation=cv2.INTER_LANCZOS4)

        # Colour-match to the scene, then feather the cutout edge
        char = match_character_to_bg(char, bg_ref, strength=0.6)
        char[:, :, 3] = feather_alpha(char[:, :, 3])

        # Pad so the breathing scale-up never clips at the canvas edge
        pad_top, pad_side = 48, 24
        padded = np.zeros((target_h + pad_top, target_w + 2 * pad_side, 4),
                          dtype=np.uint8)
        padded[pad_top:, pad_side:pad_side + target_w] = char
        ch, cw = padded.shape[:2]

        # Alpha bounding box (for blink band placement)
        ys, xs = np.where(padded[:, :, 3] > 40)
        if len(ys) > 0:
            by0, by1 = int(ys.min()), int(ys.max())
            bx0, bx1 = int(xs.min()), int(xs.max())
        else:
            by0, by1, bx0, bx1 = 0, ch - 1, 0, cw - 1
        bbox_h = by1 - by0
        bbox_w = bx1 - bx0

        # Approximate eye band: rows 18-26% from bbox top, central 40% width.
        # Heuristic — reads as a micro-expression flicker, not anatomy.
        self.blink_band = None
        if bbox_h >= 200:
            ey0 = by0 + int(bbox_h * 0.18)
            ey1 = by0 + int(bbox_h * 0.26)
            ex0 = bx0 + int(bbox_w * 0.30)
            ex1 = bx0 + int(bbox_w * 0.70)
            n   = max(1, ey1 - ey0)
            wts = np.exp(-((np.arange(n, dtype=np.float32) / n) - 0.5) ** 2 / 0.08)
            self.blink_band = (ey0, ey1, ex0, ex1, wts[:, None, None])

        # Shadow + AO sprites from the feathered silhouette
        self.shadow_sprite, self.shadow_x_off = build_shadow_sprite(
            padded[:, :, 3], self.light_dx)
        self.ao_sprite = build_ao_sprite(bbox_w)

        self.char       = padded
        self.char_w     = cw
        self.char_h     = ch
        self.feet_local = ch  # feet sit at the bottom of the padded canvas
        # Base placement: centred horizontally, feet at 92% of frame height
        self.char_x0 = (self.W - cw) // 2
        self.char_y0 = int(self.H * 0.92) - ch

    # ────────────────────────────────────────────────────────────────────
    def _draw_multiply_sprite(self, frame, sprite, x, y, strength):
        """Darken frame ROI by sprite*strength (sprite float 0..1, 2D)."""
        sh, sw = sprite.shape[:2]
        fx0, fy0 = max(0, x), max(0, y)
        fx1, fy1 = min(self.W, x + sw), min(self.H, y + sh)
        if fx1 <= fx0 or fy1 <= fy0:
            return
        sx0, sy0 = fx0 - x, fy0 - y
        sub = sprite[sy0:sy0 + (fy1 - fy0), sx0:sx0 + (fx1 - fx0)]
        roi = frame[fy0:fy1, fx0:fx1].astype(np.float32)
        frame[fy0:fy1, fx0:fx1] = np.clip(
            roi * (1.0 - sub[:, :, None] * strength), 0, 255).astype(np.uint8)

    def _composite_character(self, frame, t, fi, cam_tx):
        breath, drift_dy, blink = self.idle.state(t, fi)

        char = self.char
        if breath != 1.0 or blink > 0.01:
            cx, cy = self.char_w / 2.0, float(self.feet_local)
            M = np.float32([[breath, 0, cx * (1 - breath)],
                            [0, breath, cy * (1 - breath)]])
            char = cv2.warpAffine(self.char, M, (self.char_w, self.char_h),
                                  flags=cv2.INTER_LINEAR,
                                  borderMode=cv2.BORDER_CONSTANT, borderValue=0)
            if blink > 0.01 and self.blink_band is not None:
                ey0, ey1, ex0, ex1, wts = self.blink_band
                region = char[ey0:ey1, ex0:ex1, :3].astype(np.float32)
                region *= (1.0 - 0.45 * blink * wts)
                char[ey0:ey1, ex0:ex1, :3] = region.astype(np.uint8)

        # Midground layer: full camera speed (BG moves at 0.3x, particles 1.5x)
        x = int(self.char_x0 - cam_tx)
        y = int(self.char_y0 + drift_dy)
        feet_y = y + self.feet_local

        # 1. Ambient occlusion at the contact point
        ao = self.ao_sprite
        self._draw_multiply_sprite(frame, ao,
                                   x + (self.char_w - ao.shape[1]) // 2,
                                   feet_y - ao.shape[0] // 2, 0.25)
        # 2. Directional shadow (sheared away from the light)
        sh = self.shadow_sprite
        self._draw_multiply_sprite(frame, sh,
                                   x + self.shadow_x_off + int(-self.light_dx * 14),
                                   feet_y - sh.shape[0] + 10, self.shadow_opacity)

        # 3. Character alpha blend
        fx0, fy0 = max(0, x), max(0, y)
        fx1 = min(self.W, x + self.char_w)
        fy1 = min(self.H, y + self.char_h)
        if fx1 <= fx0 or fy1 <= fy0:
            return frame
        sx0, sy0 = fx0 - x, fy0 - y
        sub   = char[sy0:sy0 + (fy1 - fy0), sx0:sx0 + (fx1 - fx0)]
        alpha = sub[:, :, 3:4].astype(np.float32) / 255.0
        rgb   = sub[:, :, :3].astype(np.float32)
        roi   = frame[fy0:fy1, fx0:fx1].astype(np.float32)
        frame[fy0:fy1, fx0:fx1] = np.clip(
            rgb * alpha + roi * (1 - alpha), 0, 255).astype(np.uint8)
        return frame

    # ────────────────────────────────────────────────────────────────────
    def render(self, fi: int) -> np.ndarray:
        t  = fi / self.FPS
        dt = 1.0 / self.FPS
        zoom, tx, vscroll, shx, shy = self.camera.at(t)

        # 1. Background layer — depth parallax (unified) or Ken Burns (character scenes)
        y_offset = vscroll * self.v_pan_room
        frame = vertical_parallax_crop(self.tall_canvas, y_offset, self.W, self.H)
        if self.unified and self.depth_speed_map is not None:
            # 2.5D depth pan: per-pixel shift based on depth map
            cam_tx_px, cam_ty_px = _pan_pos(t, self.duration, self.emotion)
            cam_tx_px += shx
            dy0 = int(clamp(y_offset, 0, self.v_pan_room))
            frame = _depth_warp(frame, self.depth_speed_map[dy0:dy0 + self.H],
                                self.depth_grid_x, self.depth_grid_y, cam_tx_px, cam_ty_px)
        else:
            frame = warp_zoom_translate(frame, zoom, 0.5, self.camera.cy,
                                        -0.3 * tx, 0)

        # 2. Midground: AO + shadow + character (1.0x camera speed)
        if self.char is not None:
            frame = self._composite_character(frame, t, fi, tx)

        # 3. Foreground atmosphere at 1.5x camera speed
        self.particles.step(dt, self.wind)
        self.particles.draw(frame, t, fg_dx=-1.5 * tx)

        # 4. Handheld shake (camera-level: moves all layers equally)
        if abs(shx) > 0.2 or abs(shy) > 0.2:
            M = np.float32([[1, 0, shx], [0, 1, shy]])
            frame = cv2.warpAffine(frame, M, (self.W, self.H),
                                   borderMode=cv2.BORDER_REPLICATE)

        # 5. Emotion grade (half-res, blends in over the first 1.5s)
        blend = clamp(t / 1.5, 0, 1)
        frame = apply_emotion_grade(frame, self.emotion, blend)

        # 6. Vignette + light flicker (one float pass) + grain
        frame = apply_vignette_flicker(frame, self.vignette_mask, t)
        frame = add_grain_from_bank(frame, self.grain_bank, fi)

        # 8. Transition halves at the clip edges
        if self.head_frames > 0 and fi < self.head_frames:
            p = fi / self.head_frames
            frame = self.fx.trans_in(frame, p, self.in_kind, fi)
        elif self.tail_frames > 0 and fi >= self.total_frames - self.tail_frames:
            p = (fi - (self.total_frames - self.tail_frames) + 1) / self.tail_frames
            frame = self.fx.trans_out(frame, p, self.out_kind, fi)

        return frame

# ═══════════════════════════════════════════════════════════════════════════
# VIDEO OUTPUT
# ═══════════════════════════════════════════════════════════════════════════

# This clip is an intermediate: assembleSceneSegment re-encodes it to the export
# resolution, so what matters here is being cheap and faithful, not small.
#
# ultrafast, measured, is the whole point. The engine's synthesised film grain is
# expensive to compress, and a slower preset spends that cost on the render's critical
# path: veryfast made frame synthesis 88.9s -> 118.8s across a five-scene episode, which
# swallowed the ~22s the collapsed encode tail saves and left the render 24s SLOWER than
# before any of this. ultrafast encodes at roughly the speed of the cv2 writer it
# replaces while still producing real h264 at a controlled rate — the point being to stop
# cv2 emitting 50 Mbps mp4v, not to win a compression contest against a file that is
# deleted minutes later.
ENCODE_CRF = int(os.environ.get('METRO_V4_CRF', '18'))
ENCODE_PRESET = os.environ.get('METRO_V4_PRESET', 'ultrafast')
ENCODER_TIMEOUT_S = 300      # draining a few hundred queued frames, not a whole render


class FFmpegPipeWriter:
    """Frame sink that pipes raw BGR straight into ffmpeg instead of cv2.VideoWriter.

    cv2's writer gives no bitrate control: it turned 276 frames into 71 MB, and a
    five-scene episode into 188 MB of intermediates that downstream re-encodes to 30 MB.
    Every one of those megabytes is a write and a read on a laptop disk. Encoding
    here at a real CRF costs a little CPU inside a worker (which is parallel) to
    remove I/O from the serial part of the render.

    It also removes the avc1/mp4v uncertainty: whichever codec OpenCV happened to
    ship with decided the segment's stream parameters, which is what made the
    parallel-join `-c copy` a gamble worth a fallback.

    Drop-in for the cv2 writer: .write(frame) / .release().
    """

    def __init__(self, path: str, fps: int, w: int, h: int):
        self.path = path
        self.w, self.h = w, h
        self._err_path = path + '.enc.log'
        self._err = open(self._err_path, 'wb')
        # stderr goes to a file, never a pipe: nothing drains a pipe while we are
        # blocked writing frames, so a chatty ffmpeg would deadlock the render.
        self.proc = subprocess.Popen(
            [_ffmpeg_bin(), '-hide_banner', '-loglevel', 'error', '-y',
             '-f', 'rawvideo', '-pix_fmt', 'bgr24',
             '-s', f'{w}x{h}', '-r', str(fps), '-i', 'pipe:0',
             '-an', '-c:v', 'libx264', '-preset', ENCODE_PRESET,
             '-crf', str(ENCODE_CRF), '-pix_fmt', 'yuv420p', path],
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=self._err)
        self.closed = False

    def write(self, frame: np.ndarray):
        if frame.shape[0] != self.h or frame.shape[1] != self.w:
            raise RuntimeError(
                f'frame {frame.shape[1]}x{frame.shape[0]} != writer {self.w}x{self.h}')
        try:
            # tobytes() already copies, and returns C-order regardless of the view.
            self.proc.stdin.write(frame.tobytes())
        except (BrokenPipeError, OSError) as exc:
            raise RuntimeError(f'ffmpeg closed the pipe early: {self._tail()}') from exc

    def release(self):
        """Close the pipe and wait. Raises if ffmpeg failed — a half-written mp4
        must not be left behind looking like a finished clip."""
        if self.closed:
            return
        self.closed = True
        try:
            if self.proc.stdin and not self.proc.stdin.closed:
                self.proc.stdin.close()
        except OSError:
            pass
        try:
            code = self.proc.wait(timeout=ENCODER_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()
            code = -1
        self._err.close()
        if code != 0:
            self._discard()
            raise RuntimeError(f'ffmpeg encode failed ({code}): {self._tail()}')
        try:
            os.remove(self._err_path)
        except OSError:
            pass

    def abort(self):
        """Tear down without raising — for the error path, so no ffmpeg outlives us."""
        if self.closed:
            return
        self.closed = True
        for closer in (lambda: self.proc.stdin and self.proc.stdin.close(),
                       self.proc.kill, self.proc.wait, self._err.close):
            try:
                closer()
            except Exception:
                pass
        self._discard()

    def _discard(self):
        """Remove the partial output so no later freshness check mistakes it for real."""
        try:
            if os.path.exists(self.path):
                os.remove(self.path)
        except OSError:
            pass

    def _tail(self) -> str:
        try:
            self._err.flush()
        except Exception:
            pass
        try:
            with open(self._err_path, 'rb') as fh:
                return fh.read()[-400:].decode('utf-8', 'replace').strip()
        except OSError:
            return '(no encoder output)'


def open_writer(path: str, fps: int, w: int, h: int):
    """Open the frame sink. Returns (writer, label) — the label is only for logging."""
    return FFmpegPipeWriter(path, fps, w, h), f'libx264 crf{ENCODE_CRF} (piped)'

# ═══════════════════════════════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════════════════════════════

def _worker_count(total_frames: int) -> int:
    """How many processes to split a clip across.

    Auto-detected, not pinned to this machine's 4 cores. METRO_V4_WORKERS
    overrides; 1 forces the sequential path. Short clips stay sequential because
    each worker re-imports the module and rebuilds the renderer (Windows spawns
    rather than forks), which costs more than it saves below a few seconds.
    """
    override = os.environ.get('METRO_V4_WORKERS')
    if override:
        try:
            return max(1, int(override))
        except ValueError:
            pass
    if total_frames < MIN_FRAMES_FOR_PARALLEL:
        return 1
    return max(1, min(os.cpu_count() or 1, MAX_AUTO_WORKERS))


MIN_FRAMES_FOR_PARALLEL = 48   # ~2s at 24fps; below this, spawn overhead dominates
MAX_AUTO_WORKERS = 4           # ceiling: each worker holds its own canvas + depth map
WORKER_TIMEOUT_S = 900         # a wedged worker must not hang the render forever


def _render_range(job):
    """Render frames [start, end) in a worker process and write one segment.

    Each worker builds its own renderer. The depth map is read from the .npy cache
    written by the first process to need it, so this costs a disk read rather than
    a second Depth-Anything inference — see _gen_depth.
    """
    (start, end, seg_path, background, char_path, duration, emotion, scene_type,
     prev_t, next_t, seed, idle, w, h, fps) = job

    char_rgba = None
    if char_path and os.path.exists(char_path):
        loaded = cv2.imread(char_path, cv2.IMREAD_UNCHANGED)
        if loaded is not None and loaded.ndim == 3 and loaded.shape[2] == 4:
            char_rgba = loaded

    cfg = EngineConfig(w=w, h=h, fps=fps)
    renderer = SceneRendererV4(
        cfg, background, char_rgba, duration, emotion, scene_type,
        prev_scene_type=prev_t, next_scene_type=next_t, seed=seed, idle=idle)

    # Catch the particle system up to this range's first frame, or the seam shows.
    renderer.particles.warm_to(start, 1.0 / cfg.fps, renderer.wind)

    writer, _ = open_writer(seg_path, fps, w, h)
    try:
        for fi in range(start, end):
            writer.write(renderer.render(fi))
        writer.release()
    except BaseException:
        # abort(), not release(): kill the encoder and delete the partial segment, so a
        # failed range can never be concatenated as if it were complete.
        writer.abort()
        raise
    return (start, seg_path)


def _concat_segments(segments, output, fps, w, h):
    """Join the per-worker segments in frame order — stream-copied, never re-encoded.

    Every segment now comes from the same FFmpegPipeWriter invocation with identical
    encoder settings, so the streams are copy-compatible by construction. This used to
    be a gamble (cv2 chose the codec) and re-encoding the join cost 19s of a 59s
    render — a third of it, serial, undoing much of the parallel gain.

    The re-encode fallback below stays as a safety net only. It must never become the
    normal path: if you see its log line, something upstream changed the writer.
    """
    list_path = output + '.concat.txt'
    with open(list_path, 'w', encoding='utf-8') as fh:
        for _, seg in segments:
            fh.write(f"file '{seg.replace(chr(92), '/')}'\n")
    base = [_ffmpeg_bin(), '-hide_banner', '-loglevel', 'error', '-y',
            '-f', 'concat', '-safe', '0', '-i', list_path]
    copy_ok = False
    try:
        subprocess.run(base + ['-c', 'copy', '-movflags', '+faststart', output],
                       check=True)
        copy_ok = os.path.exists(output) and os.path.getsize(output) > 10000
    except subprocess.CalledProcessError:
        copy_ok = False
    if not copy_ok:
        print('[MetroV4] Segment copy failed — re-encoding the join', file=sys.stderr)
        subprocess.run(base + ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
                               '-pix_fmt', 'yuv420p', '-r', str(fps), output],
                       check=True)
    for path in [list_path] + [s for _, s in segments]:
        try:
            os.remove(path)
        except OSError:
            pass


def _ffmpeg_bin() -> str:
    """The bundled ffmpeg the rest of the pipeline uses, or PATH as a fallback."""
    candidate = os.path.join(
        os.getcwd(), 'node_modules', 'ffmpeg-static',
        'ffmpeg.exe' if os.name == 'nt' else 'ffmpeg')
    return candidate if os.path.exists(candidate) else 'ffmpeg'


def main():
    parser = argparse.ArgumentParser(
        description='Metro Engine V4 — cinematic scene animator')
    parser.add_argument('--background', required=True)
    parser.add_argument('--character', default='',
                        help='Transparent character PNG; empty = unified mode')
    parser.add_argument('--output', required=True)
    parser.add_argument('--duration', type=float, required=True)
    # NOTE: no choices= — unknown values map to defaults instead of exit(2)
    parser.add_argument('--emotion', default='neutral')
    parser.add_argument('--scene_type', default='street')
    parser.add_argument('--camera', default='',
                        help='Accepted for v3 CLI compatibility (camera is '
                             'emotion-driven in V4)')
    parser.add_argument('--fps', type=int, default=24)
    parser.add_argument('--width', type=int, default=1080)
    parser.add_argument('--height', type=int, default=1920)
    parser.add_argument('--prev_scene_type', default='')
    parser.add_argument('--next_scene_type', default='')
    parser.add_argument('--seed', type=int, default=42)
    parser.add_argument('--no_idle', action='store_true')
    args = parser.parse_args()

    if not os.path.exists(args.background):
        print(f'[MetroV4] ERROR: background not found: {args.background}',
              file=sys.stderr)
        sys.exit(1)
    if args.duration <= 0:
        print('[MetroV4] ERROR: duration must be > 0', file=sys.stderr)
        sys.exit(1)

    emotion = args.emotion if args.emotion in EMOTION_PALETTES else 'neutral'
    scene_type = args.scene_type if args.scene_type in PARTICLE_MAP else 'default'

    char_rgba = None
    if args.character and os.path.exists(args.character):
        loaded = cv2.imread(args.character, cv2.IMREAD_UNCHANGED)
        if loaded is not None and loaded.ndim == 3 and loaded.shape[2] == 4:
            char_rgba = loaded
        else:
            print('[MetroV4] WARNING: character PNG has no alpha — '
                  'switching to unified mode')

    t0 = time.time()
    print('[MetroV4] Starting v4 render')
    print(f'[MetroV4] Background: {os.path.basename(args.background)}')
    print(f'[MetroV4] Character: '
          f'{os.path.basename(args.character) if char_rgba is not None else "none (unified)"}')
    print(f'[MetroV4] Duration: {args.duration}s @ {args.fps}fps')
    print(f'[MetroV4] Emotion: {emotion} | Scene type: {scene_type}')
    if args.prev_scene_type or args.next_scene_type:
        print(f'[MetroV4] Transitions: in<-{args.prev_scene_type or "-"} '
              f'out->{args.next_scene_type or "-"}')

    cfg = EngineConfig(w=args.width, h=args.height, fps=args.fps)
    renderer = SceneRendererV4(
        cfg, args.background, char_rgba, args.duration,
        emotion, scene_type,
        prev_scene_type=args.prev_scene_type,
        next_scene_type=args.next_scene_type,
        seed=args.seed, idle=not args.no_idle)

    if char_rgba is not None:
        print(f'[MetroV4] Light dx: {renderer.light_dx:+.2f} | '
              f'shadow opacity: {renderer.shadow_opacity:.2f}')

    os.makedirs(os.path.dirname(args.output) or '.', exist_ok=True)
    total = renderer.total_frames
    workers = _worker_count(total)

    if workers > 1:
        # Contiguous ranges, not interleaved: each worker writes one playable
        # segment, and the particle warm-up it has to replay stays bounded.
        step_n = math.ceil(total / workers)
        ranges = [(s, min(s + step_n, total)) for s in range(0, total, step_n)]
        jobs = [
            (s, e, f'{args.output}.part{i:02d}.mp4', args.background, args.character,
             args.duration, emotion, scene_type, args.prev_scene_type,
             args.next_scene_type, args.seed, not args.no_idle,
             args.width, args.height, args.fps)
            for i, (s, e) in enumerate(ranges)
        ]
        print(f'[MetroV4] Rendering {total} frames across {len(jobs)} processes '
              f'({os.cpu_count()} cores detected)...')

        pool = mp.Pool(processes=len(jobs))
        try:
            # A wedged worker must not hang the render forever; the pool is torn
            # down in finally so no strays outlive this process either way.
            segments = pool.map_async(_render_range, jobs).get(WORKER_TIMEOUT_S)
        except mp.TimeoutError:
            pool.terminate(); pool.join()
            print(f'[MetroV4] ERROR: frame workers exceeded {WORKER_TIMEOUT_S}s',
                  file=sys.stderr)
            sys.exit(1)
        except Exception as exc:
            pool.terminate(); pool.join()
            print(f'[MetroV4] ERROR: frame worker failed: {exc}', file=sys.stderr)
            sys.exit(1)
        else:
            pool.close(); pool.join()

        t_workers = time.time() - t0
        segments.sort(key=lambda item: item[0])   # frame order, not completion order
        t_join = time.time()
        _concat_segments(segments, args.output, args.fps, args.width, args.height)
        print(f'[MetroV4] Workers: {t_workers:.1f}s | join: {time.time() - t_join:.1f}s')
        print(f'[MetroV4] Joined {len(segments)} segments')
    else:
        writer, codec = open_writer(args.output, args.fps, args.width, args.height)
        print(f'[MetroV4] Codec: {codec}')
        print(f'[MetroV4] Rendering {total} frames (sequential)...')
        # Stream frames straight to the writer — no full-episode frame list in RAM
        try:
            for fi in range(total):
                writer.write(renderer.render(fi))
                if fi and fi % 96 == 0:
                    print(f'[MetroV4] ... {fi}/{total} frames')
            writer.release()
        except BaseException:
            writer.abort()
            raise

    if not os.path.exists(args.output) or os.path.getsize(args.output) < 10000:
        print('[MetroV4] ERROR: output missing or too small', file=sys.stderr)
        sys.exit(1)

    elapsed = time.time() - t0
    size_kb = os.path.getsize(args.output) // 1024
    ms_per_frame = elapsed / renderer.total_frames * 1000
    print('[MetroV4] Complete!')
    print(f'[MetroV4] Frames: {renderer.total_frames}')
    print(f'[MetroV4] Output: {args.output}')
    print(f'[MetroV4] Size: {size_kb}KB')
    print(f'[MetroV4] Time: {elapsed:.1f}s ({ms_per_frame:.0f}ms/frame)')
    sys.exit(0)


if __name__ == '__main__':
    main()
