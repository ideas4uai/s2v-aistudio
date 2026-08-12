import { describe, it, expect } from 'vitest';
import {
  KOKORO_VOICES, KOKORO_LANGUAGES, DEFAULT_ENGINE, gradeRank, parseVoiceStyle,
  resolveVoiceProfile, resolveKokoroVoice, MissingKokoroVoiceError,
} from '../src/server/services/ttsService.js';

describe('Kokoro voice roster', () => {
  // The roster is deliberately a subset of the model card. Kokoro ships Spanish, French,
  // Italian, Portuguese, Japanese and Mandarin voices too; this product speaks English,
  // Hindi and Telugu, so offering the rest only invites picking one by accident.
  it('offers English and Hindi only', () => {
    expect([...KOKORO_LANGUAGES].sort()).toEqual(['english', 'hindi']);
  });

  it('has dropped every language the product does not speak', () => {
    for (const lang of ['spanish', 'french', 'italian', 'portuguese', 'japanese', 'mandarin']) {
      expect(KOKORO_LANGUAGES.has(lang), `${lang} is still offered`).toBe(false);
    }
    // The prefix is how Kokoro derives its lang_code, so a stray e_/f_/i_/p_/j_/z_ id
    // would still synthesise in that language even with the label removed.
    for (const id of Object.keys(KOKORO_VOICES)) {
      expect('abh', `voice "${id}" has a non-English/Hindi prefix`).toContain(id[0]);
    }
  });

  it('has no Telugu voice — the gap that keeps Piper in the chain', () => {
    expect(KOKORO_LANGUAGES.has('telugu')).toBe(false);
    expect(KOKORO_LANGUAGES.has('hindi')).toBe(true);
  });

  it('keeps the Hindi voices, which are the only non-English ones left', () => {
    const hindi = Object.entries(KOKORO_VOICES).filter(([, v]) => v.lang === 'hindi');
    expect(hindi.map(([id]) => id).sort()).toEqual(['hf_alpha', 'hf_beta', 'hm_omega', 'hm_psi']);
  });

  it('names every voice with the language prefix Kokoro derives lang_code from', () => {
    const prefixByLang: Record<string, string[]> = { english: ['a', 'b'], hindi: ['h'] };
    for (const [id, v] of Object.entries(KOKORO_VOICES)) {
      expect(prefixByLang[v.lang], `${id} has unknown lang ${v.lang}`).toContain(id[0]);
    }
  });
});

describe('gradeRank', () => {
  it('orders the model card grades best-first', () => {
    expect(gradeRank('A')).toBeLessThan(gradeRank('B-'));
    expect(gradeRank('B-')).toBeLessThan(gradeRank('C+'));
    expect(gradeRank('C+')).toBeLessThan(gradeRank('D'));
  });

  it('sorts ungraded voices last rather than first', () => {
    expect(gradeRank('')).toBeGreaterThan(gradeRank('F'));
  });
});

describe('parseVoiceStyle', () => {
  it('treats a bare legacy value as "no engine opinion"', () => {
    expect(parseVoiceStyle('professional')).toEqual({ value: 'professional' });
  });

  it('reads an explicit engine prefix', () => {
    expect(parseVoiceStyle('piper:dramatic')).toEqual({ engine: 'piper', value: 'dramatic' });
    expect(parseVoiceStyle('kokoro:af_bella')).toEqual({ engine: 'kokoro', value: 'af_bella' });
  });

  it('survives an empty or undefined setting', () => {
    expect(parseVoiceStyle(undefined)).toEqual({ value: '' });
  });
});

