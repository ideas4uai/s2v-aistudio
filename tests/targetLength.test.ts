import { describe, it, expect } from 'vitest';
import { targetLengthSeconds } from '../src/utils/targetLength.js';

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
});
