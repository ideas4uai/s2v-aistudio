import { describe, it, expect } from 'vitest';
import { buildScriptPrompt, buildScriptSections, type ScriptBrief } from '../src/pipeline/agents/scriptPrompt.js';
import {
  normalizeLanguage, languageName, LANGUAGES, LANGUAGE_OPTIONS, DEFAULT_LANGUAGE, hasLatinScript,
} from '../src/utils/language.js';

/**
 * The language a script is written in.
 *
 * This is a regression file for a silent failure, not a feature test. The voice router
 * already picked the right Telugu model; the prompt handed it English text, and Piper
 * read English words through Telugu phonemes. Every downstream check passed — the WAV
 * was valid and not silent, so the quality gate saw audio present and the render
 * completed. An unintelligible video shipped as a success.
 *
 * What must never regress: the prompt names the language, and both stored shapes of
 * that value resolve to the same thing.
 */

const brief = (language?: string): ScriptBrief => ({
  topic: 'How RAG stops AI hallucinations',
  targetSeconds: 30,
  hookStrategy: 'question',
  mode: 'shorts',
  language,
});

describe('the prompt states which language to write in', () => {
  it('names the language for every supported value', () => {
    for (const name of Object.values(LANGUAGES)) {
      expect(buildScriptPrompt(brief(name))).toContain(name);
    }
  });

  it('makes the language rule the FIRST constraint', () => {
    // Ahead of every craft rule on purpose: those are about how a sentence is built,
    // this is about which language it is built in. A model that gets this wrong
    // produces output no downstream check can detect as wrong.
    const first = buildScriptSections(brief('Telugu')).constraints[0];
    expect(first).toContain('Telugu');
    expect(first).toMatch(/^Write every spoken word/);
  });

  it('demands the native script, not transliteration, for non-English', () => {
    // Latin-script Telugu fed to a Telugu phoneme model is the exact bug this
    // constraint prevents: the engine pronounces the characters written.
    for (const name of ['Telugu', 'Hindi']) {
      const p = buildScriptPrompt(brief(name));
      expect(p).toContain(`using ${name}'s own script`);
      expect(p).toContain('Latin alphabet');
    }
  });

  it('does not lecture an English script about transliteration', () => {
    const p = buildScriptSections(brief('English')).constraints[0];
    expect(p).toBe('Write every spoken word in English.');
  });

  it('falls back to English when the brief carries no language', () => {
    expect(buildScriptSections(brief(undefined)).constraints[0]).toContain('English');
  });
});

describe('one canonical language value', () => {
  it('resolves both shapes the two UIs used to write', () => {
    // CreateProject wrote codes, ProjectEditor wrote display names. Existing project
    // records on disk still hold display names, so both must keep resolving.
    for (const [code, name] of Object.entries(LANGUAGES)) {
      expect(normalizeLanguage(code)).toBe(code);
      expect(normalizeLanguage(name)).toBe(code);
      expect(normalizeLanguage(name.toUpperCase())).toBe(code);
    }
  });

  it('accepts a regional tag', () => {
    expect(normalizeLanguage('te-IN')).toBe('te');
    expect(normalizeLanguage('en_US')).toBe('en');
  });

  it('returns null for an unsupported language rather than defaulting to English', () => {
    // The voice router must still throw for Spanish. Coercing an unoffered language to
    // English is how a video ships in the wrong language instead of failing.
    for (const bad of ['es', 'spanish', 'french', 'klingon', '', null, undefined]) {
      expect(normalizeLanguage(bad)).toBeNull();
      expect(languageName(bad)).toBe('');
    }
  });

  it('offers exactly the languages that have a voice model installed', () => {
    expect(LANGUAGE_OPTIONS.map((l) => l.code).sort()).toEqual(Object.keys(LANGUAGES).sort());
    expect(LANGUAGES[DEFAULT_LANGUAGE]).toBe('English');
  });

  it('knows which languages the caption overlay can actually draw', () => {
    // overlayPlan drops non-Latin lines because the font renders them as '?????'.
    expect(hasLatinScript('en')).toBe(true);
    expect(hasLatinScript('te')).toBe(false);
    expect(hasLatinScript('hi')).toBe(false);
  });
});
