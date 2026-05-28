import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont
import librosa
import soundfile as sf
import json
import sys
import os

def load_image(path):
    img = Image.open(path).convert('RGBA')
    return img

def pil_to_cv(img):
    return cv2.cvtColor(np.array(img), cv2.COLOR_RGBA2BGR)

def get_video_writer(output_path, w, h, fps=12):
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    return cv2.VideoWriter(output_path, fourcc, fps, (w, h))

# ─── EFFECT 1: BREATHING ─────────────────────────────────
def breathing(img_path, output_path, duration=4.0, fps=12):
    img = load_image(img_path)
    w, h = img.size
    frames = int(duration * fps)
    out = get_video_writer(output_path, w, h, fps)

    for i in range(frames):
        scale = 1.0 + 0.018 * np.sin(2 * np.pi * i / (fps * 2))
        nw = int(w * scale)
        nh = int(h * scale)
        resized = img.resize((nw, nh), Image.LANCZOS)
        left = (nw - w) // 2
        top = (nh - h) // 2
        cropped = resized.crop((left, top, left+w, top+h))
        out.write(pil_to_cv(cropped))

    out.release()

# ─── EFFECT 2: TALKING SYNC ──────────────────────────────
def talking_sync(img_path, audio_path, output_path,
                 duration, fps=12):
    img = load_image(img_path)
    w, h = img.size

    # Get amplitude per frame
    y, sr = librosa.load(audio_path, sr=None, mono=True)
    samples_per_frame = int(sr / fps)
    amplitudes = []
    for i in range(0, len(y), samples_per_frame):
        chunk = y[i:i+samples_per_frame]
        amplitudes.append(float(np.abs(chunk).mean()))

    if not amplitudes:
        amplitudes = [0.0]
    threshold = np.mean(amplitudes) * 0.6

    frames = int(duration * fps)
    out = get_video_writer(output_path, w, h, fps)

    for i in range(frames):
        amp = amplitudes[i] if i < len(amplitudes) else 0
        frame = img.copy()

        # Simulate talking: slightly open/compress jaw area
        if amp > threshold:
            jaw_top = int(h * 0.72)
            jaw_region = img.crop((0, jaw_top, w, h))
            # Slight downward stretch = open mouth
            new_h_jaw = int((h - jaw_top) * 1.06)
            stretched = jaw_region.resize(
                (w, new_h_jaw), Image.LANCZOS
            )
            # Composite back
            frame = img.copy()
            frame.paste(
                stretched.crop((0, 0, w, h - jaw_top)),
                (0, jaw_top)
            )

        out.write(pil_to_cv(frame))

    out.release()

# ─── EFFECT 3: PAN ───────────────────────────────────────
def pan(img_path, output_path, duration,
        direction='right', fps=12):
    img = load_image(img_path)
    w, h = img.size
    # Output is 75% of image width (to allow panning)
    out_w = int(w * 0.75)
    out_h = h
    frames = int(duration * fps)
    out = get_video_writer(output_path, out_w, out_h, fps)

    max_x = w - out_w
    for i in range(frames):
        t = i / max(frames - 1, 1)
        # Ease in/out
        t = t * t * (3 - 2 * t)
        if direction == 'right':
            x = int(max_x * t)
        else:
            x = int(max_x * (1 - t))

        cropped = img.crop((x, 0, x + out_w, out_h))
        out.write(pil_to_cv(cropped))

    out.release()

# ─── EFFECT 4: ZOOM IN / ZOOM OUT ────────────────────────
def zoom(img_path, output_path, duration,
         direction='in', fps=12):
    img = load_image(img_path)
    w, h = img.size
    frames = int(duration * fps)
    out = get_video_writer(output_path, w, h, fps)

    for i in range(frames):
        t = i / max(frames - 1, 1)
        t = t * t * (3 - 2 * t)  # ease
        if direction == 'in':
            scale = 1.0 + 0.12 * t
        else:
            scale = 1.12 - 0.12 * t

        nw = int(w * scale)
        nh = int(h * scale)
        resized = img.resize((nw, nh), Image.LANCZOS)
        left = (nw - w) // 2
        top = (nh - h) // 2
        cropped = resized.crop((left, top, left+w, top+h))
        out.write(pil_to_cv(cropped))

    out.release()

# ─── EFFECT 5: WHIP PAN TRANSITION ───────────────────────
def whip_pan(img1_path, img2_path, output_path, fps=12):
    img1 = np.array(load_image(img1_path).convert('RGB'))
    img2 = np.array(load_image(img2_path).convert('RGB'))
    h, w = img1.shape[:2]
    frames = 8
    out = get_video_writer(output_path, w, h, fps)

    for i in range(frames):
        t = i / frames
        blur = int(40 * np.sin(np.pi * t)) * 2 + 1
        if i < frames // 2:
            base = img1.copy()
        else:
            base = img2.copy()
        if blur > 1:
            blurred = cv2.blur(base, (blur, 1))
        else:
            blurred = base
        out.write(blurred)

    out.release()

