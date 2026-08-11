import { describe, it, expect } from 'vitest';
import { generateCaptions, fallbackCaptions } from '../src/services/captionService.js';

const scene = {
  narration_text: 'Did you know AIs are now teaming up to solve problems like a squad every single day',
  duration_actual: 8,
  duration_target: 8,
};

describe('caption color consistency (regression for d434b99)', () => {
  it('generateCaptions emits only white chunks, never yellow', async () => {
    const { chunks } = await generateCaptions(scene, '/fake/audio.wav', 'shorts');
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.text).toContain('\\c&H00FFFFFF&');
      expect(chunk.text).not.toContain('&H0000FFFF');
    }
  });

  it('fallbackCaptions emits only white chunks, never yellow', () => {
    const { chunks } = fallbackCaptions(scene, 'shorts');
    for (const chunk of chunks) {
      expect(chunk.text).toContain('\\c&H00FFFFFF&');
      expect(chunk.text).not.toContain('&H0000FFFF');
    }
  });
});

describe('caption timing bounds', () => {
  it('chunk and word timings stay within scene duration', async () => {
    const { words, chunks } = await generateCaptions(scene, '/fake/audio.wav', 'shorts');
    const duration = scene.duration_actual;
    for (const w of words) {
      expect(w.start).toBeGreaterThanOrEqual(0);
      expect(w.end).toBeLessThanOrEqual(duration + 1e-6);
    }
    for (const c of chunks) {
      expect(c.start).toBeGreaterThanOrEqual(0);
      expect(c.end).toBeLessThanOrEqual(duration + 1e-6);
    }
  });

  it('returns empty arrays for empty narration', async () => {
    const { words, chunks } = await generateCaptions({ narration_text: '', duration_actual: 5 }, '/fake/audio.wav', 'shorts');
    expect(words).toEqual([]);
    expect(chunks).toEqual([]);
  });
});
