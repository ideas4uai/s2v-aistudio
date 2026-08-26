"""Drop the black bars the image model bakes into a generated still.

The image model is asked for 16:9 (or 9:16) and honours it as a canvas size, but it
often draws a *film still* on that canvas — picture in the middle, black bars top and
bottom. Nothing downstream removes them: `load_tall_canvas` scales whatever it is
handed to fill the frame, so the bars are scaled up too and land in the finished video.
Measured on this project's own corpus: 25% of generated stills carry bars, the worst
losing 53% of the height, and a real 1344x768 still put 33.8% black into a 1920x1080
frame.

Prompting the model not to do it does not work — a prompt saying "no letterbox, no
black bars" produced *more* bars than one that never mentioned them (the model draws
what it reads). So this is done after the fact, where it is deterministic.

A bar is a run of rows (or columns) from the edge that is not merely dark but *empty*:
mean below MEAN_MAX and no pixel above PEAK_MAX. Real dark content — a night sky, a
shadowed interior — has highlights and fails the peak test, which is what keeps this
from eating a deliberately low-key frame.
"""
import sys

import cv2
import numpy as np

MEAN_MAX = 10.0    # a bar's average level; real content sits well above this
PEAK_MAX = 40      # a bar has no highlights at all — this is what protects night scenes
MIN_FRAC = 0.01    # ignore a bar thinner than 1% of the side; not worth a re-encode
KEEP_FRAC = 0.40   # never keep less than this much of a side — bail rather than gut it


def _bar(lines: np.ndarray) -> int:
    """How many leading rows of `lines` (each row already reduced to one scanline) are bar."""
    n = 0
    while n < len(lines) and lines[n].mean() < MEAN_MAX and lines[n].max() <= PEAK_MAX:
        n += 1
    return n


def strip(img: np.ndarray) -> np.ndarray:
    """Return `img` with edge letterbox/pillarbox removed, or unchanged if there is none."""
    grey = cv2.cvtColor(img[:, :, :3], cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    h, w = grey.shape

    top, bottom = _bar(grey), _bar(grey[::-1])
    left, right = _bar(grey.T), _bar(grey.T[::-1])

    # A bar under MIN_FRAC is noise; a crop that would keep less than KEEP_FRAC is a
    # sign this is a dark picture rather than a bordered one, so leave it alone.
    def take(a: int, b: int, side: int) -> tuple:
        if max(a, b) < side * MIN_FRAC:
            return 0, side
        if side - a - b < side * KEEP_FRAC:
            return 0, side
        return a, side - b

    y0, y1 = take(top, bottom, h)
    x0, x1 = take(left, right, w)
    return img[y0:y1, x0:x1]


def selftest() -> int:
    """The guards are the whole risk here: too eager and a night scene loses its sky."""
    pic = np.full((400, 800, 3), 90, np.uint8)

    letterboxed = pic.copy()
    letterboxed[:80] = 0
    letterboxed[-80:] = 0
    assert strip(letterboxed).shape[:2] == (240, 800), 'plain letterbox must come off'

    # A night sky is dark on average but carries highlights all through it, and that is
    # what separates it from a bar. Every row keeps a star, so none of it may be cropped.
    dark = pic.copy()
    dark[:80] = 4
    dark[:80, ::40] = 255
    assert strip(dark).shape[:2] == (400, 800), 'a dark band with highlights is content'

    # An all-black frame would crop to nothing; KEEP_FRAC must refuse it.
    assert strip(np.zeros((400, 800, 3), np.uint8)).shape[:2] == (400, 800), 'never gut the frame'

    # A 3px edge is noise, not a bar.
    thin = pic.copy()
    thin[:3] = 0
    assert strip(thin).shape[:2] == (400, 800), 'a hairline edge is not a letterbox'

    # Pillarbox too, and stripping twice must change nothing the second time.
    pillar = pic.copy()
    pillar[:, :120] = 0
    pillar[:, -120:] = 0
    once = strip(pillar)
    assert once.shape[:2] == (400, 560), 'pillarbox must come off'
    assert strip(once).shape == once.shape, 'stripping is idempotent'

    print('selftest ok')
    return 0


def main() -> int:
    if sys.argv[1:2] == ['--selftest']:
        return selftest()
    src, dst = sys.argv[1], sys.argv[2]
    img = cv2.imread(src, cv2.IMREAD_UNCHANGED)
    if img is None:
        print(f'unreadable: {src}', file=sys.stderr)
        return 1
    out = strip(img)
    if out.shape == img.shape:
        print('none')
        return 0
    cv2.imwrite(dst, out)
    print(f'{img.shape[1]}x{img.shape[0]} -> {out.shape[1]}x{out.shape[0]}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
