import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ensureBackgroundPrompt } from '../src/pipeline/orchestrator.js';

// Two render paths existed and only one looked finished. The editor path
// (projectController) set background_prompt on every scene; the automated path
// (StoryboardAgent, used by Automate mode and POST /pipeline/run) never did.
//
// That single missing field decided the whole look of a render, because two
// separate things hang off it:
//   1. The aesthetic suffix — which carries "absolutely no text, no words, no
//      numbers, no lettering, no typography anywhere in the image" — is appended
//      to background_prompt and to nothing else.
//   2. A scene with no background_path is never flagged `unified`, so it renders
//      on the legacy ffmpeg compositor at 30fps instead of Metro V4 at 24 with
//      its vignette, grain and colour grade.
//
// Measured before the fix: two renders driven through the automated path came
// back with garbled pseudo-text in 4 of 6 and 4 of 7 shots and probed at 30fps,
// against 0 of 10 and 24fps on the editor-path video that shipped to YouTube.
//
// These tests pin the invariant rather than the call site, so a fifth scene
// constructor cannot quietly reintroduce the divergence.

const scene = (over: any = {}) => ({
  scene_id: 's1',
  order: 0,
  narration_text: 'Broken selectors stop your suite dead.',
  visuals: [{ visual_id: 'v1', prompt: 'Wide shot of a shattering interface, dim office lighting' }],
  ...over,
}) as any;

describe('background_prompt invariant', () => {
  it('derives one from the visual prompt when a scene has none', () => {
    const s = scene();
    expect(ensureBackgroundPrompt(s)).toBe(true);
    expect(s.background_prompt).toBe('Wide shot of a shattering interface, dim office lighting');
  });

  it('leaves an existing background_prompt alone', () => {
    const s = scene({ background_prompt: 'An editor-authored background' });
    expect(ensureBackgroundPrompt(s)).toBe(false);
    expect(s.background_prompt).toBe('An editor-authored background');
  });

  it('treats a whitespace-only background_prompt as absent', () => {
    // projectController's fallback chain ends in '' — an empty string reached the
    // renderer as "set" and skipped background generation entirely.
    const s = scene({ background_prompt: '   ' });
    expect(ensureBackgroundPrompt(s)).toBe(true);
    expect(s.background_prompt).toBe('Wide shot of a shattering interface, dim office lighting');
  });

  it('reports no change when there is nothing to derive from', () => {
    const s = scene({ visuals: [] });
    expect(ensureBackgroundPrompt(s)).toBe(false);
    expect(s.background_prompt).toBeFalsy();
  });

  it('trims, so a padded prompt does not read as a different string downstream', () => {
    const s = scene({ visuals: [{ visual_id: 'v1', prompt: '  A quiet server room  ' }] });
    ensureBackgroundPrompt(s);
    expect(s.background_prompt).toBe('A quiet server room');
  });
});

describe('the guard sits where every scene passes', () => {
  const orchestrator = fs.readFileSync(
    path.join(process.cwd(), 'src/pipeline/orchestrator.ts'), 'utf-8',
  );

  it('runs inside processSingleScene, not in one of the four scene constructors', () => {
    // Patching StoryboardAgent alone would leave the legacy generateScenes path
    // and fallbackSceneGraph still broken. processSingleScene is the one function
    // every scene reaches regardless of which constructor built it.
    const fnStart = orchestrator.indexOf('export async function processSingleScene');
    expect(fnStart).toBeGreaterThan(-1);
    const callSite = orchestrator.indexOf('ensureBackgroundPrompt(scene)', fnStart);
    expect(callSite).toBeGreaterThan(fnStart);
    // and early enough to precede background generation
    expect(callSite).toBeLessThan(orchestrator.indexOf('Stage 2: generate or re-download background image'));
  });

  it('still appends the no-text instruction only via background_prompt', () => {
    // If this ever moves, the guard above stops buying anything and this test
    // should be the thing that says so.
    const suffixAt = orchestrator.indexOf('absolutely no text, no words, no numbers');
    expect(suffixAt).toBeGreaterThan(-1);
    const usage = orchestrator.indexOf('const fullBgPrompt = [scene.background_prompt', suffixAt);
    expect(usage).toBeGreaterThan(suffixAt);
  });
});
