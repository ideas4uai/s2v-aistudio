import { v4 as uuidv4 } from 'uuid';
import type { Project, Universe } from '../models/project.js';
import type { ProductionPackage } from './domain/types.js';

/**
 * The one boundary between Content Studio and Script2Video.
 *
 * Kept as a pure mapper with no pipeline imports so it stays testable and so
 * the renderer is never reached into — the studio hands over a draft Project
 * and the existing pipeline takes it from there, unchanged.
 */

const joinBeats = (...beats: Array<string | undefined>): string =>
  beats.map((beat) => beat?.trim()).filter(Boolean).join(' → ');

/** Narration for the whole episode, in scene order. */
export function packageToScript(pkg: ProductionPackage): string {
  return [...pkg.scenes]
    .sort((a, b) => a.order - b.order)
    .map((scene) => scene.dialogue.map((line) => line.text).join(' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

/**
 * @param universe Resolved Script2Video universe for `pkg.universe`, when one
 *   exists. Director and Storyboard read character appearance, art style and
 *   episode structure off this object — without it they fall back to generic
 *   photorealistic prompting with no cast.
 */
export function packageToProjectPayload(pkg: ProductionPackage, userId: string, universe?: Universe): Project {
  const mode = pkg.render.target === 'long' ? 'long' : 'shorts';
  const now = new Date();

  return {
    ...(universe ? { universe, episodeNumber: 1 } : {}),
    project_id: uuidv4(),
    userId,
    // Carry the origin across the handoff. A project that cannot name the run it came
    // from cannot be asked whether its story was approved, and scheduled publishing has
    // to be able to ask that before it acts unattended.
    contentStudio: { episodeId: pkg.episodeId, packageId: pkg.id },
    mode,
    topic: pkg.story.title,
    hook_strategy: pkg.story.hook || 'question',
    pacing_intensity: 'medium',
    style_profile: 'cinematic',
    status: 'draft',
    script: packageToScript(pkg),
    created_at: now,
    updated_at: now,
    projectType: 'story_episode',
    scenes: [],
    error_log: null,
    settings: {
      // A universe that states its episode length wins — a 12-second reel
      // universe and a 60-second shorts channel are not the same format.
      // Otherwise: shorts ~60s vertical, long-form ~3m landscape.
      targetLength: universe?.targetDurationSeconds
        ? `${universe.targetDurationSeconds}s`
        : (mode === 'long' ? '3m' : '60s'),
      aspectRatio: mode === 'long' ? '16:9' : '9:16',
    },
    seo_metadata: {
      title: pkg.story.title,
      description: pkg.captions.youTubeDescription || pkg.story.hook || '',
      tags: pkg.captions.keywords,
      thumbnailText: (pkg.thumbnail as any)?.headline || pkg.story.title,
    },
    // Seven authored beats into five arc slots. Escalation+twist and
    // punchline+reaction each share one slot rather than being dropped — the
    // payoff used to fall off the end entirely.
    storyArc: pkg.story.conflict
      ? {
          beat_1_hook: pkg.story.hook,
          beat_2_context: pkg.story.conflict,
          beat_3_surprise: joinBeats(pkg.story.escalation, pkg.story.twist),
          beat_4_insight: joinBeats(pkg.story.punchline, pkg.story.reaction) || pkg.story.ending || pkg.story.lesson || '',
          beat_5_cta: pkg.story.cta || '',
        }
      : undefined,
  };
}
