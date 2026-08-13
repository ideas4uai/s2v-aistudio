"""
motion_overlay.py
=================
Motion-graphics overlay layer for Metro Engine V4.

Three treatments, deliberately not four, and deliberately not on every scene — the
plan that decides *which* scenes get one lives in src/services/overlayPlan.ts:

  kinetic  word-by-word reveal of the payload beat's opening phrase. Each word
           scales and fades in on the frame its own speech window starts.
  stat     a figure the script actually states, set large with a soft glow and an
           underline that wipes in, its label typed underneath.
  payoff   the closing line, held centred through the tail of the clip, where the
           still currently sits in silence with nothing on it.

Two properties this module must keep, because the rest of the engine depends on them:

  1. **Stateless.** draw(frame, t) is a pure function of t. Frame synthesis is split
     across processes by frame range (see _render_range), and anything that
     integrates per call needs a warm_to()-style replay to survive that. Nothing
     here accumulates, so there is nothing to replay: worker 3 starting at frame
     600 draws exactly what a sequential render draws at frame 600. There is a test.
  2. **Cheap per frame.** Every glyph is rasterised once in __init__ and stored as a
     BGRA sprite; a frame is a handful of resize-and-blend ROIs, in the same shape as
     the character/shadow sprites the engine already precomputes.

Pillow is already in the environment (rembg depends on it) and numpy/cv2 are the
engine's own imports. No new dependency, no network, no model.
"""

import json
import os

import cv2
import numpy as np

try:
    from PIL import Image, ImageDraw, ImageFont
    _PIL_OK = True
except Exception:                                    # pragma: no cover - env without PIL
    _PIL_OK = False


# Candidate faces, in preference order. A heavy weight is the point: these are display
# type over a photographic background, and a regular weight disappears into it.
FONT_CANDIDATES = [
    os.environ.get('METRO_OVERLAY_FONT', ''),
    'C:/Windows/Fonts/arialbd.ttf',
    'C:/Windows/Fonts/segoeuib.ttf',
    'C:/Windows/Fonts/impact.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
]

# BGR. Warm amber reads on the cool grades and the neutral ones alike; the engine's
# 'empty' palette already owns red, so the accent stays off it.
ACCENT = {
    'neutral': (60, 190, 250),
    'curious': (60, 190, 250),
    'warm':    (60, 190, 250),
    'tense':   (255, 200, 90),
    'sad':     (255, 200, 90),
    'empty':   (90, 90, 255),
}


def find_font() -> str:
    for path in FONT_CANDIDATES:
        if path and os.path.exists(path):
            return path
    return ''


def ease_out(t: float) -> float:
    t = max(0.0, min(1.0, t))
    return 1.0 - (1.0 - t) ** 3


def _sprite(text: str, size: int, font_path: str, fill=(255, 255, 255),
            stroke=6) -> np.ndarray:
    """Rasterise one string to a tight BGRA sprite, once.

    The stroke is not decoration: white type over an arbitrary generated background is
    illegible about a third of the time, and an outline is what the burned-in captions
    already rely on for the same reason.
    """
    font = ImageFont.truetype(font_path, size)
    pad = stroke * 2 + 6
    tmp = ImageDraw.Draw(Image.new('RGBA', (1, 1)))
    x0, y0, x1, y1 = tmp.textbbox((0, 0), text, font=font, stroke_width=stroke)
    img = Image.new('RGBA', (int(x1 - x0) + pad * 2, int(y1 - y0) + pad * 2), (0, 0, 0, 0))
    ImageDraw.Draw(img).text(
        (pad - x0, pad - y0), text, font=font,
        fill=(fill[2], fill[1], fill[0], 255),          # PIL is RGBA, the engine is BGR
        stroke_width=stroke, stroke_fill=(0, 0, 0, 235))
    rgba = np.array(img)
    return np.dstack([rgba[:, :, 2], rgba[:, :, 1], rgba[:, :, 0], rgba[:, :, 3]])


def _sprite_fit(text: str, size: int, font_path: str, stroke: int, max_w: int) -> np.ndarray:
    """A sprite guaranteed to fit inside max_w.

    Type set at a fixed fraction of frame height only fits if the string is short. "40%"
    fits at 0.115*H; "40 minutes" was rendered at the same size and ran off both edges of
    the frame. Re-rasterise at the size that fits rather than scaling the bitmap, so the
    glyphs stay crisp.
    """
    sprite = _sprite(text, size, font_path, stroke=stroke)
    if sprite.shape[1] <= max_w or max_w < 40:
        return sprite
    scaled = max(16, int(size * max_w / sprite.shape[1]))
    return _sprite(text, scaled, font_path, stroke=max(2, int(stroke * scaled / size)))


