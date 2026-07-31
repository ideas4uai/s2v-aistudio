import { describe, expect, it } from 'vitest';
import { createProductionPackage, createStudioEpisode, createWorkflowState, validateProductionPackage } from '../src/content-studio/domain/productionPackage';

describe('AI Content Studio production package contract', () => {
  it('creates a complete package shell and ordered workflow state', () => {
    const episode = createStudioEpisode('user-1', 'Title', 'Topic');
    const productionPackage = createProductionPackage(episode.id, episode.userId, episode.title);

    expect(episode.status).toBe('draft');
    expect(productionPackage.episodeId).toBe(episode.id);
    expect(productionPackage.schemaVersion).toBe('1.0.0');
    expect(validateProductionPackage(productionPackage)).toEqual([]);
    expect(createWorkflowState().map((stage) => stage.stage)).toEqual(['idea', 'story', 'package', 'handoff']);
  });

  it('rejects malformed package invariants', () => {
    const productionPackage = createProductionPackage('episode-1', 'user-1', 'Title');
    const malformed = { ...productionPackage, scenes: [{ id: 'one', dialogue: [] }, { id: 'one', dialogue: 'not-an-array' }] };

    expect(validateProductionPackage(malformed)).toContain('Every scene needs a unique id.');
    expect(validateProductionPackage(malformed)).toContain('Scene one must include dialogue as an array.');
  });
});