# ─── EFFECT 6: SPEED LINES ───────────────────────────────
def speed_lines(img_path, output_path, duration, fps=12):
    img = np.array(load_image(img_path).convert('RGB'))
    h, w = img.shape[:2]
    cx, cy = w // 2, h // 2
    frames = int(duration * fps)
    out = get_video_writer(output_path, w, h, fps)

    for i in range(frames):
        frame = img.copy()
        overlay = frame.copy()
        num_lines = 32
        for j in range(num_lines):
            angle = (2 * np.pi * j / num_lines)
            length = int(np.sqrt(w*w + h*h) / 2)
            ex = int(cx + length * np.cos(angle))
            ey = int(cy + length * np.sin(angle))
            cv2.line(overlay, (cx, cy), (ex, ey),
                    (255, 255, 255), 1)
        # Pulse opacity
        alpha = 0.25 + 0.15 * np.sin(i * 0.8)
        frame = cv2.addWeighted(overlay, alpha,
                                frame, 1 - alpha, 0)
        out.write(frame)

    out.release()

# ─── EFFECT 7: EMOTION SYMBOL ────────────────────────────
def emotion_symbol(img_path, output_path, emotion,
                   duration, fps=12):
    img = load_image(img_path)
    w, h = img.size
    frames = int(duration * fps)
    out = get_video_writer(output_path, w, h, fps)

    symbols = {
        'confused': '?!',
        'excited': '★',
        'thinking': '...',
        'sad': ';;',
        'angry': '怒',
        'surprised': '!!',
    }
    symbol = symbols.get(emotion, '')

    for i in range(frames):
        frame = img.copy()
        if symbol:
            draw = ImageDraw.Draw(frame)
            # Bounce animation
            bounce = int(8 * abs(np.sin(2 * np.pi * i / fps)))
            x_pos = int(w * 0.72)
            y_pos = int(h * 0.18) - bounce
            # Draw shadow
            draw.text((x_pos+2, y_pos+2), symbol,
                     fill=(0, 0, 0, 180))
            # Draw symbol
            draw.text((x_pos, y_pos), symbol,
                     fill=(255, 220, 0, 255))
        out.write(pil_to_cv(frame))

    out.release()

# ─── EFFECT 8: IMPACT FLASH ──────────────────────────────
def impact_flash(img_path, output_path, fps=12):
    img = load_image(img_path).convert('RGB')
    img_arr = np.array(img)
    h, w = img_arr.shape[:2]
    frames = 6
    out = get_video_writer(output_path, w, h, fps)

    flashes = [255, 200, 150, 100, 50, 0]
    for flash_val in flashes:
        white = np.full_like(img_arr, flash_val)
        blended = cv2.addWeighted(
            img_arr, 1 - flash_val/255,
            white, flash_val/255, 0
        )
        out.write(blended)

    out.release()

# ─── DISPATCHER ──────────────────────────────────────────
if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'No config provided'}))
        sys.exit(1)

    arg = sys.argv[1]

    # Support file path input (for Windows compatibility)
    if arg.endswith('.json') and os.path.exists(arg):
        with open(arg, 'r') as f:
            config = json.load(f)
    else:
        # Try direct JSON string
        try:
            config = json.loads(arg)
        except json.JSONDecodeError:
            # Try cleaning up Windows shell quote mangling
            cleaned = arg.strip("'\"").replace('\\"', '"')
            config = json.loads(cleaned)

    effect = config.get('effect')

    handlers = {
        'breathing':    lambda c: breathing(
            c['input'], c['output'],
            float(c.get('duration', 3.0))),
        'talking':      lambda c: talking_sync(
            c['input'], c['audio'], c['output'],
            float(c['duration'])),
        'pan_right':    lambda c: pan(
            c['input'], c['output'],
            float(c['duration']), 'right'),
        'pan_left':     lambda c: pan(
            c['input'], c['output'],
            float(c['duration']), 'left'),
        'zoom_in':      lambda c: zoom(
            c['input'], c['output'],
            float(c['duration']), 'in'),
        'zoom_out':     lambda c: zoom(
            c['input'], c['output'],
            float(c['duration']), 'out'),
        'whip_pan':     lambda c: whip_pan(
            c['input'], c['input2'], c['output']),
        'speed_lines':  lambda c: speed_lines(
            c['input'], c['output'],
            float(c['duration'])),
        'emotion':      lambda c: emotion_symbol(
            c['input'], c['output'],
            c['emotion'], float(c['duration'])),
        'impact_flash': lambda c: impact_flash(
            c['input'], c['output']),
    }

    handler = handlers.get(effect)
    if handler:
        try:
            handler(config)
            print(json.dumps({'success': True}))
        except Exception as e:
            print(json.dumps({'error': str(e)}))
            sys.exit(1)
    else:
        print(json.dumps({'error': f'Unknown effect: {effect}'}))
        sys.exit(1)
