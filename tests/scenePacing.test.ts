import { describe, it, expect } from 'vitest';
import {
  secondsForWords,
  countWords,
  targetWordCount,
  WORDS_PER_SECOND,
  planScenePadding,
} from '../src/utils/targetLength.js';
import { buildScriptSections, type ScriptBrief } from '../src/pipeline/agents/scriptPrompt.js';

// Every scene constructor wrote `duration_target: s.duration || 5`, and the
// scriptwriter emits no duration, so every scene in every pipeline-created
// project asked for exactly 5 seconds no matter what was written in it.
// Narration then ran 6-9.7s and overran uniformly. That is what made the edit
// metronomic — measured shot-length stdev 0.48s on a 6.18s mean, against 1.44s
// on 3.76s for the video that shipped to YouTube.

describe('secondsForWords', () => {
  it('is the inverse of targetWordCount', () => {
    for (const secs of [2, 4, 6, 8]) {
      expect(secondsForWords(targetWordCount(secs))).toBeCloseTo(secs, 1);
    }
  });

  it('uses the shared rate, not a second copy of it', () => {
    expect(secondsForWords(WORDS_PER_SECOND * 4)).toBe(4);
  });

  it('gives different lengths to different beats — the whole point', () => {
    // The reference video's beats ran 3 to 16 words. A uniform target would
    // collapse these to one number.
    const beats = [3, 7, 10, 16].map(secondsForWords);
    expect(new Set(beats).size).toBe(4);
    expect(Math.max(...beats)).toBeGreaterThan(Math.min(...beats) * 2);
  });

  it('never returns a sub-second target, even for a one-word beat', () => {
    expect(secondsForWords(1)).toBeGreaterThanOrEqual(1);
    expect(secondsForWords(0)).toBeGreaterThanOrEqual(1);
  });

  it('rounds to a quarter second rather than carrying fake precision', () => {
    expect(secondsForWords(13) * 4 % 1).toBe(0);
  });
});

describe('countWords', () => {
  it('ignores padding and collapsed whitespace', () => {
    expect(countWords('  a   b \n c ')).toBe(3);
  });
  it('is 0 for nothing', () => {
    expect(countWords('')).toBe(0);
    expect(countWords(null)).toBe(0);
    expect(countWords(undefined)).toBe(0);
  });
});

describe('derived targets still feed planScenePadding', () => {
  it('a varied set of scenes pads without collapsing back to uniform', () => {
    // The padding system is untouched — it must keep receiving real per-scene
    // narration durations and keep its proportional behaviour.
    const narration = [3, 7, 10, 16].map(secondsForWords);
    const plan = planScenePadding(narration, 45);
    expect(plan.durations.length).toBe(4);
    // proportions preserved: the longest stays the longest by the same ratio
    const ratioBefore = Math.max(...narration) / Math.min(...narration);
    const ratioAfter = Math.max(...plan.durations) / Math.min(...plan.durations);
    expect(ratioAfter).toBeCloseTo(ratioBefore, 5);
  });
});

describe('the script prompt asks for varied beats', () => {
  const brief: ScriptBrief = {
    topic: 'Playwright AI agents',
    targetSeconds: 45,
  } as ScriptBrief;

  it('states an average rather than a per-scene quota', () => {
    const objective = String(buildScriptSections(brief).objective);
    expect(objective).toMatch(/averaging/i);
    expect(objective).not.toMatch(/scenes of about \d+ words each/i);
  });

  it('explicitly demands short beats among the long ones', () => {
    const objective = String(buildScriptSections(brief).objective);
    expect(objective).toMatch(/vary scene length/i);
    expect(objective).toMatch(/at least two scenes must be markedly shorter/i);
  });

  it('does not set a per-scene floor that forbids the short beats it asks for', () => {
    // These two rules contradicted before: the floor was 0.6 of the average
    // while the objective wanted beats at 0.45. The floor won, and every scene
    // came out the same length.
    const all = JSON.stringify(buildScriptSections(brief));
    const floor = Number(/narration may be under (\d+) words/.exec(all)?.[1]);
    const shortLo = Number(/land in (\d+)-\d+ words/.exec(all)?.[1]);
    expect(floor).toBeGreaterThan(0);
    expect(shortLo).toBeGreaterThan(0);
    expect(floor).toBeLessThanOrEqual(shortLo);
  });
});
