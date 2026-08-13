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
  it('reproduces the preset table it replaced, within a scene', () => {
    expect(sceneCountRange(30)).toEqual([4, 5]);   // table said 4-6
    expect(sceneCountRange(60)).toEqual([7, 10]);  // table said 7-9
    expect(sceneCountRange(180)).toEqual([14, 19]); // table said 14-18
  });

  it('answers for a custom length the table had no row for', () => {
    const [lo, hi] = sceneCountRange(42);
    expect(lo).toBeLessThan(hi);
    expect(lo).toBeGreaterThanOrEqual(4);
    expect(hi).toBeLessThanOrEqual(8);
  });

  it('never asks for fewer than two scenes, however short the target', () => {
    const [lo, hi] = sceneCountRange(MIN_TARGET_SECONDS);
    expect(lo).toBeGreaterThanOrEqual(2);
    expect(hi).toBeGreaterThan(lo);
  });
});
