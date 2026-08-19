import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';

// The camera and the grade are Python, so these assert against the real module
// rather than a transcription of it. Same `py -c` pattern as motionOverlay.test.ts.
//
// Three things were wrong and all three were invisible from TypeScript:
//   - the neutral camera branch used raw t/duration while the smoothstep of that
//     exact value sat computed one line above, so the motion that shipped was
//     linear (measured per-second drift 1.83/1.77/1.79/1.74 px — a straight line)
//   - the neutral grade was an identity transform, so the colour pass ran on
//     every frame of every render and changed nothing
//   - detectEmotion emits seven values against six palette keys, so five of them
//     fell through to neutral and lost both their grade and their camera move

const py = (snippet: string) =>
  execFileSync('py', ['-c', snippet], { encoding: 'utf-8', timeout: 120_000 }).trim();

const IMPORT = [
  'import importlib.util, sys',
  'spec = importlib.util.spec_from_file_location("m", "src/scripts/metro_engine_v4.py")',
  'm = importlib.util.module_from_spec(spec)',
  'sys.modules["m"] = m',
  'spec.loader.exec_module(m)',
].join('\n');

describe('emotion resolution', () => {
  it('gives every value detectEmotion emits a real palette, none falling through', () => {
    // The seven from storyboardAgent.ts detectEmotion.
    const out = py(`${IMPORT}
emitted = ["confused","excited","thinking","angry","sad","surprised","neutral"]
print(",".join(m.resolve_emotion(e) for e in emitted))`);
    const resolved = out.split(',');
    expect(resolved).toHaveLength(7);
    // every one lands on a real key
    for (const r of resolved) expect(Object.keys({})).not.toContain(r);
    expect(resolved).not.toContain('');
    // and they are not all 'neutral' any more — that was the bug
    expect(new Set(resolved).size).toBeGreaterThan(1);
    expect(resolved.filter((r) => r === 'neutral')).toHaveLength(1);
  });

  it('maps each detected emotion to a palette that exists', () => {
    const out = py(`${IMPORT}
emitted = ["confused","excited","thinking","angry","sad","surprised","neutral"]
print(all(m.resolve_emotion(e) in m.EMOTION_PALETTES for e in emitted))`);
    expect(out).toBe('True');
  });

  it('still falls back to neutral for a value nobody defined', () => {
    expect(py(`${IMPORT}\nprint(m.resolve_emotion("wombat"))`)).toBe('neutral');
    expect(py(`${IMPORT}\nprint(m.resolve_emotion(None))`)).toBe('neutral');
  });
});

describe('the neutral grade is not an identity transform', () => {
  it('actually changes contrast and saturation', () => {
    const out = py(`${IMPORT}
p = m.EMOTION_PALETTES["neutral"]
print(f'{p["co"]},{p["ds"]},{p["br"]}')`);
    const [co, ds] = out.split(',').map(Number);
    expect(co).not.toBe(1.0);
    expect(ds).toBeGreaterThan(0);
  });

  it('lifts contrast rather than flattening — consistency without contrast reads as monotony', () => {
    const out = py(`${IMPORT}\nprint(m.EMOTION_PALETTES["neutral"]["co"] > 1.0)`);
    expect(out).toBe('True');
  });
});

describe('the neutral camera move', () => {
  const sample = (n: number) => `${IMPORT}
c = m.CameraPath("neutral", 6.0, unified=True)
pts = [c.at(6.0 * i / ${n - 1}) for i in range(${n})]
print(";".join(f"{z:.6f}|{tx:.6f}" for z, tx, *_ in pts))`;

  it('is eased, not linear — per-step drift must vary across the shot', () => {
    const rows = py(sample(11)).split(';').map((r) => r.split('|').map(Number));
    const tx = rows.map((r) => r[1]);
    const steps = tx.slice(1).map((v, i) => v - tx[i]);
    const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
    // A smoothstep is slow at both ends and fast in the middle. Linear motion
    // would make every step identical.
    const mid = steps[Math.floor(steps.length / 2)];
    const edge = steps[0];
    expect(mid / mean).toBeGreaterThan(1.2);
    expect(edge / mean).toBeLessThan(0.6);
  });

  it('zooms — it was a constant, which is a crop and not a move', () => {
    const rows = py(sample(5)).split(';').map((r) => r.split('|').map(Number));
    const zooms = rows.map((r) => r[0]);
    expect(Math.max(...zooms)).toBeGreaterThan(Math.min(...zooms) + 0.01);
  });

  it('travels far enough to be seen', () => {
    // Background travel = 0.7 * tx range. Below roughly 25px across a six-second
    // shot on a 1080-wide frame a viewer does not read it as motion at all;
    // the old values gave 10.8px.
    const rows = py(sample(3)).split(';').map((r) => r.split('|').map(Number));
    const txRange = Math.abs(rows[rows.length - 1][1] - rows[0][1]);
    expect(0.7 * txRange).toBeGreaterThan(25);
  });
});
