import { describe, it, expect } from 'vitest';
import { pickMotion, ALTERNATING_MOTIONS } from '../src/pipeline/agents/storyboardAgent.js';

const seq = (settings: any, n = 6) =>
  Array.from({ length: n }, (_, i) => pickMotion({ settings } as any, i));

describe('pickMotion default', () => {
  it('genuinely alternates across every scene, not just the first two', () => {
    // The original bug: `idx === 0 ? 'zoom_in' : 'pan_right'` produced
    // zoom_in, pan_right, pan_right, pan_right, pan_right, pan_right.
    expect(seq({})).toEqual([
      'zoom_in', 'pan_right', 'zoom_in', 'pan_right', 'zoom_in', 'pan_right',
    ]);
  });

  it('never repeats the same motion on consecutive scenes', () => {
    const s = seq({}, 10);
    for (let i = 1; i < s.length; i++) {
      expect(s[i], `scene ${i} repeats scene ${i - 1}`).not.toBe(s[i - 1]);
    }
  });

  it('uses both motions rather than settling on one', () => {
    expect(new Set(seq({}, 10)).size).toBe(ALTERNATING_MOTIONS.length);
  });

  it('treats an explicit "alternate" the same as the default', () => {
    expect(seq({ motionEffect: 'alternate' })).toEqual(seq({}));
  });
});

describe('pickMotion explicit selections', () => {
  it('honours a fixed pick on every scene', () => {
    for (const e of ['still', 'zoom_in', 'zoom_out', 'pan_right', 'pan_left']) {
      expect(seq({ motionEffect: e })).toEqual(Array(6).fill(e));
    }
  });

  it('keeps random selectable and drawing from the four Ken Burns effects', () => {
    const draws = Array.from({ length: 200 }, (_, i) => pickMotion({ settings: { motionEffect: 'random' } } as any, i));
    expect(new Set(draws)).toEqual(new Set(['zoom_in', 'zoom_out', 'pan_right', 'pan_left']));
  });

  it('is no longer the default — an unset project must be deterministic', () => {
    // Two independent passes over the same project must agree. Under a random
    // default they would not, which is the property that made it wrong as a default.
    expect(seq({})).toEqual(seq({}));
  });
});
