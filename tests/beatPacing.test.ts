import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { sceneBeats, beatHoldWeights, beatShares, BEAT_HOLD } from '../src/utils/beats.js';
import { planScenePadding } from '../src/utils/targetLength.js';

/**
 * Pacing used to be a function of sentence length and nothing else.
 *
 * Every scene claimed `target * words / totalWords` of the runtime, so a hook and a
 * close of equal word count were held for equal time. Measured on the video that
 * shipped to YouTube: 10 shots across 37.6s, mean 3.76s, stdev 1.44s. Automated renders
 * measured 0.48s stdev on a 6.18s mean — the same shot, eight times.
 *
 * These pin the two properties that make the redistribution safe: the total is
 * unchanged, and no narration is ever shortened to make it fit.
 */

const scene = (order: number, words: number, over: Record<string, unknown> = {}) => ({
  scene_id: `s${order}`,
  order,
  narration_text: Array.from({ length: words }, (_, i) => `w${i}`).join(' '),
  ...over,
});

/** Six spoken scenes: hook, payload, three escalations, payoff. */
const six = () => Array.from({ length: 6 }, (_, i) => scene(i, 10));

describe('sceneBeats', () => {
  it('reads the arc off the scenes that actually speak', () => {
    expect(sceneBeats(six()))
      .toEqual(['hook', 'payload', 'escalation', 'escalation', 'escalation', 'payoff']);
  });

  it('puts the close on the last SPOKEN scene, not the last scene', () => {
    // The serialized-universe tease appends a wordless visual beat. The payoff belongs
    // on the line that ends the episode, not on the silent card after it.
    const scenes = [...six(), scene(6, 0, { narration_text: '   ' })];
    const beats = sceneBeats(scenes);
    expect(beats[5]).toBe('payoff');
    expect(beats[6]).toBeNull();
  });

  it('degrades rather than inventing beats on a short episode', () => {
    // Two scenes are an open and a close. Calling the second one the payload would be
    // pacing the close as if something came after it.
    expect(sceneBeats([scene(0, 8), scene(1, 8)])).toEqual(['hook', 'payoff']);
    expect(sceneBeats([scene(0, 8)])).toEqual(['payoff']);
    expect(sceneBeats([])).toEqual([]);
  });

  it('gives a wordless scene no beat at all', () => {
    const scenes = [scene(0, 6), scene(1, 0, { narration_text: '' }), scene(2, 6), scene(3, 6)];
    expect(sceneBeats(scenes)).toEqual(['hook', null, 'payload', 'payoff']);
  });
});

describe('beatHoldWeights', () => {
  it('cuts the hook tight and holds the close', () => {
    const w = beatHoldWeights(six());
    expect(w[0]).toBe(BEAT_HOLD.hook);
    expect(w[5]).toBe(BEAT_HOLD.payoff);
    expect(w[0]).toBeLessThan(1);
    expect(w[5]).toBeGreaterThan(w[1]);   // payoff over payload
    expect(w[1]).toBeGreaterThan(w[0]);   // payload over hook
  });

  it('tightens across the escalation instead of holding it flat', () => {
    const w = beatHoldWeights(six());
    const run = w.slice(2, 5);
    expect(run[0]).toBeGreaterThan(run[1]);
    expect(run[1]).toBeGreaterThan(run[2]);
    // and it accelerates within the band, never past it
    expect(Math.min(...run)).toBeGreaterThanOrEqual(0.8);
    expect(Math.max(...run)).toBeLessThanOrEqual(BEAT_HOLD.escalation);
  });

  it('takes the top of the ramp for a lone escalation beat', () => {
    // Nothing to accelerate away from, so it must not be given the floor by accident.
    const w = beatHoldWeights([scene(0, 6), scene(1, 6), scene(2, 6), scene(3, 6)]);
    expect(w[2]).toBe(BEAT_HOLD.escalation);
  });

  it('weighs an unpaced scene at 1 rather than penalising it', () => {
    const scenes = [scene(0, 6), scene(1, 0, { narration_text: '' }), scene(2, 6), scene(3, 6)];
    expect(beatHoldWeights(scenes)[1]).toBe(1);
  });
});

