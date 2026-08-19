import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { groupWords, generateCaptions, wordTimings, MAX_WORDS_PER_BLOCK } from '../src/services/captionService.js';

// The captions were a default subtitle burn-in sitting in the same frame as a
// genuinely broadcast-grade motion-graphics overlay, three times smaller and
// underneath the platform UI. They appear on every scene and the overlay on two
// or three, so the video reads as the captions.

const scene = (over: any = {}): any => ({
  scene_id: 's1',
  narration_text: 'Broken selectors stop the suite, and every fix costs an hour.',
  speech_start: 0.25,
  speech_end: 6.25,
  duration_actual: 7,
  ...over,
});

describe('cue grouping', () => {
  it('breaks at a clause boundary instead of every third word', () => {
    // Blind slice(i, i+3) is why real renders read "slower, because the".
    const blocks = groupWords('Broken selectors stop the suite, and every fix costs an hour.'.split(' '));
    const texts = blocks.map((b) => b.join(' '));
    // The comma ends a cue rather than sitting inside one: no cue may straddle
    // a clause boundary, which is what produced "slower, because the".
    expect(texts.some((t) => t.endsWith('suite,'))).toBe(true);
    for (const t of texts) {
      const words = t.split(' ');
      const straddles = words.slice(0, -1).some((w) => /[.,!?;:—]$/.test(w));
      expect(straddles, `cue "${t}" straddles punctuation`).toBe(false);
    }
  });

  it('never exceeds the cue ceiling', () => {
    const long = Array.from({ length: 31 }, (_, i) => `w${i}`);
    for (const b of groupWords(long)) expect(b.length).toBeLessThanOrEqual(MAX_WORDS_PER_BLOCK);
  });

  it('folds a lone trailing word back rather than flashing it alone', () => {
    const blocks = groupWords(['a', 'b', 'c', 'd']);
    expect(blocks[blocks.length - 1].length).toBeGreaterThan(1);
    expect(blocks.flat()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('loses no words and reorders nothing', () => {
    const words = 'one two three four five six seven eight nine'.split(' ');
    expect(groupWords(words).flat()).toEqual(words);
  });

  it('handles a single word', () => {
    expect(groupWords(['Stop.'])).toEqual([['Stop.']]);
  });
});

describe('cue timing comes from wordTimings, not an even split', () => {
  it('a cue spans exactly its own words', async () => {
    const s = scene();
    const { chunks } = await generateCaptions(s, '', 'production');
    const timings = wordTimings(s.narration_text, s);
    let cursor = 0;
    for (const chunk of chunks) {
      expect(chunk.start).toBeCloseTo(timings[cursor].start, 6);
      cursor += chunk.words.length;
      expect(chunk.end).toBeCloseTo(timings[cursor - 1].end, 6);
    }
    expect(cursor).toBe(timings.length);
  });

  it('a short cue is held for less time than a full one', () => {
    // The old code divided the window by BLOCK count, so a one-word cue and a
    // three-word cue were on screen for exactly as long.
    const s = scene({ narration_text: 'Stop. Every fix costs an hour of your week.' });
    return generateCaptions(s, '', 'production').then(({ chunks }) => {
      const durations = chunks.map((c) => c.end - c.start);
      expect(Math.max(...durations)).toBeGreaterThan(Math.min(...durations) + 1e-6);
    });
  });

  it('stays inside the measured speech window', async () => {
    const s = scene();
    const { chunks } = await generateCaptions(s, '', 'production');
    expect(chunks[0].start).toBeGreaterThanOrEqual(s.speech_start - 1e-6);
    expect(chunks[chunks.length - 1].end).toBeLessThanOrEqual(s.speech_end + 1e-6);
  });

  it('returns nothing for a wordless beat', async () => {
    const { chunks, words } = await generateCaptions(scene({ narration_text: '   ' }), '', 'production');
    expect(chunks).toEqual([]);
    expect(words).toEqual([]);
  });
});

describe('the burned-in style is frame-relative', () => {
  const render = fs.readFileSync(path.join(process.cwd(), 'src/services/renderService.ts'), 'utf-8');

  it('sizes type as a fraction of frame height, not a constant', () => {
    // 34 hardcoded against a PlayResY that tracks export resolution meant the
    // type was 1.77% of height at 1080p and 0.89% at 4K.
    expect(render).toMatch(/const capFont = Math\.max\(18, Math\.round\(playResY \* 0\.05\)\)/);
    expect(render).not.toMatch(/Style: Default,Arial,34,/);
  });

  it('lands inside the short-form norm of 3.1-5.7% of frame height', () => {
    const pct = Number(/const capFont = Math\.max\(18, Math\.round\(playResY \* (0\.\d+)\)\)/.exec(render)?.[1]);
    expect(pct).toBeGreaterThanOrEqual(0.031);
    expect(pct).toBeLessThanOrEqual(0.057);
  });

  it('clears the platform UI band', () => {
    // MarginV=120 was 6.25% of 1920 — inside the 250-320px Shorts/TikTok reserve.
    const pct = Number(/const capMarginV = Math\.round\(playResY \* (0\.\d+)\)/.exec(render)?.[1]);
    expect(pct * 1920).toBeGreaterThan(320);
  });

  it('fades each cue instead of hard-cutting it on and off', () => {
    // The envelope itself is asserted behaviourally in captionOverlayConflict.test.ts;
    // this only pins that the tag still reaches the ASS events, and that it is the
    // asymmetric pair rather than the symmetric one that put captions 125ms late.
    expect(render).toMatch(/\{\\\\fad\(\$\{inMs\},\$\{outMs\}\)\}/);
  });
});
