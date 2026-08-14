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


# ── easing ────────────────────────────────────────────────────────────────────
# The standard curves, written out rather than imported. They are four lines of
# arithmetic each and the alternative is a dependency for arithmetic. Every one takes
# and returns a scalar or an ndarray — np.clip handles both, so the same function
# eases one word's entrance and a whole array of node positions.
#
# ease_out / ease_in_out_cubic stay inside [0, 1]. ease_out_back and ease_out_elastic
# deliberately do not: they overshoot past 1 and settle back, which is what makes an
# entrance read as weight rather than as a fade. Anything driving ALPHA must use a
# bounded curve — an alpha above 1 inverts the blend.

def ease_out(t):
    """Cubic ease-out. Bounded [0, 1]. The workhorse."""
    t = np.clip(t, 0.0, 1.0)
    return 1.0 - (1.0 - t) ** 3


def ease_in_out_cubic(t):
    """Symmetric acceleration and deceleration. Bounded [0, 1]."""
    t = np.clip(t, 0.0, 1.0)
    return np.where(t < 0.5, 4.0 * t ** 3, 1.0 - (-2.0 * t + 2.0) ** 3 / 2.0)


# 1.70158 is the classic Penner constant: the value that makes the curve overshoot by
# ~10% before settling. Kept as a default rather than a magic number in the body.
BACK_OVERSHOOT = 1.70158


def ease_out_back(t, overshoot: float = BACK_OVERSHOOT):
    """Overshoots past 1, then settles. Peaks around 1.1 at the default constant."""
    t = np.clip(t, 0.0, 1.0)
    c3 = overshoot + 1.0
    return 1.0 + c3 * (t - 1.0) ** 3 + overshoot * (t - 1.0) ** 2


def ease_out_elastic(t):
    """Overshoots and oscillates to rest. Heavier than back; use it sparingly."""
    t = np.clip(t, 0.0, 1.0)
    c4 = (2.0 * np.pi) / 3.0
    out = np.power(2.0, -10.0 * t) * np.sin((t * 10.0 - 0.75) * c4) + 1.0
    # The formula is undefined-ish at the ends; pin them so the curve is exactly 0 and 1.
    return np.where(t <= 0.0, 0.0, np.where(t >= 1.0, 1.0, out))


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


def _load_logo(path: str, box_h: int, max_w: int):
    """A sourced brand asset as a BGRA sprite fitted to the card, or None.

    Returns None on anything unexpected rather than raising: the whole entity-image
    feature is an enhancement over generated imagery, and a card with no logo is a
    perfectly good card. Alpha is preserved when the file has it (Commons renders SVG
    logos to transparent PNG) and synthesised as opaque when it does not.
    """
    if not path or not os.path.exists(path):
        return None
    img = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if img is None or img.size == 0:
        return None
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    if img.shape[2] == 3:
        img = np.dstack([img, np.full(img.shape[:2], 255, np.uint8)])
    h, w = img.shape[:2]
    # Whichever constraint binds first. A wordmark is often 5:1, so height alone would
    # size it far wider than the card.
    k = min(box_h / max(1, h), max_w / max(1, w))
    if k <= 0:
        return None
    return cv2.resize(img, (max(1, int(w * k)), max(1, int(h * k))),
                      interpolation=cv2.INTER_AREA if k < 1 else cv2.INTER_LINEAR)


def _paste(dst: np.ndarray, src: np.ndarray, x: int, y: int) -> None:
    """Alpha-composite one BGRA sprite into another at build time. Clipped."""
    sh, sw = src.shape[:2]
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(dst.shape[1], x + sw), min(dst.shape[0], y + sh)
    if x1 <= x0 or y1 <= y0:
        return
    patch = src[y0 - y:y1 - y, x0 - x:x1 - x].astype(np.float32)
    roi = dst[y0:y1, x0:x1].astype(np.float32)
    a = patch[:, :, 3:4] / 255.0
    dst[y0:y1, x0:x1, :3] = (patch[:, :, :3] * a + roi[:, :, :3] * (1.0 - a)).astype(np.uint8)
    dst[y0:y1, x0:x1, 3] = np.maximum(roi[:, :, 3], patch[:, :, 3]).astype(np.uint8)


