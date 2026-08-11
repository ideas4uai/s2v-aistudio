import { describe, it, expect } from 'vitest';
import { createProductionPackage } from '../src/content-studio/domain/productionPackage.js';
import { packageToProjectPayload, packageToScript } from '../src/content-studio/handoff.js';
import type { ProductionPackage } from '../src/content-studio/domain/types.js';

function populated(overrides: Partial<ProductionPackage> = {}): ProductionPackage {
  const pkg = createProductionPackage('ep-1', 'u1', 'Seed');
  return {
    ...pkg,
    story: { ...pkg.story, title: 'Why your tests lie', hook: 'Your CI is green. Your users are not.', conflict: 'Flaky mocks', lesson: 'Test the seam', cta: 'Follow for more' },
    scenes: [
      { id: 's2', order: 2, objective: 'reveal', dialogue: [{ speaker: 'NARRATOR', text: 'Second line.' }] },
      { id: 's1', order: 1, objective: 'hook', dialogue: [{ speaker: 'NARRATOR', text: 'First line.' }] },
    ],
    captions: { hashtags: ['#qa'], keywords: ['testing', 'ci'], youTubeDescription: 'A short film about flaky tests.' },
    ...overrides,
  };
}

describe('packageToScript', () => {
  it('assembles narration in scene order, not array order', () => {
    expect(packageToScript(populated())).toBe('First line.\n\nSecond line.');
  });

  it('returns empty string when no scene has dialogue', () => {
    const pkg = populated({ scenes: [{ id: 's1', order: 1, objective: 'x', dialogue: [] }] });
    expect(packageToScript(pkg)).toBe('');
  });
});

describe('packageToProjectPayload', () => {
  it('maps a package onto the Project shape POST /api/projects accepts', () => {
    const project = packageToProjectPayload(populated(), 'u1');

    expect(project.userId).toBe('u1');
    expect(project.topic).toBe('Why your tests lie');
    expect(project.status).toBe('draft');
    expect(project.script).toContain('First line.');
    expect(project.seo_metadata?.tags).toEqual(['testing', 'ci']);
    expect(project.storyArc?.beat_1_hook).toBe('Your CI is green. Your users are not.');
    expect(project.project_id).toBeTruthy();
  });

  it('derives shorts vs long settings from the render target', () => {
    const shorts = packageToProjectPayload(populated({ render: {} }), 'u1');
    expect(shorts.mode).toBe('shorts');
    expect(shorts.settings?.aspectRatio).toBe('9:16');
    expect(shorts.settings?.targetLength).toBe('60s');

    const long = packageToProjectPayload(populated({ render: { target: 'long' } }), 'u1');
    expect(long.mode).toBe('long');
    expect(long.settings?.aspectRatio).toBe('16:9');
    expect(long.settings?.targetLength).toBe('3m');
  });

  it('omits storyArc when the story has no conflict beat', () => {
    const pkg = populated();
    const project = packageToProjectPayload({ ...pkg, story: { ...pkg.story, conflict: undefined } }, 'u1');
    expect(project.storyArc).toBeUndefined();
  });

  it('gives each handoff a distinct project id', () => {
    const a = packageToProjectPayload(populated(), 'u1');
    const b = packageToProjectPayload(populated(), 'u1');
    expect(a.project_id).not.toBe(b.project_id);
  });
});
