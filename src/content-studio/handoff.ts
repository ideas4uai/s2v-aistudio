import { v4 as uuidv4 } from 'uuid';
import type { Project } from '../models/project.js';
import type { ProductionPackage } from './domain/types.js';

/**
 * The one boundary between Content Studio and Script2Video.
 *
 * Kept as a pure mapper with no pipeline imports so it stays testable and so
 * the renderer is never reached into — the studio hands over a draft Project
 * and the existing pipeline takes it from there, unchanged.
 */

/** Narration for the whole episode, in scene order. */
export function packageToScript(pkg: ProductionPackage): string {
  return [...pkg.scenes]
    .sort((a, b) => a.order - b.order)
    .map((scene) => scene.dialogue.map((line) => line.text).join(' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

export function packageToProjectPayload(pkg: ProductionPackage, userId: string): Project {
  const mode = pkg.render.target === 'long' ? 'long' : 'shorts';
  const now = new Date();

  return {
    project_id: uuidv4(),
    userId,
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
      // Shorts run ~60s vertical, long-form ~3m landscape. The studio doesn't
      // model per-episode length yet, so derive it from the render target.
      targetLength: mode === 'long' ? '3m' : '60s',
      aspectRatio: mode === 'long' ? '16:9' : '9:16',
    },
    seo_metadata: {
      title: pkg.story.title,
      description: pkg.captions.youTubeDescription || pkg.story.hook || '',
      tags: pkg.captions.keywords,
      thumbnailText: (pkg.thumbnail as any)?.headline || pkg.story.title,
    },
    storyArc: pkg.story.conflict
      ? {
          beat_1_hook: pkg.story.hook,
          beat_2_context: pkg.story.conflict,
          beat_3_surprise: pkg.story.escalation || pkg.story.twist || '',
          beat_4_insight: pkg.story.lesson || '',
          beat_5_cta: pkg.story.cta || '',
        }
      : undefined,
  };
}
