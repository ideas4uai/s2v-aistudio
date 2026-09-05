import { describe, it, expect } from 'vitest';
import {
  checkLanguageMatch, checkCaptionSync, runQualityGate,
  CAPTION_DRIFT_TOLERANCE_SEC, LANGUAGE_MATCH_THRESHOLD,
} from '../src/services/qualityService.js';

/**
 * The two cases that used to pass the gate while producing an unusable video.
 *
 * Every original check asked whether a file existed and was non-empty. A video whose
 * narration was in the wrong language, or whose captions were laid out against the
 * wrong window, satisfied all five and shipped as a success.
 *
 * Not the full Reject -> Diagnose -> Regenerate -> Revalidate loop; that is a larger
 * effort. These two checks close the silent-pass, which is the dangerous half: a
 * failure that announces itself can be acted on, one that reports success cannot.
 */

const TELUGU = 'AI మోడల్స్ నిజాలు కల్పించి చెబుతాయి. వాటి నమ్మకమైన సమాధానాల వల్ల తెలియదు.';
const ENGLISH = 'AI models invent facts. Their confident answers hide it completely.';

const scene = (over: Record<string, unknown> = {}) => ({
  scene_id: 'sc-1', order: 0, narration_text: ENGLISH,
  speech_start: 0.25, speech_end: 4.25,
  captions: [{ word: 'AI', start: 0.25, end: 0.6 }, { word: 'models', start: 0.6, end: 4.25 }],
  ...over,
});

const project = (over: Record<string, unknown> = {}) => ({
  project_id: 'p', scenes: [scene()], settings: { language: 'en' }, ...over,
} as any);

describe('language mismatch fails the gate', () => {
  it('fails a Telugu project whose narration came out in English', () => {
    // The exact bug: the scriptwriter had no language field, so a Telugu project got an
    // English script and Piper read English words through Telugu phonemes.
    const p = project({ settings: { language: 'te' } });
    const check = checkLanguageMatch(p);
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('Telugu');
    expect(check.detail).toContain('not be intelligible');
  });

  it('passes a Telugu project whose narration is actually Telugu', () => {
    const p = project({ settings: { language: 'te' }, scenes: [scene({ narration_text: TELUGU })] });
    expect(checkLanguageMatch(p).status).toBe('pass');
  });

  it('tolerates borrowed Latin nouns inside a Telugu script', () => {
    // A real generated script measured 793 Telugu characters to 8 Latin ("AI"), which
    // the constraint explicitly permits. The threshold must not fail that.
    const p = project({ settings: { language: 'te' }, scenes: [scene({ narration_text: TELUGU })] });
    expect(checkLanguageMatch(p).status).toBe('pass');
    expect(LANGUAGE_MATCH_THRESHOLD).toBeLessThan(0.9);
  });

  it('fails an English project that came out in Telugu', () => {
    const p = project({ scenes: [scene({ narration_text: TELUGU })] });
    expect(checkLanguageMatch(p).status).toBe('fail');
  });

  it('reports unchecked rather than passing when there is nothing to judge', () => {
    expect(checkLanguageMatch(project({ settings: {} })).status).toBe('skipped');
    expect(checkLanguageMatch(project({ scenes: [scene({ narration_text: '' })] })).status).toBe('skipped');
  });
});

describe('caption desync fails the gate', () => {
  it('fails captions laid out against the segment instead of the speech', () => {
    // The failure that shipped: cues spread over duration_actual, so each one lands
    // progressively later — measured 2.85s behind on a 6.58s scene.
    const desynced = scene({
      captions: [{ word: 'AI', start: 0.0, end: 3.3 }, { word: 'models', start: 3.3, end: 6.58 }],
      speech_start: 0.25, speech_end: 4.25,
    });
    const check = checkCaptionSync(project({ scenes: [desynced] }));
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('Scene 1');
  });

  it('passes captions that track the measured speech span', () => {
    const check = checkCaptionSync(project());
    expect(check.status).toBe('pass');
    expect(check.detail).toContain('Worst drift');
  });

  it('tolerates the honest error of evenly divided word timings', () => {
    // Even division is legitimately up to ~0.47s out on a clean scene, and failing
    // those would fail correct renders.
    const slightlyOff = scene({
      captions: [{ word: 'AI', start: 0.25, end: 0.6 }, { word: 'models', start: 0.6, end: 4.65 }],
    });
    expect(checkCaptionSync(project({ scenes: [slightlyOff] })).status).toBe('pass');
    expect(CAPTION_DRIFT_TOLERANCE_SEC).toBeGreaterThan(0.47);
  });

  it('reads caption_chunks, which is what a rendered project actually stores', () => {
    // `captions` is the per-word array, built in memory during the render and empty on
    // every record on disk. A check that reads only `captions` skips every real project
    // while passing its own fixtures. Shape lifted from a real outputs/*.json.
    const real = {
      scene_id: 'sc-1', order: 0, narration_text: ENGLISH,
      speech_start: 0.33, speech_end: 6.532, captions: [],
      caption_chunks: [
        { words: ['A', 'REST', 'API'], text: 'A REST API', start: 0.33, end: 1.105 },
        { words: ['is', 'a', 'contract'], text: 'is a contract', start: 1.105, end: 6.532 },
      ],
    };
    const check = checkCaptionSync(project({ scenes: [real] }));
    expect(check.status).toBe('pass');
    expect(check.detail).toContain('1 scene(s)');
  });

  it('catches a desync expressed in caption_chunks too', () => {
    const drifted = {
      scene_id: 'sc-1', order: 0, narration_text: ENGLISH,
      speech_start: 0.33, speech_end: 4.0, captions: [],
      caption_chunks: [{ words: ['A'], text: 'A', start: 0.0, end: 6.58 }],
    };
    expect(checkCaptionSync(project({ scenes: [drifted] })).status).toBe('fail');
  });

  it('reports unchecked for a render that predates the speech measurement', () => {
    const old = scene({ speech_start: undefined, speech_end: undefined, caption_chunks: [] });
    expect(checkCaptionSync(project({ scenes: [old] })).status).toBe('skipped');
  });
});

describe('the gate as a whole', () => {
  it('now refuses a project it used to pass', async () => {
    // Same project, both defects, everything else untouched: the five original checks
    // still see a file present and non-empty.
    const broken = project({
      settings: { language: 'te' },
      scenes: [scene({
        narration_text: ENGLISH,
        captions: [{ word: 'AI', start: 0.0, end: 6.58 }],
      })],
    });
    const gate = await runQualityGate(broken);
    expect(gate.passed).toBe(false);
    expect(gate.failures.join(' ')).toContain('Telugu');
    expect(gate.checks.map((c) => c.id)).toContain('caption_sync');
    expect(gate.checks.map((c) => c.id)).toContain('language_match');
  });
});
