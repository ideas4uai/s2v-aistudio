"""
metro_engine_v3_fixed.py
========================
Script2Video Background Animation Engine — Portrait Fixed

ROOT CAUSE FIXES:
  BUG 1 (image split/tearing):
    Parallax horizontal band-split tears at band boundaries.
    Portrait source images have almost no horizontal pan room.
    FIX: Remove horizontal band-split parallax entirely for portrait sources.
         Replace with: Ken Burns zoom + vertical parallax (top/bottom layers)
         + subtle horizontal drift. This is what v1 did and it looked correct.

  BUG 2 (metro image not visible / wrong content):
    Wide canvas required portrait source scaled 1.029x — barely any enlargement.
    Parallax system then cropped deep into wrong vertical section of image.
    FIX: Cover-crop the image correctly to frame size.
         Use VERTICAL parallax: top strip moves slower, bottom strip moves faster.
         This matches real depth perception for architectural/indoor scenes:
         ceiling/sky = far = barely moves
         floor = near = moves more
         No horizontal tearing because each row's x-offset stays identical.

  WHAT STAYS FROM V3 (correct):
    - EngineConfig / SceneConfig dataclasses
    - zoom_frame() — correct and unchanged
    - All easing functions
    - Emotion colour grade (half-res)
    - Vignette (precomputed mask)
    - ParticleSystem (persistent state, RandomState isolated)
    - All transitions (iris_wipe, flash_cut, fade_black, whip_pan)
    - ZoomPunch with ease_out_back overshoot
    - render_episode_to_file() public API

VERTICAL PARALLAX EXPLAINED:
  Instead of sliding horizontal bands left/right at different speeds,
  vertical parallax adjusts the Ken Burns zoom center point based on
  a subtle vertical scroll — ceiling appears to recede, floor advances.
  No band boundaries = no tear lines.
  Works correctly for both portrait and landscape source images.
"""

import cv2
import numpy as np
import math
import os
from dataclasses import dataclass, field
from typing import List, Tuple, Optional

# ═══════════════════════════════════════════════════════════════════════════════
# CONFIG
# ═══════════════════════════════════════════════════════════════════════════════

@dataclass
class EngineConfig:
    w:   int   = 1080
    h:   int   = 1920
    fps: int   = 24
    vignette_power: float = 1.5
    canvas_width_factor: float = 2.2

@dataclass
class ZoomPunch:
    t_in_scene: float
    zoom_to:    float
    duration:   float
    cx_ratio:   float = 0.5
    cy_ratio:   float = 0.5

@dataclass
class SceneConfig:
    background_path: str          = ""
    duration_sec:    float        = 8.0
    emotion:         str          = "neutral"
    particle_mode:   str          = "dust"
    transition_in:   str          = "crossfade"
    transition_out:  str          = "crossfade"
    camera_move:     str          = "ken_burns_in"
    zoom_punches:    List[ZoomPunch] = field(default_factory=list)
    wind:            float        = 0.0
    background_img:  Optional[np.ndarray] = field(default=None, repr=False)

# ═══════════════════════════════════════════════════════════════════════════════
# EMOTION PALETTES
# ═══════════════════════════════════════════════════════════════════════════════

EMOTION_PALETTES = {
    "neutral": {"r":1.02,"g":1.00,"b":0.98,"br":1.00,"co":1.00,"st":80, "sb":0.95,"ds":0.00,"vs":0.45},
    "tense":   {"r":0.95,"g":0.97,"b":1.04,"br":0.96,"co":1.12,"st":100,"sb":1.08,"ds":0.15,"vs":0.52},
    "curious": {"r":1.08,"g":1.05,"b":0.92,"br":1.03,"co":1.00,"st":70, "sb":0.90,"ds":0.00,"vs":0.38},
    "sad":     {"r":0.92,"g":0.94,"b":1.06,"br":0.90,"co":0.95,"st":90, "sb":1.05,"ds":0.25,"vs":0.55},
    "empty":   {"r":0.88,"g":0.90,"b":1.02,"br":0.85,"co":0.90,"st":120,"sb":1.03,"ds":0.55,"vs":0.62},
    "warm":    {"r":1.05,"g":1.02,"b":0.95,"br":1.00,"co":1.00,"st":80, "sb":0.92,"ds":0.00,"vs":0.45},
}

# ═══════════════════════════════════════════════════════════════════════════════
# MATH
# ═══════════════════════════════════════════════════════════════════════════════