def _is_dark(logo: np.ndarray, threshold: int = 118) -> bool:
    """Whether a BGRA logo's visible ink is dark, i.e. drawn for a light background.

    Weighted by alpha, so the transparent margin around a mark does not vote.
    """
    a = logo[:, :, 3].astype(np.float32)
    total = a.sum()
    if total < 1.0:
        return False
    lum = logo[:, :, :3].astype(np.float32).mean(axis=2)
    return float((lum * a).sum() / total) < threshold


def _panel_text_x0(h: int, stripe: int, logo) -> int:
    """Left edge of a panel's text area. One definition, so the caller that CHOOSES the
    type size and the code that DRAWS it cannot disagree — they did, and the label ran
    over the logo and off the right edge of the card."""
    inset = max(6, h // 8)
    return stripe + inset + ((logo.shape[1] + inset) if logo is not None else 0)


def _panel_sprite(text: str, font_path: str, w: int, h: int, accent, size: int,
                  stripe: int = 0, logo=None) -> np.ndarray:
    """A filled card with its label already baked in, rasterised once.

    Everything the diagram, comparison and name-card treatments put on screen is a
    panel with text on it, and none of it changes between frames — only its position,
    scale and opacity do. Rasterising the whole card once and blitting it is the same
    trick the engine already uses for character/shadow sprites, and it is the
    difference between drawing rounded rectangles a hundred and fifty times a clip and
    drawing them once.
    """
    img = Image.new('RGBA', (max(8, w), max(8, h)), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    radius = max(6, h // 6)
    d.rounded_rectangle([0, 0, w - 1, h - 1], radius=radius, fill=(14, 14, 18, 225),
                        outline=(accent[2], accent[1], accent[0], 255),
                        width=max(2, h // 26))
    if stripe:
        # Left-edge accent bar: the lower-third convention, and it gives the card an
        # anchor to slide out from.
        d.rounded_rectangle([0, 0, stripe, h - 1], radius=radius // 2,
                            fill=(accent[2], accent[1], accent[0], 255))
    # A logo takes the left of the card and the label centres in what is left, so the
    # two never overlap however long the label is. Baked in here at build time: the
    # finished card is still one sprite and still one blit per frame.
    text_x0 = _panel_text_x0(h, stripe, logo)
    if logo is not None and _is_dark(logo):
        # Brand marks are drawn for the background their owner expects, and a dark
        # wordmark on this card's near-black fill is barely there — the real Playwright
        # asset is dark slate. A light plate behind it is the same thing a press kit
        # asks for and leaves the mark itself untouched, which recolouring would not.
        lh, lw = logo.shape[:2]
        lx, ly = stripe + max(6, h // 8), (h - lh) // 2
        m = max(3, h // 16)
        d.rounded_rectangle([lx - m, ly - m, lx + lw + m, ly + lh + m],
                            radius=max(4, h // 10), fill=(244, 244, 248, 255))
    font = ImageFont.truetype(font_path, size)
    x0, y0, x1, y1 = d.textbbox((0, 0), text, font=font)
    d.text((text_x0 + (w - text_x0 - (x1 - x0)) / 2 - x0, (h - (y1 - y0)) / 2 - y0),
           text, font=font, fill=(245, 245, 250, 255))
    rgba = np.array(img)
    card = np.dstack([rgba[:, :, 2], rgba[:, :, 1], rgba[:, :, 0], rgba[:, :, 3]])
    if logo is not None:
        _paste(card, logo, stripe + max(6, h // 8), (h - logo.shape[0]) // 2)
    return card


def _fit_size(text: str, font_path: str, box_w: int, start: int) -> int:
    """Largest type size at which `text` fits inside box_w. Called at build time only."""
    size = start
    probe = ImageDraw.Draw(Image.new('RGBA', (1, 1)))
    while size > 10:
        f = ImageFont.truetype(font_path, size)
        x0, _, x1, _ = probe.textbbox((0, 0), text, font=f)
        if x1 - x0 <= box_w:
            break
        size = int(size * 0.88)
    return max(10, size)


def _line(frame: np.ndarray, x0: int, y0: int, x1: int, y1: int, colour, thick: int,
          alpha: float = 1.0) -> None:
    """Anti-aliased line blended at `alpha`, clipped to the frame.

    Drawn onto a copy of just the bounding box rather than the whole frame: a connector
    is a few hundred pixels and cv2.line on the full frame would still cost a full-frame
    addWeighted to fade it in.
    """
    if alpha <= 0.01 or thick < 1:
        return
    fh, fw = frame.shape[:2]
    pad = thick + 2
    bx0, by0 = max(0, min(x0, x1) - pad), max(0, min(y0, y1) - pad)
    bx1, by1 = min(fw, max(x0, x1) + pad), min(fh, max(y0, y1) + pad)
    if bx1 <= bx0 or by1 <= by0:
        return
    roi = frame[by0:by1, bx0:bx1]
    layer = roi.copy()
    cv2.line(layer, (x0 - bx0, y0 - by0), (x1 - bx0, y1 - by0),
             tuple(int(c) for c in colour), thick, cv2.LINE_AA)
    cv2.addWeighted(layer, float(alpha), roi, 1.0 - float(alpha), 0.0, dst=roi)


# Scale quantisation for the resize cache. A 0.4% step is invisible on a 4.5% push and
# turns a per-frame resize of every glyph into a dictionary hit.
SCALE_STEP = 0.004


def _blit(frame: np.ndarray, sprite: np.ndarray, cx: int, cy: int,
          alpha: float = 1.0, scale: float = 1.0, cache: dict = None) -> None:
    """Alpha-composite a BGRA sprite centred on (cx, cy). Clipped, in place.

    `cache` is a pure memo of resized sprites, not state: the scale is a function of t,
    so the same t produces the same key and the same pixels whether or not the cache is
    warm. It exists because the payoff treatment pushes the whole block continuously,
    which meant resizing every glyph on every frame — measured at 46ms/frame on a
    1080x1920 render, the most expensive thing in this module by some way.
    """
    if alpha <= 0.003 or scale <= 0.01:
        return
    if abs(scale - 1.0) > 0.005:
        q = round(scale / SCALE_STEP) * SCALE_STEP
        key = (id(sprite), q)
        hit = cache.get(key) if cache is not None else None
        if hit is None:
            h, w = sprite.shape[:2]
            nw, nh = max(1, int(w * q)), max(1, int(h * q))
            hit = cv2.resize(sprite, (nw, nh), interpolation=cv2.INTER_LINEAR)
            if cache is not None:
                cache[key] = hit
        sprite = hit

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


def build_glow(w: int, h: int, cx: int, cy: int, radius: int, ry: int = 0):
    """Precompute the radial falloff behind a graphic, so type never fights the
    background.

    Built once, not per frame. Generating the mgrid and its sqrt every frame cost
    48ms/frame on a 1080x1920 render — measured at 117ms/frame without the overlay
    against 165 with it, which is most of the overlay's entire budget for a mask that
    never changes shape. Only its strength varies with the envelope.
    """
    ry = ry or radius
    x0, y0 = max(0, cx - radius), max(0, cy - ry)
    x1, y1 = min(w, cx + radius), min(h, cy + ry)
    if x1 <= x0 or y1 <= y0 or radius < 4:
        return None
    yy, xx = np.mgrid[y0:y1, x0:x1].astype(np.float32)
    # Elliptical, sized to the block it sits behind rather than to a fraction of the
    # frame. The circular version cost 21ms/frame at 1080x1920 on the payoff — a
    # background darkening costing more than every glyph in front of it — because a
    # radius of 0.78*W covers most of a portrait frame.
    d = np.sqrt(((xx - cx) / float(radius)) ** 2 + ((yy - cy) / float(ry)) ** 2)
    mask = np.clip(1.0 - d, 0.0, 1.0) ** 2
    # Three channels, not one: cv2.multiply needs matching channel counts, and doing the
    # repeat once here is what keeps the per-frame path a single SIMD multiply.
    return (x0, y0, x1, y1, np.repeat(mask[:, :, None], 3, axis=2))


_GLOW_CACHE: dict = {}


def _glow(frame: np.ndarray, glow, strength: float) -> None:
    """Apply a precomputed glow at this frame's strength.

    cv2.multiply rather than numpy: the ROI is around a megapixel and OpenCV does the
    uint8->float->uint8 round trip in SIMD instead of allocating two intermediate
    float32 arrays per frame.
    """
    if glow is None or strength <= 0.005:
        return
    x0, y0, x1, y1, mask = glow
    # `1.0 - mask * strength` is a full-ROI float multiply — around two megapixels on
    # the payoff's radius — and the strength is constant for most of the window because
    # the envelope sits at 1.0 between the fades. Memoised on the rounded strength, so
    # only the fade frames build a new array. Same value in, same array out.
    q = round(float(strength), 3)
    inv = _GLOW_CACHE.get((id(mask), q))
    if inv is None:
        inv = 1.0 - mask * q
        _GLOW_CACHE[(id(mask), q)] = inv
    cv2.multiply(frame[y0:y1, x0:x1], inv, dst=frame[y0:y1, x0:x1], dtype=cv2.CV_8U)


KINDS = ('kinetic', 'stat', 'payoff', 'diagram', 'comparison', 'namecard')


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
        self.steps = self.spec.get('steps') or []
        self.sides = self.spec.get('sides') or []
        self.name = str(self.spec.get('name') or '')
        self.descriptor = str(self.spec.get('descriptor') or '')
        # A sourced, safely-licensed brand asset and the credit its licence requires.
        # An empty credit is the normal case for public-domain and CC0 files and means
        # exactly what it says: draw nothing.
        self.logo_path = str(self.spec.get('logoPath') or '')
        self.credit = str(self.spec.get('credit') or '')
        self.credit_lines = []
        self.count_up = self.spec.get('countUp') or None
        # The plan resolves the accent from the universe when it has one; the emotion
        # palette is the fallback, so a project with no brand colour still gets a colour
        # that suits the grade rather than a hardcoded amber.
        spec_accent = self.spec.get('accent')
        self.accent = (tuple(int(c) for c in spec_accent) if spec_accent
                       else ACCENT.get(emotion, ACCENT['neutral']))
        self._rcache: dict = {}          # resized-sprite memo; see _blit
        self.ok = False

        font_path = find_font()
        if not _PIL_OK or not font_path or self.end <= self.start or self.kind not in KINDS:
            return

        try:
            self._build(font_path)
            self.ok = True
        except Exception as exc:                     # pragma: no cover - font/raster edge
            print(f'[Overlay] Disabled ({exc})')

    # ── layout (once) ──────────────────────────────────────────────────────
    def _build(self, font_path: str):
        # The three structured treatments lay out cards, not a flow of words, so they
        # build their own geometry and return. Everything below is the word-flow path
        # kinetic/stat/payoff share.
        if self.kind == 'diagram':
            return self._build_diagram(font_path)
        if self.kind == 'comparison':
            return self._build_comparison(font_path)
        if self.kind == 'namecard':
            return self._build_namecard(font_path)
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
        self.digits = None
        if self.kind == 'stat' and self.figure:
            fig_size = max(40, int(self.H * 0.115))
            fig_stroke = max(5, int(self.H * 0.011))
            self.figure_sprite = _sprite_fit(self.figure, fig_size, font_path,
                                             fig_stroke, safe)
            if self.count_up:
                # Ten digit sprites and one suffix sprite, rasterised once, composed per
                # frame. The obvious implementation — re-rasterising "37%" every frame as
                # the counter climbs — is a PIL text render inside the frame loop, which
                # is exactly the per-frame-regeneration mistake the glow mask made. This
                # way a counting frame costs eleven blits at most.
                scale = self.figure_sprite.shape[0] / max(
                    1, _sprite('0', fig_size, font_path, stroke=fig_stroke).shape[0])
                d_size = max(20, int(fig_size * scale))
                self.digits = [_sprite(str(d), d_size, font_path, stroke=fig_stroke)
                               for d in range(10)]
                suffix = str(self.count_up.get('suffix') or '')
                self.suffix_sprite = (_sprite(suffix, d_size, font_path, stroke=fig_stroke)
                                      if suffix.strip() else None)
                # Every sprite carries _sprite's transparent margin on both sides.
                # Advancing by the full sprite width when composing "38%" spaces the
                # digits like separate words — the same double-count that spread the
                # kinetic line across three ragged rows.
                self.digit_pad = (fig_stroke * 2 + 6)

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
        half_h = max(int(self.H * 0.055), (self.block_bottom - self.block_top) // 2)
        if self.kind == 'stat':
            # Taller: the figure sits above the label block and needs covering too.
            self.glow = build_glow(self.W, self.H, self.W // 2, int(self.H * 0.30),
                                   int(self.W * 0.55), int(half_h * 2.4))
        else:
            self.glow = build_glow(self.W, self.H, self.W // 2, mid,
                                   int(self.W * 0.58), int(half_h * 1.9))

    # ── structured layouts (once) ──────────────────────────────────────────
    def _build_diagram(self, font_path: str):
        """Nodes stacked down the frame with connectors between them.

        Vertical, not horizontal: the frame is 9:16 and three cards side by side leaves
        each one about 300px wide at 1080, which fits roughly one word.
        """
        n = len(self.steps)
        box_w = int(self.W * 0.62)
        box_h = int(self.H * 0.075)
        gap = int(self.H * 0.055)                    # room for the connector
        total = n * box_h + (n - 1) * gap
        top = int(self.H * 0.26)
        if top + total > self.H * 0.82:              # keep clear of the captions
            top = max(int(self.H * 0.12), int(self.H * 0.82) - total)

        size = max(14, int(box_h * 0.46))
        for st in self.steps:
            size = min(size, _fit_size(str(st.get('text', '')), font_path,
                                       int(box_w * 0.82), size))

        self.nodes = []                              # (sprite, cx, cy, start)
        for i, st in enumerate(self.steps):
            cy = top + i * (box_h + gap) + box_h // 2
            sprite = _panel_sprite(str(st.get('text', '')), font_path, box_w, box_h,
                                   self.accent, size)
            self.nodes.append((sprite, self.W // 2, cy, float(st.get('start', 0.0))))
        self.box_h = box_h
        self.glow = build_glow(self.W, self.H, self.W // 2, top + total // 2,
                               int(box_w * 0.78), int(total * 0.72))

    def _build_comparison(self, font_path: str):
        """Two stacked panels and a divider. Top is the state being left behind."""
        box_w = int(self.W * 0.74)
        box_h = int(self.H * 0.105)
        self.mid_y = int(self.H * 0.42)
        gap = int(self.H * 0.045)

        size = max(14, int(box_h * 0.34))
        for sd in self.sides:
            size = min(size, _fit_size(str(sd.get('text', '')), font_path,
                                       int(box_w * 0.84), size))

        self.panels = []                             # (sprite, cx, cy, start, from_left)
        for i, sd in enumerate(self.sides[:2]):
            cy = self.mid_y + (-1 if i == 0 else 1) * (gap + box_h // 2)
            sprite = _panel_sprite(str(sd.get('text', '')), font_path, box_w, box_h,
                                   self.accent, size)
            self.panels.append((sprite, self.W // 2, cy, float(sd.get('start', 0.0)), i == 0))
        self.box_w = box_w
        self.glow = build_glow(self.W, self.H, self.W // 2, self.mid_y,
                               int(box_w * 0.72), int((gap + box_h) * 1.5))

    def _build_namecard(self, font_path: str):
        """Lower third: name, optional descriptor, accent stripe, slides in and out.

        When the plan sourced a real brand asset for this entity, the logo is baked into
        the card and its required credit is rasterised as a separate corner sprite.
        """
        box_h = int(self.H * 0.062)
        logo = _load_logo(self.logo_path, int(box_h * 0.62), int(self.W * 0.24))
        # A wordmark already says the name — the sourced Playwright asset IS the word
        # "Playwright" next to its mark, and setting the name beside it produced a card
        # reading "Playwright | Playwright · AIQA Engineer". Wide logos are wordmarks;
        # square ones are symbols and still need the name spelled out.
        wordmark = logo is not None and logo.shape[1] >= logo.shape[0] * 2.5
        label = ' · '.join(p for p in
                           ([] if wordmark else [self.name]) + [self.descriptor] if p)
        box_w = min(int(self.W * 0.78), int(self.W * 0.30) + len(label) * int(box_h * 0.30))
        stripe = max(4, box_w // 60)
        if logo is not None:
            # With no label left to set — a wordmark and no universe descriptor — the
            # card is just the logo, so it hugs it. Sizing for absent text left the
            # first real render with a wide empty box beside the mark.
            box_w = (stripe + max(6, box_h // 8) * 2 + logo.shape[1] if not label
                     else min(int(self.W * 0.86), box_w + logo.shape[1] + box_h // 4))
        # Size the type to the space it actually has — everything left of the text is
        # stripe, inset and logo, and measuring against the whole card overflowed it.
        text_x0 = _panel_text_x0(box_h, stripe, logo)
        text_w = max(40, box_w - text_x0 - max(6, box_h // 8))
        size = _fit_size(label, font_path, text_w, max(14, int(box_h * 0.42)))
        # Kept so the geometry is checkable: the label must start right of the logo and
        # finish inside the card, which is exactly what it did not do at first.
        self.card_text_box = (text_x0, text_w)
        self.card = _panel_sprite(label, font_path, box_w, box_h, self.accent, size,
                                  stripe=stripe, logo=logo)
        # Left-aligned in the lower third, above the burned-in captions.
        self.card_cx = int(self.W * 0.06) + box_w // 2
        self.card_cy = int(self.H * 0.78)
        self.card_w = box_w
        self.glow = None                             # a card carries its own background
        self._build_credit(font_path)

    # Attribution sizing. Deliberately the smallest legible thing on screen. It is a
    # credit, not a caption — the licence asks that it be present and findable, not that
    # it compete with the content. A thin dark stroke keeps it readable over a bright
    # background without making it louder.
    #
    # 0.95% of frame height (18px at 1080x1920) at 0.32 opacity is the floor found by
    # rendering 1.35/0.50, 1.05/0.36, 0.95/0.32 and 0.85/0.28 onto a real frame and onto
    # a deliberately bright, busy one: at 0.85/0.28 the first row starts dissolving into
    # a light background, so 0.95/0.32 is the quietest setting still legible on the worst
    # background this pipeline produces. Both numbers had to drop — smaller type alone
    # stays sharp and still catches the eye, lower opacity alone stays the same size.
    CREDIT_SIZE = 0.0095
    CREDIT_ALPHA = 0.32

    def _build_credit(self, font_path: str):
        """The licence's required credit, bottom-right, or nothing when none is required.

        Wrapped to two lines because the full credit — file, author, licence, source —
        is what CC BY asks for and does not fit across a 9:16 frame at a size that stays
        out of the way.
        """
        self.credit_lines = []
        text = str(self.credit or '').strip()
        if not text:
            return                                   # public domain / CC0: no clutter
        size = max(12, int(self.H * self.CREDIT_SIZE))   # floor: draft renders are short
        stroke = max(1, size // 9)
        parts = [p.strip() for p in text.split('·') if p.strip()]
        half = (len(parts) + 1) // 2
        rows = [' · '.join(parts[:half]), ' · '.join(parts[half:])] if len(parts) > 2 else [text]
        sprites = [_sprite_fit(r, size, font_path, stroke, int(self.W * 0.62))
                   for r in rows if r]
        right = int(self.W * 0.96)
        bottom = int(self.H * 0.982)
        # Stacked upward from the bottom edge, right-aligned. Below the captions
        # (Alignment 2, MarginV 120) and to the side of them, so neither crowds.
        #
        # Advance by the INK height, not the sprite height: every sprite carries
        # _sprite's transparent margin on both sides, and stacking by the full height
        # double-counts it — the same mistake that once spread a kinetic line over three
        # ragged rows, and at this size it would leave the two rows visibly unrelated.
        ink = max(1, sprites[0].shape[0] - (stroke * 2 + 6) * 2)
        y = bottom - ink // 2
        for sp in reversed(sprites):
            self.credit_lines.insert(0, (sp, right - sp.shape[1] // 2, y))
            y -= ink + 2

    # ── structured drawing (per frame, pure in t) ──────────────────────────
    NODE_IN = 0.42

    def _draw_diagram(self, frame, t, env):
        """Which nodes are visible at time t, computed directly from t.

        No progressive state, no warm-up: node i's opacity is a function of
        (t - node_i.start) alone, so a worker rendering frames 600-800 draws exactly
        what a sequential render draws there. The diagram "builds" because the starts
        are staggered, not because anything is remembered between calls.
        """
        _glow(frame, self.glow, 0.42 * env)
        prev = None
        for sprite, cx, cy, start in self.nodes:
            raw = (t - start) / self.NODE_IN
            if raw <= 0.0:
                break                                 # later nodes start later still
            alpha = env * float(ease_out(raw))
            _blit(frame, sprite, cx, cy, alpha=alpha,
                  scale=0.86 + 0.14 * float(ease_out_back(raw)), cache=self._rcache)
            if prev is not None:
                # The connector draws downward out of the previous node as this one
                # arrives, so the line reads as causing the next step.
                grow = float(ease_in_out_cubic(raw * 1.6))
                y0 = prev + self.box_h // 2
                y1 = cy - self.box_h // 2
                _line(frame, cx, y0, cx, int(y0 + (y1 - y0) * grow),
                      self.accent, max(2, self.H // 400), alpha)
                if grow > 0.92:                       # arrowhead, once the line lands
                    a = max(4, self.H // 150)
                    _line(frame, cx, y1, cx - a, y1 - a, self.accent, max(2, self.H // 420), alpha)
                    _line(frame, cx, y1, cx + a, y1 - a, self.accent, max(2, self.H // 420), alpha)
            prev = cy

    def _draw_comparison(self, frame, t, env):
        _glow(frame, self.glow, 0.46 * env)
        # The divider is the whole point of a split panel: it says these two things are
        # being held against each other. It wipes out from the centre.
        first = self.panels[0][3] if self.panels else self.start
        wipe = float(ease_in_out_cubic((t - first) / 0.5))
        half = int(self.W * 0.44 * wipe)
        if half > 3:
            _line(frame, self.W // 2 - half, self.mid_y, self.W // 2 + half, self.mid_y,
                  self.accent, max(2, self.H // 380), env)

        for sprite, cx, cy, start, from_left in self.panels:
            raw = (t - start) / 0.5
            if raw <= 0.0:
                continue
            slide = float(ease_out_back(raw))
            # Opposite sides, so the two states are seen arriving from opposite places.
            travel = int(self.W * 0.5 * (1.0 - slide)) * (-1 if from_left else 1)
            _blit(frame, sprite, cx + travel, cy, alpha=env * float(ease_out(raw)))

    def _draw_namecard(self, frame, t, env):
        # In, hold, out — the lower-third convention. The exit is a different curve
        # from the entrance on purpose: it arrives with weight and leaves without.
        life = self.end - self.start
        since = t - self.start
        out_at = max(0.6, life - 0.55)
        if since < 0.5:
            p = float(ease_out_back(since / 0.5))
            alpha = float(ease_out(since / 0.35))
        elif since > out_at:
            p = 1.0 - float(ease_in_out_cubic((since - out_at) / 0.5))
            alpha = 1.0 - float(ease_in_out_cubic((since - out_at) / 0.5))
        else:
            p, alpha = 1.0, 1.0
        travel = int((self.card_w + self.W * 0.1) * (1.0 - p))
        _blit(frame, self.card, self.card_cx - travel, self.card_cy, alpha=env * alpha)
        # The credit fades with the card and does not slide with it — attribution is not
        # a piece of choreography, it just has to be on screen while the image is. Same
        # function of t as everything else here, so a parallel worker draws it the same.
        for sprite, cx, cy in self.credit_lines:
            _blit(frame, sprite, cx, cy, alpha=env * alpha * self.CREDIT_ALPHA)

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
        elif self.kind == 'diagram':
            self._draw_diagram(frame, t, env)
        elif self.kind == 'comparison':
            self._draw_comparison(frame, t, env)
        elif self.kind == 'namecard':
            self._draw_namecard(frame, t, env)
        else:
            self._draw_kinetic(frame, t, env)
        return frame

    def _draw_kinetic(self, frame, t, env):
        _glow(frame, self.glow, 0.34 * env)
        for wi, sp, cx, cy in self.placed:
            w = self.words[wi]
            # Each word enters on its own speech window — this is the sync. The word is
            # on screen while it is being said, not on a fixed cadence.
            raw = (t - float(w.get('start', 0.0))) / self.WORD_IN
            if raw <= 0.0:
                continue
            # Two curves, on purpose. Scale overshoots past its resting size and settles
            # (ease_out_back), which is what gives the word weight; alpha rides the
            # bounded curve, because an alpha over 1 inverts the blend in _blit.
            _blit(frame, sp, cx, cy,
                  alpha=env * float(ease_out(raw)),
                  scale=0.82 + 0.18 * float(ease_out_back(raw)), cache=self._rcache)

    def _draw_stat(self, frame, t, env):
        cy = int(self.H * 0.26)
        _glow(frame, self.glow, 0.42 * env)
        p = (t - self.start) / 0.32
        if self.figure_sprite is not None:
            # Overshoot then settle, from the named curve rather than the hand-rolled
            # approximation this used to carry.
            scale = 0.74 + 0.26 * float(ease_out_back(p))
            fh = int(self.figure_sprite.shape[0] * scale)
            counted = self._draw_countup(frame, t, env, cy, scale)
            if not counted:
                _blit(frame, self.figure_sprite, self.W // 2, cy, alpha=env, scale=scale,
                      cache=self._rcache)
        else:
            fh = int(self.H * 0.1)

        # Underline wipes out from the centre under the figure.
        bar_w = int(self.W * 0.34 * float(ease_in_out_cubic((t - self.start) / 0.45)))
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
            raw = (t - float(w.get('start', 0.0))) / self.WORD_IN
            if raw <= 0.0:
                continue
            _blit(frame, sp, cx, cy + fh // 2 + int(self.H * 0.055),
                  alpha=env * float(ease_out(raw)), scale=0.9 + 0.1 * float(ease_out_back(raw)),
                  cache=self._rcache)

    COUNT_FOR = 0.85          # seconds spent climbing to the figure

    def _draw_countup(self, frame, t, env, cy, scale) -> bool:
        """Draw the figure mid-climb. Returns False once it has landed.

        Pure in t: the displayed value is `round(target * eased(t))`, not an
        accumulator. Two processes rendering different halves of the clip therefore
        agree on the number, which an incrementing counter could not guarantee.
        """
        if not self.digits or not self.count_up:
            return False
        prog = (t - self.start) / self.COUNT_FOR
        if prog >= 1.0:
            return False
        target = int(self.count_up.get('to') or 0)
        value = int(round(target * float(ease_out(max(0.0, prog)))))

        glyphs = [self.digits[int(ch)] for ch in str(value)]
        if self.suffix_sprite is not None:
            glyphs.append(self.suffix_sprite)
        advance = [max(1.0, (g.shape[1] - 2 * self.digit_pad) * scale) for g in glyphs]
        x = self.W / 2.0 - sum(advance) / 2.0
        for g, adv in zip(glyphs, advance):
            _blit(frame, g, int(x + adv / 2), cy, alpha=env, scale=scale, cache=self._rcache)
            x += adv
        return True

    def _draw_payoff(self, frame, t, env):
        # A slow push on the whole block, and a heavier hold on the background than the
        # other two treatments get. This is the beat the script's opening promised; it
        # reads as an arrival rather than a label because nothing else moves under it.
        life = (t - self.start) / max(0.6, self.end - self.start)
        scale = 1.0 + 0.045 * float(ease_in_out_cubic(life))
        _glow(frame, self.glow, 0.5 * env)
        for wi, sp, cx, cy in self.placed:
            w = self.words[wi]
            raw = (t - float(w.get('start', 0.0))) / 0.3
            if raw <= 0.0:
                continue
            p = float(ease_out(raw))
            dy = int((cy - (self.block_top + self.block_bottom) / 2) * (scale - 1.0))
            _blit(frame, sp, cx, cy + dy, alpha=env * p, scale=scale * (0.9 + 0.1 * p),
                  cache=self._rcache)


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
    parts = (layer.steps or layer.sides or layer.words)
    detail = (f'{len(parts)} nodes' if layer.steps
              else f'{len(parts)} panels' if layer.sides
              else f'card "{layer.name}"' if layer.name
              else f'{len(parts)} words')
    print(f'[Overlay] {layer.kind} overlay, {detail}, '
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