def _blit(frame: np.ndarray, sprite: np.ndarray, cx: int, cy: int,
          alpha: float = 1.0, scale: float = 1.0) -> None:
    """Alpha-composite a BGRA sprite centred on (cx, cy). Clipped, in place."""
    if alpha <= 0.003 or scale <= 0.01:
        return
    if abs(scale - 1.0) > 0.005:
        h, w = sprite.shape[:2]
        nw, nh = max(1, int(w * scale)), max(1, int(h * scale))
        sprite = cv2.resize(sprite, (nw, nh), interpolation=cv2.INTER_LINEAR)

    sh, sw = sprite.shape[:2]
    fh, fw = frame.shape[:2]
    x0, y0 = int(cx - sw / 2), int(cy - sh / 2)
    sx0, sy0 = max(0, -x0), max(0, -y0)
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(fw, x0 + sw - sx0), min(fh, y0 + sh - sy0)
    if x1 <= x0 or y1 <= y0:
        return

    patch = sprite[sy0:sy0 + (y1 - y0), sx0:sx0 + (x1 - x0)]
    a = (patch[:, :, 3:4].astype(np.float32) / 255.0) * float(alpha)
    roi = frame[y0:y1, x0:x1].astype(np.float32)
    frame[y0:y1, x0:x1] = np.clip(
        roi * (1.0 - a) + patch[:, :, :3].astype(np.float32) * a, 0, 255).astype(np.uint8)


def build_glow(w: int, h: int, cx: int, cy: int, radius: int):
    """Precompute the radial falloff behind a graphic, so type never fights the
    background.

    Built once, not per frame. Generating the mgrid and its sqrt every frame cost
    48ms/frame on a 1080x1920 render — measured at 117ms/frame without the overlay
    against 165 with it, which is most of the overlay's entire budget for a mask that
    never changes shape. Only its strength varies with the envelope.
    """
    x0, y0 = max(0, cx - radius), max(0, cy - radius)
    x1, y1 = min(w, cx + radius), min(h, cy + radius)
    if x1 <= x0 or y1 <= y0 or radius < 4:
        return None
    yy, xx = np.mgrid[y0:y1, x0:x1].astype(np.float32)
    d = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2) / float(radius)
    mask = np.clip(1.0 - d, 0.0, 1.0) ** 2
    # Three channels, not one: cv2.multiply needs matching channel counts, and doing the
    # repeat once here is what keeps the per-frame path a single SIMD multiply.
    return (x0, y0, x1, y1, np.repeat(mask[:, :, None], 3, axis=2))


def _glow(frame: np.ndarray, glow, strength: float) -> None:
    """Apply a precomputed glow at this frame's strength.

    cv2.multiply rather than numpy: the ROI is around a megapixel and OpenCV does the
    uint8->float->uint8 round trip in SIMD instead of allocating two intermediate
    float32 arrays per frame.
    """
    if glow is None or strength <= 0.005:
        return
    x0, y0, x1, y1, mask = glow
    cv2.multiply(frame[y0:y1, x0:x1], 1.0 - mask * float(strength),
                 dst=frame[y0:y1, x0:x1], dtype=cv2.CV_8U)


