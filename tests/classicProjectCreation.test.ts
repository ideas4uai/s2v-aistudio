import { describe, it, expect } from 'vitest';
import { pipelineFieldsFromSettings } from '../src/server/routes/projects.js';

// The UI (CreateProject.tsx) only ever sends these nested under `settings`, but
// directorAgent/scriptwriterAgent read them at the top level of the project and
// the orchestrator hashes `mode`/`style_profile` into every asset cache key.
// Before this mapping they were `undefined` in every prompt.
describe('pipelineFieldsFromSettings', () => {
  it('lifts styleProfile to a top-level style_profile', () => {
    expect(pipelineFieldsFromSettings({ styleProfile: 'documentary' }).style_profile).toBe('documentary');
  });

  it('lifts hookStrategy and pacingIntensity to their snake_case pipeline keys', () => {
    const f = pipelineFieldsFromSettings({ hookStrategy: 'shocking', pacingIntensity: 'aggressive' });
    expect(f.hook_strategy).toBe('shocking');
    expect(f.pacing_intensity).toBe('aggressive');
  });

  it('derives mode from the vertical aspect ratio', () => {
    expect(pipelineFieldsFromSettings({ aspectRatio: '9:16' }).mode).toBe('shorts');
    expect(pipelineFieldsFromSettings({ exportMode: 'shorts' }).mode).toBe('shorts');
    expect(pipelineFieldsFromSettings({ aspectRatio: '16:9' }).mode).toBe('long');
  });

  it('falls back to the same defaults orchestrator.loadProject applies', () => {
    for (const settings of [undefined, null, {}]) {
      expect(pipelineFieldsFromSettings(settings)).toEqual({
        mode: 'long',
        style_profile: 'cinematic',
        hook_strategy: 'default',
        pacing_intensity: 'moderate',
      });
    }
  });

  it('maps a full CreateProject settings payload end to end', () => {
    expect(pipelineFieldsFromSettings({
      aspectRatio: '9:16',
      exportMode: 'shorts',
      styleProfile: 'high-contrast',
      hookStrategy: 'curiosity',
      pacingIntensity: 'fast',
      language: 'en',
    })).toEqual({
      mode: 'shorts',
      style_profile: 'high-contrast',
      hook_strategy: 'curiosity',
      pacing_intensity: 'fast',
    });
  });
});
