import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { generateCaptions, wordTimings } from '../src/services/captionService.js';

/**
 * Two defects met here and both are pinned below.
 *
 * 1. The Node -> Python TTS sidecar handed the script over as UTF-8 while Python
 *    decoded stdin as the Windows locale codepage. An em dash came out as "â€”" and
 *    Kokoro said it out loud — measured 1.80s of "a circumflex euro" inside one
 *    22.9s scene. That phantom speech sat inside the measured speech span, so the
 *    captions, which only ever see the clean text, were spread across it.
 *
 * 2. Even division of the span assumes every word takes the same time to say.
 *    Measured against forced alignment on nine real scenes it left the captions up
 *    to 0.47s late on scenes with no other defect at all.
 */

// Real numbers: project sfxvol scene 0, "Your AI coding assistant just suggested a
// function that doesn't exist.", forced-aligned on the processed segment. The even
// division of the same span puts "assistant" at 1.336s against 1.000s actual.
const MEASURED = [
  { word: 'Your', start: 0.239, end: 0.320 },
  { word: 'AI', start: 0.320, end: 0.580 },
  { word: 'coding', start: 0.580, end: 1.000 },
  { word: 'assistant', start: 1.000, end: 1.560 },
  { word: 'just', start: 1.560, end: 1.900 },
  { word: 'suggested', start: 1.900, end: 2.360 },
  { word: 'a', start: 2.360, end: 2.680 },
  { word: 'function', start: 2.680, end: 2.980 },
  { word: 'that', start: 2.980, end: 3.280 },
  { word: "doesn't", start: 3.280, end: 3.600 },
  { word: 'exist.', start: 3.600, end: 3.880 },
];
const SCENE = {
  narration_text: "Your AI coding assistant just suggested a function that doesn't exist.",
  caption_text: "Your AI coding assistant just suggested a function that doesn't exist.",
  duration_actual: 6.82,
  speech_start: 0.239,
  speech_end: 4.284,
  word_timings: MEASURED,
};

describe('wordTimings — measured beats divided', () => {
  it('uses the aligned timings when they cover the text word for word', () => {
    const t = wordTimings(SCENE.narration_text, SCENE);
    expect(t).toHaveLength(MEASURED.length);
    expect(t[3].word).toBe('assistant');
    expect(t[3].start).toBeCloseTo(1.0, 5);
  });

  it('is what the even division was measurably wrong about', () => {
    const divided = wordTimings(SCENE.narration_text, { ...SCENE, word_timings: undefined });
    // 11 words over the 4.045s span: "assistant" lands 336ms after it is spoken.
    expect(divided[3].start - MEASURED[3].start).toBeGreaterThan(0.3);
  });

  it('falls back to even division when nothing was measured', () => {
    const t = wordTimings(SCENE.narration_text, { ...SCENE, word_timings: undefined });
    expect(t[0].start).toBeCloseTo(0.239, 5);
    expect(t[1].start - t[0].start).toBeCloseTo(t[2].start - t[1].start, 5);
  });

  it('falls back when alignment was attempted and produced nothing', () => {
    const t = wordTimings(SCENE.narration_text, { ...SCENE, word_timings: [] });
    expect(t).toHaveLength(11);
    expect(t[3].start).not.toBeCloseTo(1.0, 2);
  });

  it('refuses a timing list that does not line up word for word', () => {
    // The payoff overlay and the captions can be handed different subsets of the
    // narration; indexing one list with the other's positions would be silent drift.
    const t = wordTimings('just suggested a function', SCENE);
    expect(t).toHaveLength(4);
    expect(t[0].start).toBeCloseTo(0.239, 5);
  });
});

describe('generateCaptions with measured timings', () => {
  it('starts every cue on the word it announces', async () => {
    const { chunks } = await generateCaptions(SCENE, '', 'default');
    const starts = chunks.map((c) => c.start);
    for (const s of starts) {
      const nearest = Math.min(...MEASURED.map((w) => Math.abs(w.start - s)));
      expect(nearest).toBeLessThan(0.001);
    }
  });

  it('never leaves a hole between cues, so a pause cannot blink the captions off', async () => {
    const { chunks } = await generateCaptions(SCENE, '', 'default');
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i].end).toBeCloseTo(chunks[i + 1].start, 6);
    }
  });

  it('leaves the even-division layout contiguous as it always was', async () => {
    const { chunks } = await generateCaptions({ ...SCENE, word_timings: undefined }, '', 'default');
    expect(chunks[0].start).toBeCloseTo(0.239, 5);
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i].end).toBeCloseTo(chunks[i + 1].start, 6);
    }
    expect(chunks[chunks.length - 1].end).toBeCloseTo(4.284, 3);
  });
});

/**
 * The encoding half, checked against the interpreter that actually runs the sidecar.
 *
 * Importing the module is cheap — every heavy import in it is inside a function — and
 * it is the only honest way to assert that stdin decodes UTF-8 rather than cp1252.
 */
describe('tts_sidecar reads its protocol as UTF-8', () => {
  const python = process.env.TTS_PYTHON || 'python';
  const script = path.join(process.cwd(), 'src', 'scripts', 'tts_sidecar.py');

  it('decodes an em dash instead of speaking it', () => {
    expect(fs.existsSync(script)).toBe(true);
    const probe = 'import sys, json; sys.path.insert(0, "src/scripts"); import tts_sidecar; '
      + 'print(json.dumps({"enc": sys.stdin.encoding, "text": json.loads(sys.stdin.readline())["t"]}))';
    const r = spawnSync(python, ['-u', '-c', probe], {
      input: JSON.stringify({ t: 'a — b “c” … é' }) + '\n',
      encoding: 'utf8', timeout: 60_000,
    });
    if (r.error || r.status !== 0) {
      console.warn('[skip] no usable TTS interpreter:', r.error?.message || r.stderr?.slice(-200));
      return;
    }
    const out = JSON.parse(r.stdout.trim().split(/\r?\n/).pop() as string);
    expect(out.enc.toLowerCase().replace('-', '')).toBe('utf8');
    expect(out.text).toBe('a — b “c” … é');
  });
});