describe('resolveVoiceProfile — engine selection', () => {
  it('defaults to Kokoro, so existing projects get the better engine', () => {
    expect(DEFAULT_ENGINE).toBe('kokoro');
    expect(resolveVoiceProfile(undefined, 'professional').engine).toBe('kokoro');
  });

  it('still returns the original Piper model for every style, unchanged', () => {
    // Selecting the offline engine must reproduce the pre-Kokoro output exactly.
    expect(resolveVoiceProfile(undefined, 'professional').modelName).toBe('en_US-lessac-medium');
    expect(resolveVoiceProfile(undefined, 'energetic').modelName).toBe('en_US-joe-medium');
    expect(resolveVoiceProfile(undefined, 'dramatic').modelName).toBe('en_US-ryan-high');
    expect(resolveVoiceProfile(undefined, 'calm').modelName).toBe('en_GB-alba-medium');
  });

  it('honours an explicit piper: prefix', () => {
    const p = resolveVoiceProfile(undefined, 'piper:dramatic');
    expect(p.engine).toBe('piper');
    expect(p.modelName).toBe('en_US-ryan-high');
  });

  it('honours a directly named Kokoro voice', () => {
    expect(resolveVoiceProfile(undefined, 'kokoro:af_bella').kokoroVoice).toBe('af_bella');
  });

  it('ignores a kokoro: value that is not a real voice, rather than passing it through', () => {
    // A bogus name must not reach the synthesizer as if it were valid.
    expect(resolveVoiceProfile(undefined, 'kokoro:not_a_voice').kokoroVoice).toBe('af_heart');
  });

  it('gives every style and character a Kokoro voice that exists', () => {
    for (const style of ['professional', 'energetic', 'dramatic', 'casual', 'calm']) {
      expect(KOKORO_VOICES[resolveVoiceProfile(undefined, style).kokoroVoice]).toBeDefined();
    }
    for (const c of ['VEER', 'VEER_ALT', 'BYTE', 'NOVA', 'NARRATOR', 'MIRA', 'BIAS', 'NULL']) {
      expect(KOKORO_VOICES[resolveVoiceProfile(c, 'professional').kokoroVoice]).toBeDefined();
    }
  });

  it('keeps the NARRATOR rule: a cast character wins, the placeholder does not', () => {
    // Regression guard from the classic-flow fix — NARRATOR must not shadow voiceStyle.
    expect(resolveVoiceProfile('NARRATOR', 'energetic').kokoroVoice)
      .toBe(resolveVoiceProfile(undefined, 'energetic').kokoroVoice);
    expect(resolveVoiceProfile('BYTE', 'calm').kokoroVoice).toBe('am_puck');
  });
});

describe('resolveKokoroVoice — a missing voice must never become silent audio', () => {
  it('keeps the chosen English voice', () => {
    expect(resolveKokoroVoice('af_heart', 'english')).toBe('af_heart');
  });

  it('throws for an English voice Kokoro does not have', () => {
    expect(() => resolveKokoroVoice('en_US-lessac-medium', 'english')).toThrow(MissingKokoroVoiceError);
  });

  it('re-points a non-English language at a voice that actually speaks it', () => {
    // Handing Hindi text to an English voice yields fluent-sounding gibberish.
    const hi = resolveKokoroVoice('af_heart', 'hindi');
    expect(hi).not.toBeNull();
    expect(KOKORO_VOICES[hi!].lang).toBe('hindi');
  });

  it('keeps an already-correct language voice instead of re-picking', () => {
    expect(resolveKokoroVoice('hm_omega', 'hindi')).toBe('hm_omega');
  });

  it('picks the best-graded voice for the language', () => {
    // All four Hindi voices are grade C, so this pins the ordering rather than a tie-break:
    // whatever comes back must be Hindi and must be the first in graded order.
    const picked = resolveKokoroVoice('af_heart', 'hindi')!;
    expect(KOKORO_VOICES[picked].lang).toBe('hindi');
    expect(picked).toBe('hf_alpha');
  });

  it('returns null for a language Kokoro cannot speak, so Piper can take it', () => {
    // Null is a routing decision, not a failure: Piper has te_IN-maya-medium.
    expect(resolveKokoroVoice('af_heart', 'telugu')).toBeNull();
    // Spanish is no longer in the roster, so it routes the same way — and since Spanish
    // was also removed from LANGUAGE_VOICES, Piper then fails loudly rather than
    // handing Spanish text to an English model.
    expect(resolveKokoroVoice('af_heart', 'spanish')).toBeNull();
  });

  it('is case-insensitive about the language name', () => {
    expect(resolveKokoroVoice('af_heart', 'ENGLISH')).toBe('af_heart');
  });

  it('explains the fix in the error message', () => {
    try {
      resolveKokoroVoice('nope', 'english');
      throw new Error('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(MissingKokoroVoiceError);
      expect(e.message).toContain('silent audio');
    }
  });
});