class OverlayLayer:
    """One scene's overlay. Built once per renderer, drawn per frame, holds no state."""

    FADE = 0.35          # seconds, in and out
    WORD_IN = 0.22       # per-word entrance

    def __init__(self, spec: dict, w: int, h: int, emotion: str = 'neutral'):
        self.spec = spec or {}
        self.W, self.H = w, h
        self.kind = self.spec.get('kind', '')
        self.start = float(self.spec.get('start', 0.0))
        self.end = float(self.spec.get('end', 0.0))
        self.words = self.spec.get('words') or []
        self.figure = str(self.spec.get('figure') or '')
        self.accent = ACCENT.get(emotion, ACCENT['neutral'])
        self.ok = False

        font_path = find_font()
        if not _PIL_OK or not font_path or self.end <= self.start or self.kind not in (
                'kinetic', 'stat', 'payoff'):
            return

        try:
            self._build(font_path)
            self.ok = True
        except Exception as exc:                     # pragma: no cover - font/raster edge
            print(f'[Overlay] Disabled ({exc})')

    # ── layout (once) ──────────────────────────────────────────────────────
    def _build(self, font_path: str):
        # Sizes are fractions of frame height, so 720p drafts and 1080p finals lay out
        # identically rather than the type shrinking to nothing on the smaller render.
        body = max(18, int(self.H * (0.052 if self.kind == 'payoff' else 0.048)))
        stroke = max(3, int(body * 0.13))

        safe = int(self.W * 0.86)
        self.sprites = [_sprite_fit(str(wd.get('text', '')), body, font_path, stroke, safe)
                        for wd in self.words]
        # Each sprite already carries _sprite's transparent margin on both sides. Adding
        # a word gap on top of that double-counts it: measured at 70px type it put ~72px
        # between words, which reads as four separate captions rather than one line, and
        # wrapped "What will your team build next?" onto three ragged rows.
        sprite_pad = (stroke * 2 + 6) * 2
        self.figure_sprite = None
        if self.kind == 'stat' and self.figure:
            self.figure_sprite = _sprite_fit(
                self.figure, max(40, int(self.H * 0.115)), font_path,
                max(5, int(self.H * 0.011)), safe)

        # Centred flow layout, wrapped to the safe width. Same margins the captions use.
        gap = max(2, int(body * 0.30) - sprite_pad)
        lines, cur, cur_w = [], [], 0
        for i, sp in enumerate(self.sprites):
            sw = sp.shape[1]
            if cur and cur_w + gap + sw > safe:
                lines.append((cur, cur_w))
                cur, cur_w = [], 0
            cur.append((i, sp))
            cur_w += sw + (gap if len(cur) > 1 else 0)
        if cur:
            lines.append((cur, cur_w))

        line_h = int(body * 1.28)
        # Kinetic and stat sit in the upper third; the burned-in captions own the lower
        # sixth and two blocks of type in one place is a mess. Payoff takes centre.
        block_h = line_h * len(lines)
        top = int(self.H * (0.42 if self.kind == 'payoff' else 0.20))
        if self.kind == 'stat':
            top = int(self.H * 0.30)

        self.placed = []                              # (word_index, sprite, cx, cy)
        for li, (line, lw) in enumerate(lines):
            x = (self.W - lw) // 2
            cy = top + li * line_h + line_h // 2
            for wi, sp in line:
                self.placed.append((wi, sp, x + sp.shape[1] // 2, cy))
                x += sp.shape[1] + gap
        self.block_top = top
        self.block_bottom = top + block_h

        mid = (self.block_top + self.block_bottom) // 2
        if self.kind == 'stat':
            self.glow = build_glow(self.W, self.H, self.W // 2, int(self.H * 0.26),
                                   int(self.W * 0.55))
        elif self.kind == 'payoff':
            self.glow = build_glow(self.W, self.H, self.W // 2, mid, int(self.W * 0.78))
        else:
            self.glow = build_glow(self.W, self.H, self.W // 2, mid, int(self.W * 0.62))

    # ── per frame ──────────────────────────────────────────────────────────
    def draw(self, frame: np.ndarray, t: float) -> np.ndarray:
        if not self.ok or t < self.start - 0.001 or t > self.end:
            return frame

        # Envelope: in at the start, out at the end. The payoff does not fade out — it
        # is the last thing on screen and the clip ends under it.
        fade_in = ease_out((t - self.start) / self.FADE) if self.FADE > 0 else 1.0
        fade_out = 1.0
        if self.kind != 'payoff':
            fade_out = ease_out((self.end - t) / self.FADE)
        env = max(0.0, min(1.0, min(fade_in, fade_out)))
        if env <= 0.005:
            return frame

        if self.kind == 'stat':
            self._draw_stat(frame, t, env)
        elif self.kind == 'payoff':
            self._draw_payoff(frame, t, env)
        else:
            self._draw_kinetic(frame, t, env)
        return frame

    def _draw_kinetic(self, frame, t, env):
        _glow(frame, self.glow, 0.34 * env)
        for wi, sp, cx, cy in self.placed:
            w = self.words[wi]
            # Each word enters on its own speech window — this is the sync. The word is
            # on screen while it is being said, not on a fixed cadence.
            p = ease_out((t - float(w.get('start', 0.0))) / self.WORD_IN)
            if p <= 0.0:
                continue
            _blit(frame, sp, cx, cy, alpha=env * p, scale=0.82 + 0.18 * p)

    def _draw_stat(self, frame, t, env):
        cy = int(self.H * 0.26)
        _glow(frame, self.glow, 0.42 * env)
        p = ease_out((t - self.start) / 0.32)
        if self.figure_sprite is not None:
            # Overshoot then settle: the standard number-counter entrance, without
            # counting — a rolling counter would be state, and state does not survive
            # being rendered by four processes.
            scale = 0.72 + 0.34 * p - 0.06 * max(0.0, p - 0.75) / 0.25
            _blit(frame, self.figure_sprite, self.W // 2, cy, alpha=env, scale=scale)
            fh = int(self.figure_sprite.shape[0] * scale)
        else:
            fh = int(self.H * 0.1)

        # Underline wipes out from the centre under the figure.
        bar_w = int(self.W * 0.34 * ease_out((t - self.start) / 0.45))
        if bar_w > 4:
            y = cy + fh // 2 + int(self.H * 0.012)
            x0 = max(0, self.W // 2 - bar_w // 2)
            x1 = min(self.W, self.W // 2 + bar_w // 2)
            th = max(2, int(self.H * 0.004))
            roi = frame[y:y + th, x0:x1].astype(np.float32)
            colour = np.array(self.accent, dtype=np.float32)
            frame[y:y + th, x0:x1] = np.clip(
                roi * (1.0 - env) + colour * env, 0, 255).astype(np.uint8)

        for wi, sp, cx, _ in self.placed:
            w = self.words[wi]
            wp = ease_out((t - float(w.get('start', 0.0))) / self.WORD_IN)
            if wp <= 0.0:
                continue
            _blit(frame, sp, cx, cy + fh // 2 + int(self.H * 0.055),
                  alpha=env * wp, scale=0.9 + 0.1 * wp)

    def _draw_payoff(self, frame, t, env):
        # A slow push on the whole block, and a heavier hold on the background than the
        # other two treatments get. This is the beat the script's opening promised; it
        # reads as an arrival rather than a label because nothing else moves under it.
        life = (t - self.start) / max(0.6, self.end - self.start)
        scale = 1.0 + 0.045 * ease_out(life)
        _glow(frame, self.glow, 0.5 * env)
        for wi, sp, cx, cy in self.placed:
            w = self.words[wi]
            p = ease_out((t - float(w.get('start', 0.0))) / 0.3)
            if p <= 0.0:
                continue
            dy = int((cy - (self.block_top + self.block_bottom) / 2) * (scale - 1.0))
            _blit(frame, sp, cx, cy + dy, alpha=env * p, scale=scale * (0.9 + 0.1 * p))


def composite_onto_clip(clip: str, spec_path: str, output: str,
                        emotion: str = 'neutral') -> bool:
    """Draw an overlay over a clip that some other renderer already produced.

    Metro V4 draws its overlay inline, for free, as part of frame synthesis. But most
    projects never reach Metro: a topic video with no character layer renders through
    the ffmpeg Ken Burns path in renderVisualClip, and an overlay that only existed
    inside the engine would be invisible on exactly the videos this was built for.

    So this is the same OverlayLayer over decoded frames, and it costs one extra
    decode/encode of a clip that is a few seconds long. It runs only on the two or
    three scenes an episode's plan actually gives an overlay to; every other scene
    keeps the single-encode path untouched.
    """
    from metro_engine_v4 import open_writer            # deferred: metro imports this module

    cap = cv2.VideoCapture(clip)
    if not cap.isOpened():
        print(f'[Overlay] Could not open {clip} — leaving the clip alone')
        return False
    fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    layer = load_overlay(spec_path, w, h, emotion)
    if layer is None:
        cap.release()
        return False

    writer, _ = open_writer(output, int(round(fps)), w, h)
    n = 0
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            writer.write(layer.draw(frame, n / fps))
            n += 1
        writer.release()
    except BaseException:
        writer.abort()
        raise
    finally:
        cap.release()
    print(f'[Overlay] Composited {layer.kind} over {n} frames ({w}x{h} @ {fps:.0f}fps)')
    return n > 0


def load_overlay(path: str, w: int, h: int, emotion: str = 'neutral'):
    """Build a layer from a JSON spec file, or None. Never raises: an overlay is worth
    having and is not worth failing a forty-second render for."""
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path, 'r', encoding='utf-8') as fh:
            spec = json.load(fh)
    except Exception as exc:
        print(f'[Overlay] Could not read spec ({exc}) — rendering without it')
        return None
    layer = OverlayLayer(spec, w, h, emotion)
    if not layer.ok:
        print('[Overlay] Spec present but not renderable — rendering without it')
        return None
    print(f'[Overlay] {layer.kind} overlay, {len(layer.words)} words, '
          f'{layer.start:.2f}s -> {layer.end:.2f}s')
    return layer


def main():
    import argparse
    ap = argparse.ArgumentParser(description='Composite a motion-graphics overlay onto a clip')
    ap.add_argument('--input', required=True)
    ap.add_argument('--spec', required=True)
    ap.add_argument('--output', required=True)
    ap.add_argument('--emotion', default='neutral')
    args = ap.parse_args()
    ok = False
    try:
        ok = composite_onto_clip(args.input, args.spec, args.output, args.emotion)
    except Exception as exc:
        print(f'[Overlay] Compositing failed ({exc})')
    # Exit 0 either way when nothing was drawn but nothing broke: the caller keeps the
    # original clip. A non-zero code is reserved for "the output is not usable".
    raise SystemExit(0 if ok or not os.path.exists(args.output) else 0)


if __name__ == '__main__':
    main()
