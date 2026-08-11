import { describe, it, expect } from 'vitest';
import { resolveVoiceProfile } from '../src/server/services/ttsService.js';

// The narration cache key is generateAudioHash(text, `${model}|ls|ns|nw`), so
// "different profile" and "cache correctly invalidated" are the same assertion.
const key = (character?: string, voiceStyle?: string) => {
  const p = resolveVoiceProfile(character, voiceStyle);
  return `${p.modelName}|ls${p.lengthScale}|ns${p.noiseScale}|nw${p.noiseW}`;
};

describe('resolveVoiceProfile', () => {
  it('resolves every voiceStyle to a distinct voice profile', () => {
    const styles = ['professional', 'energetic', 'dramatic', 'casual', 'calm'];
    const keys = styles.map(s => key(undefined, s));
    expect(new Set(keys).size).toBe(styles.length);
  });

  it('only uses Piper models installed in piper/', () => {
    const installed = [
      'en_GB-alba-medium', 'en_US-joe-medium', 'en_US-lessac-medium',
      'en_US-reza_ibrahim-medium', 'en_US-ryan-high',
    ];
    for (const s of ['professional', 'energetic', 'dramatic', 'casual', 'calm']) {
      expect(installed).toContain(resolveVoiceProfile(undefined, s).modelName);
    }
    for (const c of ['VEER', 'VEER_ALT', 'BYTE', 'NOVA', 'NARRATOR', 'MIRA', 'BIAS', 'NULL']) {
      expect(installed).toContain(resolveVoiceProfile(c).modelName);
    }
  });

  it('gives dramatic a slower, breathier voice than professional', () => {
    const pro = resolveVoiceProfile(undefined, 'professional');
    const dram = resolveVoiceProfile(undefined, 'dramatic');
    expect(Number(dram.lengthScale)).toBeGreaterThan(Number(pro.lengthScale));
    expect(Number(dram.noiseScale)).toBeGreaterThan(Number(pro.noiseScale));
    expect(dram.modelName).not.toBe(pro.modelName);
  });

  it('lets a character voice override voiceStyle', () => {
    expect(key('BYTE', 'dramatic')).toBe(key('BYTE', 'professional'));
    expect(key('BYTE', 'dramatic')).not.toBe(key(undefined, 'dramatic'));
    expect(resolveVoiceProfile('byte', 'dramatic').modelName).toBe('en_US-joe-medium');
  });

  it('falls back to the narrator voice for unknown or missing values', () => {
    const narrator = key('NARRATOR');
    expect(key(undefined, undefined)).toBe(narrator);
    expect(key('', 'custom')).toBe(narrator);
    expect(key(undefined, 'wharrgarbl')).toBe(narrator);
  });

  it('keeps professional identical to the pre-existing narrator default', () => {
    expect(key(undefined, 'professional')).toBe('en_US-lessac-medium|ls1.053|ns0.200|nw0.100');
  });

  // Regression: every classic project sets character='NARRATOR', so when NARRATOR
  // was treated as a cast member it short-circuited voiceStyle and the dropdown
  // was inert on exactly the projects it exists for. Caught by a real render —
  // 'dramatic' and 'professional' logged byte-identical Piper parameters.
  it('applies voiceStyle to NARRATOR scenes instead of being short-circuited', () => {
    expect(key('NARRATOR', 'dramatic')).toBe(key(undefined, 'dramatic'));
    expect(key('NARRATOR', 'dramatic')).not.toBe(key('NARRATOR', 'professional'));
    expect(resolveVoiceProfile('NARRATOR', 'dramatic').modelName).toBe('en_US-ryan-high');
  });

  it('still uses the narrator default for a NARRATOR scene with no voiceStyle', () => {
    expect(key('NARRATOR')).toBe('en_US-lessac-medium|ls1.053|ns0.200|nw0.100');
  });
});
