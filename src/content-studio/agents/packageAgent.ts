import { DirectorAgent } from '../../pipeline/agents/directorAgent.js';
import { ScriptwriterAgent } from '../../pipeline/agents/scriptwriterAgent.js';
import { StoryboardAgent } from '../../pipeline/agents/storyboardAgent.js';
import type { Scene } from '../../models/scene.js';
import { generateText } from '../../services/text/index.js';
import { parseJsonResponse } from '../../utils/parseJsonResponse.js';
import { packageToProjectPayload } from '../handoff.js';
import { buildKnowledgeContext } from '../knowledgeContext.js';
import type { KnowledgeDocument, ProductionScene, PublishingCopy } from '../domain/types.js';
import type { AgentContext, AgentResult, StudioAgent } from '../workflow/types.js';

/**
 * Turns the approved story into scenes, dialogue, and image prompts by
 * DELEGATING to the pipeline agents Script2Video already uses — DirectorAgent
 * for the visual plan, ScriptwriterAgent for beats, StoryboardAgent for the
 * image prompts (few-shot, shot-type rotation, character anchors, LoRA routing).
 *
 * Re-prompting for this from scratch would fork the prompt engineering that
 * already drives every render.
 */

function toProductionScene(scene: Scene): ProductionScene {
  const speaker = scene.character || 'NARRATOR';
  return {
    id: scene.scene_id,
    order: scene.order,
    objective: scene.caption_text || scene.narration_text || `Scene ${scene.order}`,
    durationSeconds: scene.duration_target,
    camera: scene.motion_instruction ?? undefined,
    transition: scene.transition_type,
    characters: scene.character ? [scene.character] : [],
    expressions: scene.character && scene.emotion ? { [scene.character]: scene.emotion } : undefined,
    environment: scene.background_prompt,
    dialogue: scene.narration_text ? [{ speaker, text: scene.narration_text }] : [],
    imagePrompt: scene.visuals?.[0]?.prompt ? { positive: scene.visuals[0].prompt } : undefined,
  };
}

export const packageAgent: StudioAgent = {
  stage: 'package',
  name: 'Package Agent',

  validate(context: AgentContext): string[] {
    const errors: string[] = [];
    if (!context.package.story.title?.trim()) errors.push('A story title is required.');
    if (!context.package.story.hook?.trim()) errors.push('Approve the story stage before building the package.');
    return errors;
  },

  async execute(context: AgentContext): Promise<AgentResult> {
    const pkg = context.package;

    // A draft project is the input contract every pipeline agent already
    // expects; building one here means zero changes on their side.
    const project = packageToProjectPayload(pkg, pkg.ownerId);
    const plan = await DirectorAgent.planVideo(project);
    const { scenes: drafts } = await ScriptwriterAgent.writeScript(project, plan, project.storyArc);
    if (!drafts?.length) throw new Error('Scriptwriter produced no scenes.');
    const scenes = await StoryboardAgent.expandVisuals(project, plan, drafts);

    const knowledge = buildKnowledgeContext(
      context.knowledge as unknown as KnowledgeDocument[],
      ['brand_bible', 'visual_style'],
    );

    const raw = await generateText(
      `Write publishing copy for this episode.

TITLE: ${pkg.story.title}
HOOK: ${pkg.story.hook}
LESSON: ${pkg.story.lesson ?? ''}
${knowledge}

Output ONLY JSON:
{
  "instagramCaption": "...", "linkedInPost": "...", "youTubeDescription": "...",
  "cta": "...", "hashtags": ["#one"], "keywords": ["one"],
  "thumbnail": {"headline": "4 words max", "concept": "...", "emotion": "...", "ctrScore": 8}
}`,
      { task: 'seo' },
    );

    const copy = parseJsonResponse<PublishingCopy & { thumbnail?: Record<string, unknown> }>(raw);

    return {
      package: {
        ...pkg,
        scenes: scenes.map(toProductionScene),
        captions: {
          instagramCaption: copy.instagramCaption,
          linkedInPost: copy.linkedInPost,
          youTubeDescription: copy.youTubeDescription,
          cta: copy.cta ?? pkg.story.cta,
          hashtags: Array.isArray(copy.hashtags) ? copy.hashtags : [],
          keywords: Array.isArray(copy.keywords) ? copy.keywords : [],
        },
        thumbnail: copy.thumbnail ?? pkg.thumbnail,
        status: 'approved',
      },
      message: `Built ${scenes.length} scenes with image prompts and publishing copy.`,
    };
  },
};
