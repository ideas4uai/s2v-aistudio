import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';

// The camera and the grade are Python, so these assert against the real module
// rather than a transcription of it.
//
// Three things were wrong and all three were invisible from TypeScript:
//   - the neutral camera branch used raw t/duration while the smoothstep of that
//     exact value sat computed one line above, so the motion that shipped was
//     linear (measured per-second drift 1.83/1.77/1.79/1.74 px — a straight line)
//   - the neutral grade was an identity transform, so the colour pass ran on
//     every frame of every render and changed nothing
//   - detectEmotion emits seven values against six palette keys, so five of them
//     fell through to neutral and lost both their grade and their camera move
//
// Everything is gathered in ONE `py` spawn: several test files already shell out
// to Python, and vitest runs files in parallel, so a spawn per assertion made the
// suite flaky under contention rather than making it more thorough.

interface Probe {
  resolved: string[];
  allInPalettes: boolean;
  unknown: string;
  nullish: string;
  neutral: { co: number; ds: number; br: number };
  camera: Array<[number, number]>;
}

let probe: Probe;

beforeAll(() => {
  const script = `
import importlib.util, sys, json
spec = importlib.util.spec_from_file_location("m", "src/scripts/metro_engine_v4.py")
m = importlib.util.module_from_spec(spec); sys.modules["m"] = m; spec.loader.exec_module(m)

emitted = ["confused","excited","thinking","angry","sad","surprised","neutral"]
c = m.CameraPath("neutral", 6.0, unified=True)
n = 11
print(json.dumps({
  "resolved": [m.resolve_emotion(e) for e in emitted],
  "allInPalettes": all(m.resolve_emotion(e) in m.EMOTION_PALETTES for e in emitted),
  "unknown": m.resolve_emotion("wombat"),
  "nullish": m.resolve_emotion(None),
  "neutral": {k: m.EMOTION_PALETTES["neutral"][k] for k in ("co","ds","br")},
  "camera": [[z, tx] for z, tx, *_ in (c.at(6.0 * i / (n - 1)) for i in range(n))],
}))
`;
  probe = JSON.parse(execFileSync('py', ['-c', script], { encoding: 'utf-8', timeout: 120_000 }));
}, 130_000);

describe('emotion resolution', () => {
  it('gives every value detectEmotion emits a palette that exists', () => {
    expect(probe.resolved).toHaveLength(7);
    expect(probe.allInPalettes).toBe(true);
  });

  it('no longer collapses five of the seven to neutral', () => {
    expect(new Set(probe.resolved).size).toBeGreaterThan(1);
    expect(probe.resolved.filter((r) => r === 'neutral')).toHaveLength(1);
  });

  it('still falls back to neutral for a value nobody defined', () => {
    expect(probe.unknown).toBe('neutral');
    expect(probe.nullish).toBe('neutral');
  });
});

describe('the neutral grade is not an identity transform', () => {
  it('actually changes contrast and saturation', () => {
    expect(probe.neutral.co).not.toBe(1.0);
    expect(probe.neutral.ds).toBeGreaterThan(0);
  });

  it('lifts contrast rather than flattening — consistency without contrast reads as monotony', () => {
    expect(probe.neutral.co).toBeGreaterThan(1.0);
  });
});

describe('the neutral camera move', () => {
  it('is eased, not linear — per-step drift must vary across the shot', () => {
    const tx = probe.camera.map((r) => r[1]);
    const steps = tx.slice(1).map((v, i) => v - tx[i]);
    const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
    // A smoothstep is slow at both ends and fast in the middle; linear motion
    // would make every step identical.
    expect(steps[Math.floor(steps.length / 2)] / mean).toBeGreaterThan(1.2);
    expect(steps[0] / mean).toBeLessThan(0.6);
  });

  it('zooms — it was a constant, which is a crop and not a move', () => {
    const zooms = probe.camera.map((r) => r[0]);
    expect(Math.max(...zooms)).toBeGreaterThan(Math.min(...zooms) + 0.01);
  });

  it('travels far enough to be seen', () => {
    // Background travel = 0.7 * tx range. Below roughly 25px across a six-second
    // shot on a 1080-wide frame a viewer does not read it as motion; the old
    // values gave 10.8px.
    const tx = probe.camera.map((r) => r[1]);
    expect(0.7 * Math.abs(tx[tx.length - 1] - tx[0])).toBeGreaterThan(25);
  });
});