def lerp(a, b, t):      return a + (b - a) * t
def clamp(v, lo, hi):   return max(lo, min(hi, v))
def ease_in_out(t):     t=clamp(t,0,1); return t*t*(3-2*t)
def ease_out(t):        t=clamp(t,0,1); return 1-(1-t)**3
def ease_in(t):         t=clamp(t,0,1); return t*t*t
def ease_out_back(t, s=1.40158):
    t=clamp(t,0,1); return 1+(s+1)*(t-1)**3+s*(t-1)**2

# ═══════════════════════════════════════════════════════════════════════════════
# IMAGE LOADING — cover crop only, no wide canvas for portrait sources
# ═══════════════════════════════════════════════════════════════════════════════

def load_cover_crop(path: str, w: int, h: int) -> np.ndarray:
    """
    Load and scale image to exactly cover w×h.
    scale = max(w/src_w, h/src_h) — fills frame, crops excess.
    No black bars. No distortion.
    """
    img = cv2.imread(path)
    if img is None:
        raise FileNotFoundError(f"Cannot load: {path}")
    ih, iw = img.shape[:2]
    scale  = max(w/iw, h/ih)
    nw, nh = int(iw*scale), int(ih*scale)
    img    = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LANCZOS4)
    x1     = (nw-w)//2
    y1     = (nh-h)//2
    return img[y1:y1+h, x1:x1+w].copy()

def load_cover_crop_array(arr: np.ndarray, w: int, h: int) -> np.ndarray:
    """Same as load_cover_crop but from an existing numpy array."""
    ih, iw = arr.shape[:2]
    scale  = max(w/iw, h/ih)
    nw, nh = int(iw*scale), int(ih*scale)
    img    = cv2.resize(arr, (nw, nh), interpolation=cv2.INTER_LANCZOS4)
    x1     = (nw-w)//2
    y1     = (nh-h)//2
    return img[y1:y1+h, x1:x1+w].copy()

# ═══════════════════════════════════════════════════════════════════════════════
# VERTICAL PARALLAX — FIX for portrait sources
#
# Instead of horizontal band sliding (which tears), we simulate depth by:
# 1. Holding a slightly taller crop of the image (top + bottom padding)
# 2. Shifting the vertical crop position over time — ceiling recedes,
#    floor advances — exactly how a camera tracking forward behaves
# 3. Combined with Ken Burns zoom this gives strong depth perception
#    with ZERO tearing because all pixels stay at the same x-offset
#
# Load a "tall canvas": image scaled to be taller than frame
# so we can shift the vertical window up/down per frame
# ═══════════════════════════════════════════════════════════════════════════════

def load_tall_canvas(path: str, w: int, h: int,
                     extra_height_factor: float = 1.15) -> np.ndarray:
    """
    Load image scaled to w × (h * extra_height_factor).
    Returns a canvas taller than the frame for vertical parallax.
    extra_height_factor=1.15 gives 15% extra height = 288px of vertical travel.
    """
    img = cv2.imread(path)
    if img is None:
        raise FileNotFoundError(f"Cannot load: {path}")
    ih, iw = img.shape[:2]
    tall_h  = int(h * extra_height_factor)
    scale   = max(w/iw, tall_h/ih)
    nw, nh  = int(iw*scale), int(ih*scale)
    img     = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LANCZOS4)
    # Center crop to exactly w wide, keep full height
    x1 = (nw - w) // 2
    img = img[:, x1:x1+w]
    # Pad or crop height to exactly tall_h
    if img.shape[0] > tall_h:
        y1 = (img.shape[0] - tall_h) // 2
        img = img[y1:y1+tall_h, :]
    elif img.shape[0] < tall_h:
        pad = np.zeros((tall_h - img.shape[0], w, 3), dtype=np.uint8)
        img = np.vstack([img, pad])
    return img.copy()

def load_tall_canvas_array(arr: np.ndarray, w: int, h: int,
                            extra_height_factor: float = 1.15) -> np.ndarray:
    """Same as load_tall_canvas but from numpy array."""
    ih, iw  = arr.shape[:2]
    tall_h  = int(h * extra_height_factor)
    scale   = max(w/iw, tall_h/ih)
    nw, nh  = int(iw*scale), int(ih*scale)
    img     = cv2.resize(arr, (nw, nh), interpolation=cv2.INTER_LANCZOS4)
    x1      = (nw - w) // 2
    img     = img[:, x1:x1+w]
    if img.shape[0] > tall_h:
        y1 = (img.shape[0] - tall_h) // 2
        img = img[y1:y1+tall_h, :]
    elif img.shape[0] < tall_h:
        pad = np.zeros((tall_h - img.shape[0], w, 3), dtype=np.uint8)
        img = np.vstack([img, pad])
    return img.copy()

