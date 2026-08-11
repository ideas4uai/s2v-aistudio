import { describe, it, expect } from 'vitest';
import { buildKnowledgeContext, normalizeUniverse, DEFAULT_UNIVERSE } from '../src/content-studio/knowledgeContext.js';
import type { KnowledgeDocument } from '../src/content-studio/domain/types.js';

function doc(overrides: Partial<KnowledgeDocument>): KnowledgeDocument {
  return {
    id: 'id', userId: 'u1', title: 'Doc', category: 'brand_bible', content: 'body',
    tags: [], relatedDocumentIds: [], version: 1,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildKnowledgeContext universe scoping', () => {
  const aiqa = doc({ id: 'a', universe: 'aiqa-engineer', title: 'AIQA Brand', content: 'Ravi and Arjun.' });
  const nullverse = doc({ id: 'n', universe: 'universe-of-null', title: 'NULL Brand', content: 'Veer and Nova.' });

  it('returns only the requested universe when several coexist', () => {
    const context = buildKnowledgeContext([aiqa, nullverse], ['brand_bible'], 'aiqa-engineer');

    expect(context).toContain('AIQA Brand');
    expect(context).not.toContain('NULL Brand');
    expect(context).not.toContain('Veer and Nova');
  });

  it('scopes the other direction too', () => {
    const context = buildKnowledgeContext([aiqa, nullverse], ['brand_bible'], 'universe-of-null');

    expect(context).toContain('NULL Brand');
    expect(context).not.toContain('Ravi and Arjun');
  });

  it('keeps unscoped documents in the default universe, invisible to named ones', () => {
    const legacy = doc({ id: 'l', title: 'Legacy Brand', universe: undefined });

    expect(buildKnowledgeContext([legacy], ['brand_bible'], DEFAULT_UNIVERSE)).toContain('Legacy Brand');
    expect(buildKnowledgeContext([legacy], ['brand_bible'])).toContain('Legacy Brand');
    expect(buildKnowledgeContext([legacy], ['brand_bible'], 'aiqa-engineer')).toBe('');
  });

  it('still filters by category inside a universe', () => {
    const visual = doc({ id: 'v', universe: 'aiqa-engineer', category: 'visual_style', title: 'AIQA Visuals' });

    const context = buildKnowledgeContext([aiqa, visual], ['visual_style'], 'aiqa-engineer');
    expect(context).toContain('AIQA Visuals');
    expect(context).not.toContain('AIQA Brand');
  });

  it('matches universes written in different shapes', () => {
    expect(normalizeUniverse('AIQA Engineer')).toBe('aiqa-engineer');
    expect(normalizeUniverse('  aiqa-engineer  ')).toBe('aiqa-engineer');
    expect(normalizeUniverse('')).toBe(DEFAULT_UNIVERSE);
    expect(normalizeUniverse(undefined)).toBe(DEFAULT_UNIVERSE);

    expect(buildKnowledgeContext([aiqa], ['brand_bible'], 'AIQA Engineer')).toContain('AIQA Brand');
  });
});
