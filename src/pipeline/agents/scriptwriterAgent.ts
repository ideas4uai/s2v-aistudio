import { Project } from '../../models/project.js';
import { AIService } from '../../services/aiService.js';
import { DirectorPlan } from './directorAgent.js';
import { StoryArc } from './storyAgent.js';
import { targetLengthSeconds, targetWordCount, TARGET_TOLERANCE } from '../../utils/targetLength.js';
import { buildKnowledgeContext, normalizeUniverse } from '../../content-studio/knowledgeContext.js';
import type { KnowledgeDocument } from '../../content-studio/domain/types.js';
import {
  buildScriptPrompt, buildScriptSections, flagUnverifiedClaims, flagCraftIssues, type ScriptBrief,
} from './scriptPrompt.js';

/**
 * The Script Agent: turns approved story beats into the actual spoken words.
 *
 * It does not decide what happens — StoryAgent does that, and this agent is
 * forbidden from adding or reordering the beats it is handed. Its whole job is
 * prose and pacing: the right words, in the right voice, at the length the
 * project asked for.
 *
 * It used to carry three hand-written prompts (character episode, conversational,
 * legacy) that had drifted apart, each with its own baked-in assumptions about
 * scene length and format. They are one generic template now — see scriptPrompt.ts.
 * Everything project-specific arrives as data, so a universe nobody has created
 * yet is already supported.
 */

/** Bibles that describe how a series talks. Visual-only categories are the storyboard's business. */
const SCRIPT_KNOWLEDGE: KnowledgeDocument['category'][] = [
  'brand_bible',
  'character_bible',
  'production_bible',
  'running_jokes',
  'relationships',
];

function briefFor(
  project: Project,
  plan: DirectorPlan | undefined,
  storyArc: StoryArc | undefined,
  knowledgeDocs: KnowledgeDocument[],
): ScriptBrief {
  const universe = project.universe;
  // Same featured-cast rule DirectorAgent uses, so the two agents never disagree
  // about who is in the episode.
  const cast = universe && project.featuredCharacterIds?.length
    ? universe.characters.filter((c: any) => project.featuredCharacterIds!.includes(c.id))
    : (universe?.characters ?? []);

  const notes: string[] = [];
  if (project.character_description) notes.push(`Character focus: ${project.character_description}`);
  for (const c of project.world_entities?.characters ?? []) notes.push(`Character — ${c.name}: ${c.description}`);
  for (const l of project.world_entities?.locations ?? []) notes.push(`Location — ${l.name}: ${l.description}`);

  return {
    topic: project.topic,
    targetSeconds: targetLengthSeconds(project.settings?.targetLength),
    hookStrategy: project.hook_strategy,
    mode: project.mode,
    brand: universe
      ? {
          name: universe.title,
          world: universe.world,
          toneRules: universe.toneRules,
          episodeStructure: universe.episodeStructure,
        }
      : undefined,
    cast: cast.map((c: any) => ({ name: c.name, role: c.role, personality: c.personality, voiceStyle: c.voiceStyle })),
    knowledge: buildKnowledgeContext(knowledgeDocs, SCRIPT_KNOWLEDGE, normalizeUniverse(universe?.title)),
    spine: storyArc && {
      Hook: storyArc.beat_1_hook,
      Context: storyArc.beat_2_context,
      Surprise: storyArc.beat_3_surprise,
      Insight: storyArc.beat_4_insight,
      CTA: storyArc.beat_5_cta,
    },
    notes,
    direction: plan && {
      mood: plan.overall_mood,
      narrativeArc: plan.narrative_arc,
      pacing: plan.pacing_notes,
      styleProfile: project.style_profile,
    },
  };
}

function parseScriptJson(response: string): any {
  try {
    return JSON.parse(response);
  } catch {
    const jsonStr = response.replace(/```json\n?|```/g, '').trim();
    const firstBrace = jsonStr.indexOf('{');
    const lastBrace = jsonStr.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1) throw new Error('AI returned malformed JSON, will retry');
    return JSON.parse(jsonStr.substring(firstBrace, lastBrace + 1).replace(/,(\s*[}\]])/g, '$1'));
  }
}

const countWords = (scenes: any[]): number =>
  scenes.reduce((sum, s) => sum + (s.narration || '').split(/\s+/).filter(Boolean).length, 0);

