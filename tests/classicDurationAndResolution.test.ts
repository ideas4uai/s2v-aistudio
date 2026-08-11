import { describe, it, expect } from 'vitest';
import { outputResolution, isShortsProject } from '../src/services/renderService.js';
import { planScenePadding, MAX_PAD_FACTOR, TARGET_TOLERANCE } from '../src/utils/targetLength.js';

describe('outputResolution', () => {
  it('maps every export resolution for 9:16 shorts', () => {
    expect(outputResolution('720p', true)).toEqual({ w: 720, h: 1280 });
    expect(outputResolution('1080p', true)).toEqual({ w: 1080, h: 1920 });
    expect(outputResolution('4k', true)).toEqual({ w: 2160, h: 3840 });
  });

  it('maps every export resolution for 16:9 landscape', () => {
    expect(outputResolution('720p', false)).toEqual({ w: 1280, h: 720 });
    expect(outputResolution('1080p', false)).toEqual({ w: 1920, h: 1080 });
    expect(outputResolution('4k', false)).toEqual({ w: 3840, h: 2160 });
  });

  it('defaults to 1080p for missing or unknown settings', () => {
    expect(outputResolution(undefined, true)).toEqual({ w: 1080, h: 1920 });
    expect(outputResolution('8k', false)).toEqual({ w: 1920, h: 1080 });
  });

  it('pins preview renders to the 720 class whatever the setting says', () => {
    expect(outputResolution('4k', true, true)).toEqual({ w: 720, h: 1280 });
    expect(outputResolution('1080p', false, true)).toEqual({ w: 1280, h: 720 });
  });
});

describe('isShortsProject', () => {
  it('treats 9:16, universe and story_episode projects as shorts', () => {
    expect(isShortsProject({ settings: { aspectRatio: '9:16' } })).toBe(true);
    expect(isShortsProject({ universe: 'aiqa' })).toBe(true);
    expect(isShortsProject({ projectType: 'story_episode' })).toBe(true);
  });

  it('treats everything else as landscape', () => {
    expect(isShortsProject({ settings: { aspectRatio: '16:9' } })).toBe(false);
    expect(isShortsProject(undefined)).toBe(false);
  });
});

describe('planScenePadding', () => {
  it('reaches the target within tolerance when the narration allows it', () => {
    const plan = planScenePadding([8, 6, 6], 30);
    expect(plan.reachedTarget).toBe(true);
    expect(plan.total).toBeCloseTo(30, 5);
    expect(Math.abs(plan.total - 30) / 30).toBeLessThanOrEqual(TARGET_TOLERANCE);
  });

  it('distributes the hold proportionally and never trims a scene', () => {
    const narration = [8, 6, 6];
    const plan = planScenePadding(narration, 30);
    plan.durations.forEach((d, i) => expect(d).toBeGreaterThanOrEqual(narration[i]));
    // Same factor everywhere: the longest scene absorbs the most hold.
    expect(plan.durations[0] / narration[0]).toBeCloseTo(plan.durations[1] / narration[1], 5);
  });

  it('respects the 1.5x per-scene cap', () => {
    const narration = [4, 3, 3];
    const plan = planScenePadding(narration, 60);
    plan.durations.forEach((d, i) =>
      expect(d).toBeLessThanOrEqual(narration[i] * MAX_PAD_FACTOR + 1e-9));
    expect(plan.total).toBeCloseTo(15, 5);
  });

  it('reports an honest "cannot reach" instead of injecting silence', () => {
    // 30 words of manual script against a 60s target: ~10s of speech, unreachable.
    const plan = planScenePadding([10], 60);
    expect(plan.reachedTarget).toBe(false);
    expect(plan.total).toBeCloseTo(15, 5);
    expect(plan.maxAchievable).toBeCloseTo(15, 5);
  });

  it('does not pad when the narration already meets or exceeds the target', () => {
    const over = planScenePadding([20, 20], 30);
    expect(over.durations).toEqual([20, 20]);
    expect(over.total).toBe(40);
    expect(over.reachedTarget).toBe(true);
  });

  it('does not pad when already inside the tolerance band', () => {
    // 27s against a 30s target is within -15%, so leave it alone.
    const plan = planScenePadding([27], 30);
    expect(plan.durations).toEqual([27]);
    expect(plan.reachedTarget).toBe(true);
  });

  it('handles an empty or silent scene list without dividing by zero', () => {
    const plan = planScenePadding([], 30);
    expect(plan.durations).toEqual([]);
    expect(plan.total).toBe(0);
    expect(plan.reachedTarget).toBe(false);
  });
});
