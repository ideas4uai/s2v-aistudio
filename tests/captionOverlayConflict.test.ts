import { describe, it, expect } from 'vitest';
import { cueFade, mutedCaptionWindow } from '../src/services/renderService.js';
import { OVERLAY_RESTATES_NARRATION, type OverlayKind } from '../src/services/overlayPlan.js';

// Two defects found in human review of the parity comparison, both introduced by
// the caption/overlay work rather than pre-existing.
//
// 1. Captions read late. Measured on the real render: the first cue is scheduled
//    at 0.231s — 19ms BEFORE the 0.250s speech onset, so the timing data was
//    already correct — but did not cross visibility until 0.375s. 125ms late,
//    past the +/-100ms tolerance the original caption-sync work set. Cause was
//    the symmetric 110ms \fad, which on a 344ms cue spent 220ms fading.
//
// 2. The closing beat drew the payoff overlay AND the bottom caption with the
//    same words, and in the final frames the two blocks overlapped.

describe('cueFade — in fast, out slow', () => {
  it('completes the in-fade inside one frame at 24fps', () => {
    // 1000/24 = 41.7ms. An in-fade longer than that delays the cue by a frame or
    // more, which is exactly what put it 125ms behind.
    expect(cueFade(2.0).inMs).toBeLessThanOrEqual(41);
  });

  it('is asymmetric — leaving late costs nothing, arriving late costs sync', () => {
    const { inMs, outMs } = cueFade(2.0);
    expect(outMs).toBeGreaterThan(inMs);
  });

  it('keeps a typical short cue mostly at full opacity', () => {
    // The measured failing case: a one-word cue, 344ms.
    const dur = 0.344;
    const { inMs, outMs } = cueFade(dur);
    const solid = dur * 1000 - inMs - outMs;
    expect(solid).toBeGreaterThan(dur * 1000 * 0.6);
    // and the perceived arrival is inside tolerance
    expect(inMs).toBeLessThan(100);
  });

  it('never spends more time fading than showing, however short the cue', () => {
    for (const dur of [0.05, 0.1, 0.2, 0.344, 1, 3]) {
      const { inMs, outMs } = cueFade(dur);
      expect(inMs + outMs).toBeLessThanOrEqual(dur * 1000);
    }
  });

  it('is safe at zero and negative durations', () => {
    expect(cueFade(0)).toEqual({ inMs: 0, outMs: 0 });
    expect(cueFade(-1)).toEqual({ inMs: 0, outMs: 0 });
  });
});

describe('mutedCaptionWindow — which display wins', () => {
  const scene = (drawn?: any) => (drawn ? { overlay_drawn: drawn } : {});

  it('mutes captions where a payoff overlay is drawing the same words', () => {
    expect(mutedCaptionWindow(scene({ kind: 'payoff', start: 2, end: 6 })))
      .toEqual({ start: 2, end: 6 });
  });

  it('mutes captions under kinetic text too — it also restates narration', () => {
    expect(mutedCaptionWindow(scene({ kind: 'kinetic', start: 0.4, end: 2.9 })))
      .toEqual({ start: 0.4, end: 2.9 });
  });

  it('leaves captions alone under a treatment that shows derived content', () => {
    // A diagram, comparison, stat or namecard shows steps / sides / a figure /
    // a title. None of those are in the caption track, so both belong on screen.
    for (const kind of ['diagram', 'comparison', 'stat', 'namecard'] as OverlayKind[]) {
      expect(OVERLAY_RESTATES_NARRATION.has(kind)).toBe(false);
      expect(mutedCaptionWindow(scene({ kind, start: 1, end: 4 }))).toBeNull();
    }
  });

  it('covers exactly the two kinds that restate narration', () => {
    expect([...OVERLAY_RESTATES_NARRATION].sort()).toEqual(['kinetic', 'payoff']);
  });

  // ── the fallback: a beat must never end up with no text at all ──
  it('draws every cue when no overlay was rendered', () => {
    expect(mutedCaptionWindow(scene())).toBeNull();
  });

  it('draws every cue when the overlay was planned but did not render', () => {
    // markOverlayDrawn deletes the field on failure rather than recording intent,
    // so this is the shape a failed overlay actually leaves behind.
    expect(mutedCaptionWindow({ overlay_drawn: undefined })).toBeNull();
    expect(mutedCaptionWindow({ overlaySpec: { kind: 'payoff' } })).toBeNull();
  });

  it('draws every cue for a degenerate window', () => {
    expect(mutedCaptionWindow(scene({ kind: 'payoff', start: 3, end: 3 }))).toBeNull();
    expect(mutedCaptionWindow(scene({ kind: 'payoff', start: 5, end: 2 }))).toBeNull();
  });

  it('is safe on a null scene', () => {
    expect(mutedCaptionWindow(null)).toBeNull();
    expect(mutedCaptionWindow(undefined)).toBeNull();
  });
});

describe('cue selection against a muted window', () => {
  // Mirrors the midpoint rule writeCaptionAss applies, so the boundary behaviour
  // is pinned somewhere other than inside a 200-line function.
  const keep = (cues: Array<[number, number]>, muted: { start: number; end: number } | null) =>
    cues.filter(([s, e]) => !(muted && (s + e) / 2 >= muted.start && (s + e) / 2 <= muted.end));

  const cues: Array<[number, number]> = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]];

  it('drops only the cues inside the overlay window', () => {
    expect(keep(cues, { start: 2, end: 4 })).toEqual([[0, 1], [1, 2], [4, 5]]);
  });

  it('keeps every cue when nothing is muted', () => {
    expect(keep(cues, null)).toEqual(cues);
  });

  it('sends a straddling cue whole to one side — never half-vanished', () => {
    // midpoint 1.5 sits outside a window starting at 1.6, so the cue survives intact
    expect(keep([[1, 2]], { start: 1.6, end: 3 })).toEqual([[1, 2]]);
    // midpoint 1.5 sits inside a window starting at 1.4, so it goes entirely
    expect(keep([[1, 2]], { start: 1.4, end: 3 })).toEqual([]);
  });
});
