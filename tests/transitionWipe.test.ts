import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';

// The shape_wipe easing lives in Python, so this asserts against the real module.
//
// The defect: shape_wipe reaches its terminal colour by growing/shrinking a centred
// circle, and both halves drove the radius with ease_in_out — a curve that is nearly
// flat at BOTH ends. The circle therefore sat at r~0 for the first frames of the IN
// half and at full coverage for the last frames of the OUT half, so a 1080x1920 frame
// read as a solid card of the project accent. Measured on a real 11-scene episode:
// 10 fully solid accent frames, 7 of them consecutive (0.29s) on one boundary.
//
// What must NOT change: the shared terminal. The OUT half's last frame and the IN
// half's first frame have to be the same solid colour or the concat cut becomes
// visible — that is the whole reason the transition has a terminal at all.
interface Probe {
  inOld: number; inNew: number;
  outOld: number; outNew: number;
  inStartsSolid: boolean;
  outEndsCovered: boolean;
  usesEaseOutIn: boolean;
  usesEaseInOut_gone: boolean;
}

let p: Probe;

beforeAll(() => {
  const src = String.raw`
import json, math, sys, re
sys.path.insert(0, r'src/scripts')
import numpy as np
from metro_engine_v4 import ease_in, ease_out, ease_in_out

W, H, N = 1080, 1920, 12
hyp = math.hypot(W, H) * 0.55
ys, xs = np.mgrid[0:H:8, 0:W:8]
dist = np.hypot(xs - W / 2, ys - H / 2)
cov = lambda r: 0.0 if r <= 0 else float((dist <= r).mean())

def solid(curve, half):
    n = 0
    for i in range(N):
        c = cov(int(curve(i / (N - 1)) * hyp))
        if half == 'in' and c < 0.05: n += 1
        if half == 'out' and c > 0.95: n += 1
    return n

body = open('src/scripts/metro_engine_v4.py', encoding='utf-8').read()
seg = body[body.index('TRANSITIONS'):]
print(json.dumps({
  'inOld': solid(ease_in_out, 'in'), 'inNew': solid(ease_out, 'in'),
  'outOld': solid(ease_in_out, 'out'), 'outNew': solid(ease_in, 'out'),
  'inStartsSolid': int(ease_out(0.0) * hyp) == 0,
  'outEndsCovered': int(ease_in(1.0) * hyp) == int(hyp),
  'usesEaseOutIn': ('ease_out(p) * math.hypot' in seg) and ('ease_in(p) * math.hypot' in seg),
  'usesEaseInOut_gone': 'ease_in_out(p) * math.hypot' not in seg,
}))
`;
  p = JSON.parse(execFileSync('py', ['-c', src], { encoding: 'utf8', timeout: 120_000 }).trim());
});

describe('the shape_wipe iris does not sit on a solid colour card', () => {
  it('opens the iris straight after the shared terminal frame', () => {
    expect(p.inOld).toBeGreaterThan(p.inNew);
    expect(p.inNew).toBeLessThanOrEqual(1);
  });

  it('reaches full coverage only at the end, instead of holding there', () => {
    expect(p.outOld).toBeGreaterThan(p.outNew);
    expect(p.outNew).toBeLessThanOrEqual(1);
  });

  it('cuts the solid-reading frames per boundary from 7 to 2', () => {
    expect(p.inOld + p.outOld).toBe(7);
    expect(p.inNew + p.outNew).toBe(2);
  });

  it('keeps the terminal both halves have to agree on', () => {
    // Without this the concat cut stops being invisible, which is the only reason
    // the transition paints a full frame of colour in the first place.
    expect(p.inStartsSolid).toBe(true);
    expect(p.outEndsCovered).toBe(true);
  });

  it('actually uses the new curves in the shipped transition code', () => {
    expect(p.usesEaseOutIn).toBe(true);
    expect(p.usesEaseInOut_gone).toBe(true);
  });
});