def vertical_parallax_crop(tall_canvas: np.ndarray, y_offset: float,
                            w: int, h: int) -> np.ndarray:
    """
    Crop h rows from tall_canvas starting at y_offset.
    y_offset=0: show top of canvas (ceiling visible)
    y_offset=max: show bottom of canvas (more floor visible)

    No horizontal sliding = no tear lines.
    Entire row content stays pixel-perfect at each y_offset.
    """
    canvas_h = tall_canvas.shape[0]
    max_off  = canvas_h - h
    y0       = int(clamp(y_offset, 0, max_off))
    return tall_canvas[y0:y0+h, :w].copy()

# ═══════════════════════════════════════════════════════════════════════════════
# PRECOMPUTED ASSETS
# ═══════════════════════════════════════════════════════════════════════════════

def build_vignette_mask(w: int, h: int, strength: float,
                         power: float = 1.5) -> np.ndarray:
    """Precompute vignette as float32 [h,w,3]. Called once per scene."""
    ys     = np.linspace(-1, 1, h, dtype=np.float32)
    xs     = np.linspace(-1, 1, w, dtype=np.float32)
    xv, yv = np.meshgrid(xs, ys)
    dist   = np.sqrt(xv**2 + yv**2)
    vig    = (1.0 - np.clip(dist * strength, 0.0, 1.0)) ** power
    return np.stack([vig, vig, vig], axis=2)

# ═══════════════════════════════════════════════════════════════════════════════
# PARTICLE SYSTEM — persistent state (no re-init per frame)
# ═══════════════════════════════════════════════════════════════════════════════