export const ScriptwriterAgent = {
  /**
   * @param knowledgeDocs Knowledge base documents for the owner. Optional — with
   *   none, or with none scoped to this universe, buildKnowledgeContext returns
   *   an empty block and the prompt is simply the generic one.
   */
  writeScript: async (
    project: Project,
    plan: DirectorPlan,
    storyArc?: StoryArc,
    knowledgeDocs: KnowledgeDocument[] = [],
  ) => {
    const brief = briefFor(project, plan, storyArc, knowledgeDocs);
    const prompt = buildScriptPrompt(brief);
    const targetWords = targetWordCount(brief.targetSeconds);

    console.log(
      `[ScriptAgent] ${brief.cast?.length ? `dialogue (${brief.cast.length} cast)` : 'narration'}`,
      `| topic: ${project.topic} | ${brief.targetSeconds}s ≈ ${targetWords} words`,
      `| beats: ${storyArc ? 'supplied' : 'none'} | KB: ${brief.knowledge ? 'yes' : 'none'}`,
    );

    try {
      const response = await AIService.generateText(prompt, { task: 'script' });
      const parsed = parseScriptJson(response);
      let scenes: any[] = parsed.scenes || [];

      scenes = appendNullTease(project, scenes);

      let totalWords = countWords(scenes);
      console.log(`[ScriptAgent] ${totalWords} words / target ${targetWords}`);

      // One expansion retry, and only when the script is short enough that padding
      // could not close the gap without the stills reading as dead air.
      if (totalWords < targetWords * (1 - TARGET_TOLERANCE)) {
        scenes = await expand(scenes, totalWords, targetWords, buildScriptSections(brief).constraints);
        totalWords = countWords(scenes);
      }

      // The prompt is the source material: a figure the brief supplied is sourced,
      // one the model reached for on its own is not.
      const spoken = scenes.map((s) => s.narration || '').join(' ');
      const issues = [
        ...flagUnverifiedClaims(spoken, prompt).map((c) => `unsourced: ${c}`),
        ...flagCraftIssues(spoken, project.topic),
      ];
      if (issues.length) {
        console.warn(`[ScriptAgent] Check before publishing — ${issues.join(' | ')}`);
      }

      return { rawScript: parsed.rawScript || scenes.map((s) => s.narration).filter(Boolean).join(' '), scenes };
    } catch (e) {
      console.error('[ScriptAgent] Failed:', e);
      throw e;
    }
  },
};

/** Serialized-universe easter egg. Untouched behaviour, moved out of the main path. */
function appendNullTease(project: Project, scenes: any[]): any[] {
  if (project.projectType !== 'story_episode') return scenes;
  const hasNull = project.universe?.characters?.some(
    (c: any) => c.name?.toUpperCase() === 'NULL' || c.id === 'null',
  );
  if (!hasNull) return scenes;

  const nullTeases: Record<number, string> = {
    1: 'Phone screen briefly shows corrupted N̷U̷L̷L̷ text for 1 frame, looks like a glitch',
    2: 'News ticker text corrupts with ERROR://NULL for 2 frames then returns to normal',
    3: 'One character eye briefly flashes signal red for 1 frame during emotional moment',
    4: 'Aura or glow effect around a character briefly turns all red for half a second',
    5: 'Mechanical or digital element shows ERROR//NULL text buried in visual noise',
    6: 'A shadowy figure is visible for 3 seconds, cold and still, says nothing',
    7: 'All previous teases replay in quick 8-second montage before final scene',
  };
  const episodeNum = project.episodeNumber || 1;
  console.log(`[ScriptAgent] NULL tease appended for episode ${episodeNum}`);
  return [...scenes, {
    narration: '',
    visual: nullTeases[episodeNum] || nullTeases[1],
    duration: episodeNum === 7 ? 8 : 1.5,
    order: scenes.length,
    is_null_tease: true,
  }];
}

/**
 * @param constraints The same constraints the script was written under. Without them
 *   this call was a free pass: it reached the word count by stacking adjectives and
 *   swapping specific closes for generic ones, undoing the rules one call earlier.
 */
async function expand(scenes: any[], have: number, want: number, constraints: string[] = []): Promise<any[]> {
  console.warn(`[ScriptAgent] Only ${have} words, target ${want}. Requesting expansion...`);
  try {
    const raw = await AIService.generateText(
      `This video script is ${have} words; it needs about ${want}.
Deepen each scene's narration to reach that total — more specific detail, a concrete example, a consequence.
Reach the count with substance only. Adding adjectives and adverbs to existing sentences is not expansion;
if a scene has nothing more to say, leave it alone and give the words to a scene that does.
Keep the same number of scenes, the same order, and the same visual prompts. Change narration only.
Do not add statistics, percentages or citations that are not already present.
The original rules still apply:
${constraints.map((c, i) => `${i + 1}. ${c}`).join('\n')}
Script: ${JSON.stringify(scenes)}
Return ONLY a valid JSON array of scenes in the same shape, no markdown.`,
      { task: 'script' },
    );
    const text = raw.replace(/```json\n?|```/g, '').trim();
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end === -1) return scenes;
    const expanded = JSON.parse(text.substring(start, end + 1));
    if (!Array.isArray(expanded) || !expanded.length) return scenes;
    console.log(`[ScriptAgent] Expanded to ${countWords(expanded)} words`);
    return expanded;
  } catch (err) {
    console.warn('[ScriptAgent] Expansion call failed, using original:', err);
    return scenes;
  }
}