describe('beatShares distributes the requested runtime without changing it', () => {
  it('still sums to exactly the target', () => {
    // The whole safety argument. Weighting redistributes; it must never inflate.
    for (const target of [30, 45, 60, 180]) {
      const shares = beatShares(six(), target);
      expect(shares.reduce((n, s) => n + s, 0)).toBeCloseTo(target, 6);
    }
  });

  it('sums to the target on uneven scenes too', () => {
    const scenes = [scene(0, 4), scene(1, 17), scene(2, 9), scene(3, 3), scene(4, 12)];
    expect(beatShares(scenes, 60).reduce((n, s) => n + s, 0)).toBeCloseTo(60, 6);
  });

  it('separates two identically-worded scenes — the point of the change', () => {
    // Under the old formula these four were the same number, four times over.
    const shares = beatShares(six(), 60);
    expect(shares[0]).toBeLessThan(shares[5]);
    expect(new Set(shares.map((s) => s.toFixed(3))).size).toBeGreaterThan(3);
    // The close gets meaningfully more than the open, not a rounding difference.
    expect(shares[5] / shares[0]).toBeGreaterThan(1.3);
  });

  it('still lets word count drive most of it', () => {
    // A beat twice as long is still the longer shot. The weighting is a lean, not an
    // override — a 16-word hook must not be cut shorter than a 3-word escalation.
    const scenes = [scene(0, 16), scene(1, 6), scene(2, 3), scene(3, 6)];
    const shares = beatShares(scenes, 60);
    expect(shares[0]).toBeGreaterThan(shares[2]);
  });

  it('is 0 across the board for a script with no words', () => {
    expect(beatShares([scene(0, 0, { narration_text: '' })], 60)).toEqual([0]);
    expect(beatShares([], 60)).toEqual([]);
  });
});

describe('the word-budget guarantee survives the redistribution', () => {
  it('never shortens a scene below its own narration', () => {
    // planScenePadding pads and never trims, and the orchestrator feeds it the share
    // as a target. A share smaller than the narration must therefore produce the
    // narration length, not a cut.
    const narration = [6.4, 3.1, 8.0, 5.2, 4.4, 7.7];
    const scenes = narration.map((_, i) => scene(i, 10));
    const shares = beatShares(scenes, 30);   // deliberately under-budget
    narration.forEach((d, i) => {
      expect(planScenePadding([d], shares[i]).durations[0]).toBeGreaterThanOrEqual(d);
    });
  });

  it('adds no dead air the unweighted plan would not have added', () => {
    // Total silence is bounded by the same MAX_PAD_FACTOR per scene as before, so
    // redistributing cannot make the episode emptier than the old plan's own ceiling.
    const narration = [6.4, 3.1, 8.0, 5.2, 4.4, 7.7];
    const scenes = narration.map((_, i) => scene(i, 10));
    const target = 60;
    const weighted = beatShares(scenes, target)
      .map((s, i) => planScenePadding([narration[i]], s).durations[0]);
    const spoken = narration.reduce((n, d) => n + d, 0);
    const silence = weighted.reduce((n, d) => n + d, 0) - spoken;
    expect(silence).toBeGreaterThanOrEqual(0);
    expect(silence).toBeLessThanOrEqual(spoken * 0.5 + 1e-9);   // MAX_PAD_FACTOR 1.5x
  });
});

describe('the orchestrator actually uses it', () => {
  const orch = fs.readFileSync(path.join(process.cwd(), 'src/pipeline/orchestrator.ts'), 'utf-8');

  it('claims the share by beat rather than by word count alone', () => {
    expect(orch).toContain('const share = beatShares(project.scenes, target)[here] ?? 0;');
    // The formula it replaced must be gone, or both would be live.
    expect(orch).not.toMatch(/target \* words\(scene\.narration_text\) \/ totalWords/);
  });

  it('still hands the share to planScenePadding, not to a second padding system', () => {
    const i = orch.indexOf('const share = beatShares(');
    expect(orch.indexOf('planScenePadding([audioDur], share)')).toBeGreaterThan(i);
  });
});