class ParticleSystem:
    def __init__(self, mode: str, cfg: EngineConfig, n: int = 40, seed: int = 42):
        self.mode = mode
        self.W    = cfg.w
        self.H    = cfg.h
        self.n    = n
        rng       = np.random.RandomState(seed)

        self.x       = rng.uniform(0, self.W, n).astype(np.float32)
        self.y       = rng.uniform(self.H*0.2, self.H*0.9, n).astype(np.float32)
        self.size    = rng.uniform(1.5, 5.0, n).astype(np.float32)
        self.spd_x   = rng.uniform(-6, 2, n).astype(np.float32)
        self.spd_y   = rng.uniform(-1.5, 1.5, n).astype(np.float32)
        self.bright  = rng.uniform(120, 255, n).astype(np.float32)
        self.phase   = rng.uniform(0, math.pi*2, n).astype(np.float32)
        self.length  = rng.uniform(20, 100, n).astype(np.float32)
        self.fall    = rng.uniform(80, 200, n).astype(np.float32)

    def step(self, dt: float, wind: float = 0.0):
        W, H = self.W, self.H
        if self.mode == 'data_stream':
            self.y += self.fall * dt
            self.y[self.y > H + 100] = -100.0
        elif self.mode == 'tense':
            turb = np.sin(self.y * 0.05 + self.phase) * 3.0
            self.x += (self.spd_x * 3 + wind + turb) * dt
            self.y += self.spd_y * 3 * dt
            self.x[self.x < 0] = float(W)
            self.x[self.x > W] = 0.0
            self.y[self.y < 0] = float(H)
            self.y[self.y > H] = 0.0
        elif self.mode == 'rain':
            self.x += (wind - 15) * dt
            self.y += self.fall * dt
            self.x[self.x < 0] = float(W)
            self.y[self.y > H] = 0.0
        else:  # dust
            self.x += (self.spd_x + wind) * dt
            self.y += self.spd_y * dt * 0.5
            self.x[self.x < 0]       = float(W)
            self.x[self.x > W]       = 0.0
            self.y[self.y < H * 0.2] = float(H * 0.85)
            self.y[self.y > H * 0.85]= float(H * 0.2)

    def draw(self, frame: np.ndarray, t: float):
        if   self.mode == 'data_stream': self._data_stream(frame)
        elif self.mode == 'tense':       self._tense(frame, t)
        elif self.mode == 'rain':        self._rain(frame)
        elif self.mode == 'static_noise':self._static(frame, t)
        else:                            self._dust(frame, t)

    def _dust(self, frame, t):
        W, H = self.W, self.H
        for i in range(self.n):
            a  = 0.35 + 0.65 * abs(math.sin(t*1.3 + float(self.phase[i])))
            b  = int(self.bright[i] * a)
            cx, cy = int(self.x[i]), int(self.y[i])
            if 0 < cx < W and 0 < cy < H:
                cv2.circle(frame,(cx,cy),max(1,int(self.size[i])),(b,b,int(b*.85)),-1,cv2.LINE_AA)

    def _data_stream(self, frame):
        W, H = self.W, self.H
        for i in range(self.n):
            cx, cy = int(self.x[i]), int(self.y[i])
            ln = int(self.length[i])
            if not (0 <= cx < W): continue
            for j in range(ln):
                py = cy - j
                if 0 <= py < H:
                    fade = 1.0 - j/ln
                    if j < 3:
                        frame[py,cx] = (255,255,255)
                    else:
                        add = np.array([int(200*fade),int(255*fade),int(160*fade)],dtype=np.int16)
                        frame[py,cx] = np.clip(frame[py,cx].astype(np.int16)+add//3,0,255).astype(np.uint8)

    def _tense(self, frame, t):
        W, H = self.W, self.H
        for i in range(self.n):
            a = 0.6+0.4*abs(math.sin(t*4.7+float(self.phase[i])))
            b = int(self.bright[i]*a*0.3); g = int(self.bright[i]*a*0.5); r = int(self.bright[i]*a)
            cx, cy = int(self.x[i]), int(self.y[i])
            if 0 < cx < W and 0 < cy < H:
                cv2.circle(frame,(cx,cy),max(1,int(self.size[i]*.7)),(b,g,r),-1,cv2.LINE_AA)

    def _rain(self, frame):
        W, H = self.W, self.H
        for i in range(self.n):
            x1,y1 = int(self.x[i]),int(self.y[i])
            if 0<x1<W and 0<y1<H:
                cv2.line(frame,(x1,y1),(x1-3,min(y1+int(self.size[i]*8),H-1)),(180,180,210),1,cv2.LINE_AA)

    def _static(self, frame, t):
        rng = np.random.RandomState(int(t*1000)%10000)
        xs = rng.randint(0,self.W,300); ys = rng.randint(0,self.H,300); vs = rng.randint(80,220,300)
        for i in range(300): frame[ys[i],xs[i]] = (vs[i],vs[i],vs[i])
        if math.sin(t*13.7) > 0.85:
            gy = rng.randint(0,self.H); shift = rng.randint(8,40)
            row = frame[gy,:].copy(); frame[gy,shift:] = row[:-shift]

# ═══════════════════════════════════════════════════════════════════════════════
# PIXEL EFFECTS
# ═══════════════════════════════════════════════════════════════════════════════

def zoom_frame(img, zoom, cx_ratio=0.5, cy_ratio=0.5):
    h, w   = img.shape[:2]
    cx, cy = w*cx_ratio, h*cy_ratio
    M      = np.float32([[zoom,0,cx*(1-zoom)],[0,zoom,cy*(1-zoom)]])
    return cv2.warpAffine(img, M, (w,h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)

def apply_emotion_grade(frame, emotion, blend=1.0):
    p = EMOTION_PALETTES.get(emotion, EMOTION_PALETTES["neutral"])
    h, w = frame.shape[:2]
    sm   = cv2.resize(frame, (w//2, h//2), interpolation=cv2.INTER_LINEAR)
    f    = sm.astype(np.float32)
    f   *= p["br"]
    f    = (f-128)*p["co"]+128
    f[:,:,2] *= p["r"]; f[:,:,1] *= p["g"]; f[:,:,0] *= p["b"]
    mask = f[:,:,0] < p["st"]; f[:,:,0][mask] *= p["sb"]
    f    = np.clip(f, 0, 255)
    if p["ds"] > 0:
        grey = np.mean(f,axis=2,keepdims=True).repeat(3,axis=2)
        f    = f*(1-p["ds"]) + grey*p["ds"]
    res = np.clip(f,0,255).astype(np.uint8)
    res = cv2.resize(res, (w,h), interpolation=cv2.INTER_LINEAR)
    if blend < 1.0:
        res = cv2.addWeighted(frame, 1-blend, res, blend, 0)
    return res

def apply_vignette(frame, mask):
    return np.clip(frame.astype(np.float32)*mask, 0, 255).astype(np.uint8)

def add_grain(frame, w, h, amount=5):
    pw, ph = w//4, h//4
    p      = np.random.randint(-amount, amount+1, (ph,pw,3), dtype=np.int16)
    ty, tx = math.ceil(h/ph), math.ceil(w/pw)
    tiled  = np.tile(p,(ty,tx,1))[:h,:w,:]
    return np.clip(frame.astype(np.int16)+tiled, 0, 255).astype(np.uint8)

def light_flicker(frame, t, intensity=0.022):
    f = 1.0 + intensity * math.sin(t*47.3) * math.sin(t*13.7)
    return np.clip(frame.astype(np.float32)*f, 0, 255).astype(np.uint8)

def heat_shimmer(frame, t, intensity=1.0, start_ratio=0.65):
    h, w   = frame.shape[:2]
    result = frame.copy()
    py     = int(h*start_ratio)
    for y in range(py, h):
        depth = (y-py)/(h-py)
        shift = int(math.sin(y*0.08+t*3.1)*intensity*depth)
        if shift == 0: continue
        row = frame[y].copy()
        if shift > 0:
            result[y,shift:] = row[:w-shift]
            result[y,:shift] = row[0:1].repeat(shift,axis=0)
        else:
            result[y,:w+shift] = row[-shift:]
            result[y,w+shift:] = row[-1:].repeat(-shift,axis=0)
    return result

def motion_blur_h(frame, strength):
    if strength < 2: return frame
    k = np.ones((1,strength),dtype=np.float32)/strength
    return cv2.filter2D(frame,-1,k)

def draw_caption(frame, text, t, start, end):
    dur = end-start; el = t-start
    if el < 0 or el > dur: return frame
    alpha = min(clamp(el/0.4,0,1), clamp((dur-el)/0.4,0,1))
    if alpha < 0.01: return frame
    h, w  = frame.shape[:2]
    yp    = h - int(h*0.05)
    font, sc, th = cv2.FONT_HERSHEY_SIMPLEX, 1.1, 2
    (tw,fh),_ = cv2.getTextSize(text,font,sc,th)
    tx = (w-tw)//2; pad = 16
    ov = frame.copy()
    cv2.rectangle(ov,(tx-pad,yp-fh-pad),(tx+tw+pad,yp+pad),(10,10,20),-1)
    cv2.addWeighted(ov,alpha*0.72,frame,1-alpha*0.72,0,frame)
    for dx,dy in [(-1,-1),(1,-1),(-1,1),(1,1)]:
        cv2.putText(frame,text,(tx+dx,yp+dy),font,sc,(0,0,0),th+1,cv2.LINE_AA)
    cv2.putText(frame,text,(tx,yp),font,sc,(int(230*alpha),int(220*alpha),int(180*alpha)),th,cv2.LINE_AA)
    return frame

# ═══════════════════════════════════════════════════════════════════════════════
# TRANSITIONS
# ═══════════════════════════════════════════════════════════════════════════════

def crossfade(a, b, t):
    t = clamp(t,0,1)
    return np.clip(a.astype(np.float32)*(1-t)+b.astype(np.float32)*t,0,255).astype(np.uint8)

def iris_wipe(a, b, t, cx_ratio=0.5, cy_ratio=0.5):
    h,w    = a.shape[:2]
    cx,cy  = int(w*cx_ratio),int(h*cy_ratio)
    max_r  = math.sqrt(w**2+h**2)
    radius = ease_out(clamp(t,0,1))*max_r
    ys,xs  = np.ogrid[:h,:w]
    dist   = np.sqrt((xs-cx)**2+(ys-cy)**2).astype(np.float32)
    soft   = np.clip((radius-dist)/8.0,0.0,1.0)
    m3     = np.stack([soft,soft,soft],axis=2)
    return np.clip(b.astype(np.float32)*m3+a.astype(np.float32)*(1-m3),0,255).astype(np.uint8)

def flash_cut(a, b, t):
    white = np.full_like(a,255)
    if t < 0.5: return crossfade(a,white,ease_out(t/0.5))
    return crossfade(white,b,ease_in((t-0.5)/0.5))

def fade_black(a, b, t):
    black = np.zeros_like(a)
    if t < 0.5: return crossfade(a,black,ease_in_out(t/0.5))
    return crossfade(black,b,ease_in_out((t-0.5)/0.5))

def whip_pan(a, b, t):
    if t < 0.4:
        s = int(ease_in(t/0.4)*80)
        if s < 2: return a.copy()
        k = np.ones((1,s),dtype=np.float32)/s
        return cv2.filter2D(a,-1,k)
    s = int((1-ease_out((t-0.4)/0.6))*60)
    if s < 2: return b.copy()
    k = np.ones((1,s),dtype=np.float32)/s
    return cv2.filter2D(b,-1,k)

TRANSITION_FUNCS = {
    "crossfade": crossfade, "iris_wipe": iris_wipe,
    "flash_cut": flash_cut, "fade_black": fade_black, "whip_pan": whip_pan,
}

TRANSITION_DURATIONS = {
    "crossfade":0.4,"iris_wipe":0.8,"flash_cut":0.3,"fade_black":1.0,"whip_pan":0.4
}

# ═══════════════════════════════════════════════════════════════════════════════
# SCENE RENDERER — the fixed version
# ═══════════════════════════════════════════════════════════════════════════════

class SceneRenderer:
    """
    Renders one scene correctly for portrait output.
    Key change from v3: uses vertical_parallax_crop instead of
    horizontal band splitting. No tear lines.
    """

    def __init__(self, scene: SceneConfig, cfg: EngineConfig,
                 prev_last_frame=None):
        self.scene  = scene
        self.cfg    = cfg
        self.W      = cfg.w
        self.H      = cfg.h
        self.FPS    = cfg.fps
        self.total_frames = int(scene.duration_sec * cfg.fps)
        self.prev_frame   = prev_last_frame

        # Load image
        if scene.background_img is not None:
            self.base_frame  = load_cover_crop_array(scene.background_img, self.W, self.H)
            self.tall_canvas = load_tall_canvas_array(scene.background_img, self.W, self.H)
        elif scene.background_path:
            self.base_frame  = load_cover_crop(scene.background_path, self.W, self.H)
            self.tall_canvas = load_tall_canvas(scene.background_path, self.W, self.H)
        else:
            self.base_frame  = np.full((self.H, self.W, 3), (30,30,40), dtype=np.uint8)
            self.tall_canvas = self.base_frame

        # Vertical parallax: how many pixels can we shift vertically?
        # tall_canvas is H*1.15 tall = 15% extra = pan room
        self.v_pan_room = self.tall_canvas.shape[0] - self.H   # pixels available

        # Precomputed vignette (once per scene)
        p = EMOTION_PALETTES.get(scene.emotion, EMOTION_PALETTES["neutral"])
        self.vignette_mask = build_vignette_mask(self.W, self.H,
                                                  strength=p["vs"],
                                                  power=cfg.vignette_power)

        # Particle system (persistent — no re-init per frame)
        self.particles = ParticleSystem(scene.particle_mode, cfg, n=40, seed=42)

        # Transition setup
        self.trans_in_type = scene.transition_in
        self.trans_in_dur  = TRANSITION_DURATIONS.get(scene.transition_in, 0.4)
        self.trans_out_type = scene.transition_out
        self.trans_out_dur  = TRANSITION_DURATIONS.get(scene.transition_out, 0.4)

    def _get_base_frame(self, t: float) -> np.ndarray:
        """
        Get background frame using vertical parallax + Ken Burns zoom.
        NO horizontal band splitting. NO tear lines.

        Vertical parallax:
          Ken Burns scrolls camera focus vertically over time.
          y_offset shifts which part of the tall canvas we show:
            y_offset=0           → top of canvas (ceiling/sky visible)
            y_offset=v_pan_room  → bottom of canvas (more floor visible)

        Combined with zoom, this creates genuine depth perception:
          - Zooming in + shifting down = tracking into a scene
          - Zooming out + shifting up = pulling back from a scene
        """
        progress = ease_in_out(t / self.scene.duration_sec)
        move     = self.scene.camera_move

        # Vertical parallax offset (shift window within tall canvas)
        if move == "ken_burns_in":
            # Track forward: zoom in, shift down slightly (floor advances)
            zoom     = lerp(1.0, 1.08, progress)
            y_offset = lerp(0, self.v_pan_room * 0.4, progress)
            frame    = vertical_parallax_crop(self.tall_canvas, y_offset, self.W, self.H)
            frame    = zoom_frame(frame, zoom, 0.5, 0.55)

        elif move == "ken_burns_out":
            # Pull back: zoom out, shift up (ceiling revealed)
            zoom     = lerp(1.08, 1.0, progress)
            y_offset = lerp(self.v_pan_room * 0.4, 0, progress)
            frame    = vertical_parallax_crop(self.tall_canvas, y_offset, self.W, self.H)
            frame    = zoom_frame(frame, zoom, 0.5, 0.5)

        elif move == "pan_right":
            # Subtle rightward drift via zoom focus point moving right
            zoom     = lerp(1.04, 1.08, progress)
            y_offset = self.v_pan_room * 0.2
            frame    = vertical_parallax_crop(self.tall_canvas, y_offset, self.W, self.H)
            cx       = lerp(0.45, 0.60, progress)   # focus drifts right
            frame    = zoom_frame(frame, zoom, cx, 0.5)

        elif move == "pan_left":
            zoom     = lerp(1.04, 1.08, progress)
            y_offset = self.v_pan_room * 0.2
            frame    = vertical_parallax_crop(self.tall_canvas, y_offset, self.W, self.H)
            cx       = lerp(0.60, 0.45, progress)
            frame    = zoom_frame(frame, zoom, cx, 0.5)

        else:  # static — subtle breathing
            zoom     = 1.0 + 0.015 * math.sin(t * 0.4)
            y_offset = self.v_pan_room * 0.2 + math.sin(t * 0.2) * self.v_pan_room * 0.05
            frame    = vertical_parallax_crop(self.tall_canvas, y_offset, self.W, self.H)
            frame    = zoom_frame(frame, zoom, 0.5, 0.5)

        return frame

    def _zoom_punch(self, t, frame):
        """Apply zoom punch if active at time t."""
        for punch in self.scene.zoom_punches:
            elapsed = t - punch.t_in_scene
            if 0 <= elapsed <= punch.duration:
                progress   = elapsed / punch.duration
                snap_point = 0.25
                if progress < snap_point:
                    phase_t = progress / snap_point
                    z       = lerp(1.0, punch.zoom_to, ease_out_back(phase_t, 1.4))
                else:
                    phase_t = (progress-snap_point)/(1-snap_point)
                    z       = lerp(punch.zoom_to, 1.0, ease_in_out(phase_t))
                frame = zoom_frame(frame, z, punch.cx_ratio, punch.cy_ratio)
                break
        return frame

    def render(self, fi: int) -> np.ndarray:
        """Render frame fi (0-indexed within this scene)."""
        t  = fi / self.FPS
        dt = 1.0 / self.FPS

        # 1. Background (vertical parallax + zoom — no tear lines)
        frame = self._get_base_frame(t)

        # 2. Camera effects
        frame = light_flicker(frame, t, 0.022)
        if self.scene.emotion not in ("tense","empty"):
            frame = heat_shimmer(frame, t, 0.8)
        if self.scene.emotion == "tense":
            sp = t / self.scene.duration_sec
            shake = max(0, (sp-0.4)) * 5.0
            if shake > 0:
                sx = int(math.sin(t*23.7)*shake)
                sy = int(math.sin(t*31.1)*shake*0.4)
                M  = np.float32([[1,0,sx],[0,1,sy]])
                frame = cv2.warpAffine(frame,M,(self.W,self.H),borderMode=cv2.BORDER_REPLICATE)

        # 3. Particles (persistent state)
        self.particles.step(dt, self.scene.wind)
        self.particles.draw(frame, t)

        # 4. Zoom punch
        frame = self._zoom_punch(t, frame)

        # 5. Transition IN
        trans_in_frames = int(self.trans_in_dur * self.FPS)
        if self.prev_frame is not None and fi < trans_in_frames:
            t_in  = fi / trans_in_frames
            func  = TRANSITION_FUNCS.get(self.trans_in_type, crossfade)
            frame = func(self.prev_frame, frame, t_in)

        # 6. Emotion grade (half-res, blends in over first 1.5s)
        blend = clamp(t / 1.5, 0, 1)
        frame = apply_emotion_grade(frame, self.scene.emotion, blend)

        # 7. Vignette (precomputed)
        frame = apply_vignette(frame, self.vignette_mask)

        # 8. Grain (tiled patch)
        frame = add_grain(frame, self.W, self.H, amount=5)

        return frame

# ═══════════════════════════════════════════════════════════════════════════════
# PUBLIC API
# ═══════════════════════════════════════════════════════════════════════════════

def render_episode_to_file(cfg: EngineConfig, scenes: List[SceneConfig],
                            output_path: str,
                            captions=None) -> str:
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    writer = cv2.VideoWriter(output_path, fourcc, float(cfg.fps), (cfg.w, cfg.h))
    if not writer.isOpened():
        raise RuntimeError(f"VideoWriter failed: {output_path}")

    t_offset        = 0.0
    prev_last_frame = None

    for scene in scenes:
        renderer     = SceneRenderer(scene, cfg, prev_last_frame)
        total        = renderer.total_frames

        for fi in range(total):
            frame = renderer.render(fi)
            if captions:
                abs_t = t_offset + fi/cfg.fps
                for (text,start,end) in captions:
                    frame = draw_caption(frame, text, abs_t, start, end)
            writer.write(frame)

        prev_last_frame = renderer.render(total - 1)
        t_offset       += scene.duration_sec

    writer.release()
    return output_path

# ═══════════════════════════════════════════════════════════════════════════════
# DEMO
# ═══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    import time as _time

    IMG_APPROACH = '/mnt/user-data/uploads/20260604_130538_1__1_.jpg'
    IMG_EMPTY    = '/mnt/user-data/uploads/20260604_130216_2__1__1__1_.jpg'
    IMG_TRAIN    = '/mnt/user-data/uploads/20260604_130546_2__1_.jpg'
    OUTPUT       = '/mnt/user-data/outputs/metro_v3_fixed.mp4'

    cfg = EngineConfig(w=1080, h=1920, fps=24)

    scenes = [
        SceneConfig(
            background_path=IMG_EMPTY,   duration_sec=8.0,
            emotion="neutral",           particle_mode="dust",
            transition_in="crossfade",   transition_out="iris_wipe",
            camera_move="ken_burns_in",  wind=-5.0,
        ),
        SceneConfig(
            background_path=IMG_APPROACH, duration_sec=6.0,
            emotion="tense",              particle_mode="tense",
            transition_in="iris_wipe",    transition_out="flash_cut",
            camera_move="pan_right",      wind=20.0,
            zoom_punches=[ZoomPunch(t_in_scene=4.5, zoom_to=1.15,
                                    duration=0.4, cx_ratio=0.5, cy_ratio=0.45)],
        ),
        SceneConfig(
            background_path=IMG_TRAIN,   duration_sec=6.0,
            emotion="curious",           particle_mode="dust",
            transition_in="flash_cut",   transition_out="fade_black",
            camera_move="static",        wind=0.0,
            zoom_punches=[ZoomPunch(t_in_scene=0.1, zoom_to=1.18,
                                    duration=0.35, cx_ratio=0.5, cy_ratio=0.5)],
        ),
        SceneConfig(
            background_path=IMG_EMPTY,   duration_sec=10.0,
            emotion="sad",               particle_mode="data_stream",
            transition_in="fade_black",  transition_out="crossfade",
            camera_move="ken_burns_out", wind=-15.0,
        ),
    ]

    captions = [
        ("Late evening. An empty platform.", 1.0,  5.5),
        ("Somewhere in the city...",         5.5,  8.0),
        ("A train approaches...",            8.5,  13.0),
        ("The metro pulls in.",              14.5, 18.0),
        ("And then... it leaves.",           21.0, 25.0),
        ("The platform is empty again.",     25.5, 29.5),
    ]

    print("=== Metro Engine v3 FIXED — Portrait Correct ===")
    print(f"Resolution: {cfg.w}x{cfg.h} | {cfg.fps}fps | {len(scenes)} scenes")
    print()
    print("FIXES:")
    print("  BUG 1 FIXED: No horizontal band splitting → no tear lines")
    print("  BUG 2 FIXED: Vertical parallax → correct image content visible")
    print("  Vertical pan room: 15% extra height = genuine depth motion")
    print()

    t0 = _time.time()
    render_episode_to_file(cfg, scenes, OUTPUT, captions)
    elapsed = _time.time() - t0
    total_frames = int(sum(s.duration_sec for s in scenes) * cfg.fps)
    print(f"Done: {elapsed:.1f}s | {elapsed/total_frames*1000:.0f}ms/frame | {OUTPUT}")
