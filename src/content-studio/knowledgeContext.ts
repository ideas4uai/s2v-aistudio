import type { KnowledgeDocument } from './domain/types.js';

// Bibles grow without limit and are injected into every agent prompt. Without a
// cap, a well-used knowledge base silently blows the context window months after
// anyone last looked at it.
const MAX_CHARS = 12000;
const MAX_PER_DOC = 3000;

/**
 * Render the knowledge documents matching `categories` as a Markdown block for
 * prompt injection. Most-recently-updated first, so truncation drops the
 * stalest material rather than an arbitrary slice.
 */
export function buildKnowledgeContext(
  documents: KnowledgeDocument[],
  categories: KnowledgeDocument['category'][],
): string {
  const selected = documents
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
