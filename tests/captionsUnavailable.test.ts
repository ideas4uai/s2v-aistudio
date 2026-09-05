import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { hasLatinScript, captionsSupported, LANGUAGES } from '../src/utils/language.js';
import { checkCaptionSync } from '../src/services/qualityService.js';

/**
 * Captions are deliberately not rendered for non-Latin scripts.
 *
 * The caption font carries no Indic glyphs, so burning Telugu or Devanagari produced
 * rows of '?????'. Omitting them is the decision; the point of this file is that it
 * stays a DECISION — announced to the user and reported as such by the gate — rather
 * than decaying into a video that silently has no captions and no explanation.
 *
 * Verified against a real Telugu render: 79s, 720x1280, zero subtitle filters in any
 * ffmpeg command, zero .ass files written, gate 100% with caption_sync skipped.
 */

const scene = () => ({
  scene_id: 'sc-1', order: 0, narration_text: 'AI మోడల్స్ నిజాలు కల్పించి చెబుతాయి.',
  speech_start: 0.3, speech_end: 4.3, captions: [], caption_chunks: [],
});

describe('which languages get captions', () => {
  it('renders captions only for the Latin-script language', () => {
    expect(captionsSupported('en')).toBe(true);
    for (const code of Object.keys(LANGUAGES).filter((c) => c !== 'en')) {
      expect(captionsSupported(code), `${code} has no caption font coverage`).toBe(false);
    }
  });

  it('treats an UNSET language as the default, not as unsupported', () => {
    // Most projects on disk never set the field. Reading that as "no captions" stripped
    // captions from every one of them -- caught by the segment-reuse tests.
    expect(captionsSupported(undefined)).toBe(true);
    expect(captionsSupported('')).toBe(true);
    expect(captionsSupported(null)).toBe(true);
    // hasLatinScript keeps the stricter meaning for callers that want it.
    expect(hasLatinScript(undefined)).toBe(false);
  });

  it('gates the render on that check rather than on narration text alone', () => {
    // `Boolean(scene.caption_text)` alone sent Telugu through libass and burned '?????'.
    const src = fs.readFileSync('src/services/renderService.ts', 'utf8');
    const line = src.split('\n').find((l) => l.includes('const hasCaptions ='))!;
    expect(line).toContain('captionsSupported(project?.settings?.language)');
  });

  it('records the reason on the project so the UI can explain the absence', () => {
    const orch = fs.readFileSync('src/pipeline/orchestrator.ts', 'utf8');
    expect(orch).toContain('project.captions_unavailable = next');
    expect(orch).toContain("logEvent('captions_skipped'");
  });

  it('tells the user at the moment they pick the language', () => {
    // After the render is too late — the decision is visible where it is made.
    const create = fs.readFileSync('src/pages/CreateProject.tsx', 'utf8');
    expect(create).toContain('Captions are not available in this language yet');
    expect(create).toContain('hasLatinScript(formData.settings.language)');
  });

  it('shows the recorded reason on the project itself', () => {
    const editor = fs.readFileSync('src/pages/ProjectEditor.tsx', 'utf8');
    expect(editor).toContain('captions_unavailable?.reason');
    expect(editor).toContain('hasLatinScript(settings.language)');
  });
});

describe('the gate distinguishes deliberate from broken', () => {
  it('reports the recorded reason rather than a bare "no cues"', () => {
    const reason = 'Captions are not available for Telugu yet — the caption font cannot draw its script.';
    const check = checkCaptionSync({
      project_id: 'p', settings: { language: 'te' },
      captions_unavailable: { language: 'Telugu', reason },
      scenes: [scene()],
    } as any);
    expect(check.status).toBe('skipped');
    expect(check.detail).toBe(reason);
  });

  it('still explains itself on a non-Latin project rendered before the field existed', () => {
    const check = checkCaptionSync({
      project_id: 'p', settings: { language: 'te' }, scenes: [scene()],
    } as any);
    expect(check.status).toBe('skipped');
    expect(check.detail).toContain('not rendered for this language');
  });

  it('keeps the plain wording for an English project with genuinely missing cues', () => {
    // That one IS a problem worth looking at, and must not be dressed up as a decision.
    const check = checkCaptionSync({
      project_id: 'p', settings: { language: 'en' },
      scenes: [{ ...scene(), narration_text: 'AI models invent facts.' }],
    } as any);
    expect(check.status).toBe('skipped');
    expect(check.detail).toContain('No scene carries both caption cues');
  });
});
