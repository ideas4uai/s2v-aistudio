import { describe, it, expect } from 'vitest';
import { generateCaptions, fallbackCaptions, speechWindow } from '../src/services/captionService.js';

// Numbers taken from a real measured scene (project a265549b, scene 1): the segment
// runs 6.584s but the narration only speaks for 3.730s of it — the rest is the
// target-length hold. Captions spread over 6.584s ended 2.85s behind the audio.
const PADDED_SCENE = {
  narration_text: 'one two three four five six seven eight nine',
  duration_actual: 6.584,
  duration_target: 5,
  speech_start: 0,
  speech_end: 3.73,
};

describe('speechWindow', () => {
  it('uses the measured speech span when present', () => {
    expect(speechWindow(PADDED_SCENE)).toEqual({ start: 0, span: 3.73 });
  });

  it('honours a non-zero speech start (leading silence)', () => {
    const w = speechWindow({ ...PADDED_SCENE, speech_start: 0.4, speech_end: 3.73 });
    expect(w.start).toBe(0.4);
    expect(w.span).toBeCloseTo(3.33, 5);
  });

  it('falls back to segment duration when nothing was measured', () => {
    expect(speechWindow({ duration_actual: 6.584 })).toEqual({ start: 0, span: 6.584 });
  });

  it('rejects a degenerate span rather than collapsing every caption', () => {
    expect(speechWindow({ duration_actual: 6.584, speech_start: 3, speech_end: 3.05 }))
      .toEqual({ start: 0, span: 6.584 });
    expect(speechWindow({ duration_actual: 6.584, speech_start: 5, speech_end: 2 }))
      .toEqual({ start: 0, span: 6.584 });
  });
});

describe('generateCaptions — captions must span the speech, not the padding', () => {
  it('ends the last caption at the end of speech, not the end of the segment', async () => {
    const { chunks } = await generateCaptions(PADDED_SCENE, '', 'default');
    const last = chunks[chunks.length - 1];
    expect(last.end).toBeCloseTo(3.73, 3);
    // The bug: this used to be 6.584 — 2.85s after the narration had finished.
    expect(last.end).toBeLessThan(PADDED_SCENE.duration_actual);
  });

  it('starts the first caption at the start of speech', async () => {
    const { chunks } = await generateCaptions(PADDED_SCENE, '', 'default');
    expect(chunks[0].start).toBeCloseTo(0, 3);
  });

  it('offsets every caption when speech starts late', async () => {
    const { chunks } = await generateCaptions({ ...PADDED_SCENE, speech_start: 0.5 }, '', 'default');
    expect(chunks[0].start).toBeCloseTo(0.5, 3);
    expect(chunks[chunks.length - 1].end).toBeCloseTo(3.73, 3);
  });

  it('keeps chunks contiguous and ordered', async () => {
    const { chunks } = await generateCaptions(PADDED_SCENE, '', 'default');
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].start).toBeCloseTo(chunks[i - 1].end, 5);
      expect(chunks[i].end).toBeGreaterThan(chunks[i].start);
    }
  });

  it('lays word timestamps over the speech span too', async () => {
    const { words } = await generateCaptions(PADDED_SCENE, '', 'default');
    expect(words[0].start).toBeCloseTo(0, 3);
    expect(words[words.length - 1].end).toBeCloseTo(3.73, 3);
  });

  it('still uses the segment duration when no speech span was measured', async () => {
    const { chunks } = await generateCaptions(
      { narration_text: PADDED_SCENE.narration_text, duration_actual: 6.584 }, '', 'default',
    );
    expect(chunks[chunks.length - 1].end).toBeCloseTo(6.584, 3);
  });

  it('returns nothing for empty narration', async () => {
    const { chunks, words } = await generateCaptions({ narration_text: '  ', duration_actual: 5 }, '', 'default');
    expect(chunks).toEqual([]);
    expect(words).toEqual([]);
  });
});

describe('fallbackCaptions', () => {
  it('spans duration_target when there is no measured speech', () => {
    const { chunks } = fallbackCaptions({ narration_text: 'a b c d e f', duration_target: 6 }, 'default');
    expect(chunks[chunks.length - 1].end).toBeCloseTo(6, 3);
  });

  it('prefers a measured speech span if one is available', () => {
    const { chunks } = fallbackCaptions(
      { narration_text: 'a b c d e f', duration_target: 6, speech_start: 0, speech_end: 4 }, 'default',
    );
    expect(chunks[chunks.length - 1].end).toBeCloseTo(4, 3);
  });
});
