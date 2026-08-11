import { FirestoreService } from '../server/db/firestore.js';
import type { Universe } from '../models/project.js';
import { normalizeUniverse } from './knowledgeContext.js';

/**
 * Bridges Content Studio's universe slug to Script2Video's universe record.
 *
 * The studio scopes knowledge with a slug (`aiqa-engineer`); the pipeline needs
 * the full object (cast appearance, art style, episode structure) to build
 * character-locked prompts. Matching is on the slugified title, so there is no
 * second identifier to keep in sync — `AIQA Engineer` resolves `aiqa-engineer`.
 */
export async function resolveUniverse(userId: string, slug?: string): Promise<Universe | undefined> {
  const wanted = normalizeUniverse(slug);
  if (wanted === normalizeUniverse(undefined)) return undefined;
  try {
    const universes = await FirestoreService.listDocuments('universes', userId) as any[];
    return universes?.find((u) => normalizeUniverse(u?.title) === wanted) as Universe | undefined;
  } catch (error) {
    // A missing universe degrades the episode to generic prompting; it must not
    // fail the stage outright.
    console.warn(`[ContentStudio] Could not resolve universe "${slug}":`, error);
    return undefined;
  }
}
