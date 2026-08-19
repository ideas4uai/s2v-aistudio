import { describe, it, expect } from 'vitest';
import {
  targetLengthSeconds,
  targetWordCount,
  sceneCountRange,
  MIN_TARGET_SECONDS,
  MAX_TARGET_SECONDS,
} from '../src/utils/targetLength.js';

describe('targetLengthSeconds', () => {
  it('maps the known presets', () => {
    expect(targetLengthSeconds('30s')).toBe(30);
    expect(targetLengthSeconds('60s')).toBe(60);
    expect(targetLengthSeconds('3m')).toBe(180);
    expect(targetLengthSeconds('5m')).toBe(300);
    expect(targetLengthSeconds('10m')).toBe(600);
  });

  it('accepts bare numbers as seconds', () => {
    expect(targetLengthSeconds('300')).toBe(300);
    expect(targetLengthSeconds(300)).toBe(300);
  });

  it('falls back to 60 for unparseable values', () => {
    expect(targetLengthSeconds('huge')).toBe(60);
    expect(targetLengthSeconds(undefined)).toBe(60);
  });

  it('accepts any custom value inside the bounds, not just the presets', () => {
    expect(targetLengthSeconds('42s')).toBe(42);
    expect(targetLengthSeconds('7s')).toBe(7);
    expect(targetLengthSeconds('137s')).toBe(137);
  });

  it('clamps out-of-range values rather than planning an impossible render', () => {
    expect(targetLengthSeconds('1s')).toBe(MIN_TARGET_SECONDS);
    expect(targetLengthSeconds('0s')).toBe(MIN_TARGET_SECONDS);
    expect(targetLengthSeconds('9999s')).toBe(MAX_TARGET_SECONDS);
    expect(targetLengthSeconds('60m')).toBe(MAX_TARGET_SECONDS);
  });
});

describe('targetWordCount', () => {
  it('scales linearly with the target at the shared speaking rate', () => {
    expect(targetWordCount(30)).toBe(75);
    expect(targetWordCount(60)).toBe(150);
    // The non-preset case the presets could never express.
    expect(targetWordCount(42)).toBe(105);
  });
});

describe('sceneCountRange', () => {
  // These used to pin the preset table this function replaced (30s -> 4-5,
  // 60s -> 7-10). That table was built around 7s per scene for shorts, which put
  // a 5.6s floor under every shot and capped a 45s video at 8 scenes — so the cut
  // rate could not approach the reference however the script was written.
  // Measured on the video that actually shipped to YouTube: 10 shots across
  // 37.6s, a 3.76s mean, 16 cuts a minute, against 6.2-8.4 for every automated
  // render. The shorts rate is now 5s, and these assert the new intent.
  it('brackets the shot length that shipped, for a short', () => {
    const [lo, hi] = sceneCountRange(45);
    expect(45 / hi).toBeLessThanOrEqual(3.76 + 0.6);
    expect(45 / lo).toBeGreaterThanOrEqual(3.76);
    expect([lo, hi]).toEqual([8, 11]);
  });

  it('keeps long-form on its own, slower rate', () => {
    // Only the shorts rate moved; 11s per scene past 60s is unchanged.
    expect(sceneCountRange(180)).toEqual([14, 19]);
  });

  it('answers for a custom length no preset row covered', () => {
    const [lo, hi] = sceneCountRange(42);
    expect(lo).toBeLessThan(hi);
    // A short beat is the point, so the per-scene length must stay under the old
    // 5.6s floor rather than drifting back up to it.
    expect(42 / hi).toBeLessThan(5.6);
  });

  it('never asks for fewer than two scenes, however short the target', () => {
    const [lo, hi] = sceneCountRange(MIN_TARGET_SECONDS);
    expect(lo).toBeGreaterThanOrEqual(2);
    expect(hi).toBeGreaterThan(lo);
  });
});
