import type { KnowledgeDocument, UniverseId } from './domain/types.js';

// Bibles grow without limit and are injected into every agent prompt. Without a
// cap, a well-used knowledge base silently blows the context window months after
// anyone last looked at it.
const MAX_CHARS = 12000;
const MAX_PER_DOC = 3000;

/**
 * The scope documents and episodes fall into when nobody named one. Everything
 * written before universes existed lands here, so old data stays visible to old
 * episodes and invisible to new universes.
 */
export const DEFAULT_UNIVERSE = 'default';

/** Slug form, so `AIQA Engineer`, `aiqa-engineer` and ` AIQA-Engineer ` scope alike. */
export function normalizeUniverse(value: unknown): UniverseId {
  const slug = typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    : '';
  return slug || DEFAULT_UNIVERSE;
}

/**
 * Render the knowledge documents matching `categories` as a Markdown block for
 * prompt injection. Most-recently-updated first, so truncation drops the
 * stalest material rather than an arbitrary slice.
 *
 * Scoped to one universe: this is the single gate every agent prompt passes
 * through, so filtering here — rather than in each agent — is what keeps one
 * brand's bibles out of another brand's episodes.
 */
export function buildKnowledgeContext(
  documents: KnowledgeDocument[],
  categories: KnowledgeDocument['category'][],
  universe?: UniverseId,
): string {
  const scope = normalizeUniverse(universe);
  const selected = documents
    .filter((doc) => normalizeUniverse(doc.universe) === scope)
    .filter((doc) => categories.includes(doc.category))
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));

  const sections: string[] = [];
  let budget = MAX_CHARS;
  for (const doc of selected) {
    if (budget <= 0) break;
    const body = doc.content.slice(0, Math.min(MAX_PER_DOC, budget));
    sections.push(`### ${doc.title} (${doc.category})\n${body}`);
    budget -= body.length;
  }

  return sections.length ? `KNOWLEDGE BASE:\n${sections.join('\n\n')}` : '';
}
