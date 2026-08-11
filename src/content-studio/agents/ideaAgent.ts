import { generateText } from '../../services/text/index.js';
import { parseJsonResponse } from '../../utils/parseJsonResponse.js';
import { buildKnowledgeContext } from '../knowledgeContext.js';
import type { KnowledgeDocument } from '../domain/types.js';
import type { AgentContext, AgentResult, StudioAgent } from '../workflow/types.js';

interface RankedIdea {
  angle: string;
  engagement?: number;
  originality?: number;
  educationalValue?: number;
  visualPotential?: number;
  brandFit?: number;
  rationale?: string;
}

const score = (idea: RankedIdea): number =>
  (idea.engagement ?? 0) + (idea.originality ?? 0) + (idea.educationalValue ?? 0) +
  (idea.visualPotential ?? 0) + (idea.brandFit ?? 0);

/**
 * Generates and ranks candidate angles for the episode's seed topic. The winner
 * becomes the working title; the runners-up are kept in qualityScores.notes so
 * a human can pick a different one without re-running the stage.
 */
export const ideaAgent: StudioAgent = {
  stage: 'idea',
  name: 'Idea Agent',

  validate(context: AgentContext): string[] {
    return context.package.story.title?.trim() ? [] : ['The episode needs a seed topic before ideas can be generated.'];
  },

  async execute(context: AgentContext): Promise<AgentResult> {
    const knowledge = buildKnowledgeContext(
      context.knowledge as unknown as KnowledgeDocument[],
      ['brand_bible', 'episode_history', 'lessons_learned'],
      context.universe,
    );

    const raw = await generateText(
      `You are a content strategist for a short-form video channel.

SEED TOPIC: "${context.package.story.title}"
${knowledge}

Generate 5 distinct angles on this topic. Avoid any angle that repeats a previous episode listed above.
Score each from 1-10 on engagement, originality, educationalValue, visualPotential, and brandFit.

Output ONLY a JSON array:
[{"angle": "...", "engagement": 8, "originality": 7, "educationalValue": 9, "visualPotential": 6, "brandFit": 8, "rationale": "one sentence"}]`,
      { task: 'planning' },
    );

    const ideas = parseJsonResponse<RankedIdea[]>(raw);
    if (!Array.isArray(ideas) || !ideas.length) throw new Error('Idea Agent returned no usable ideas.');

    const ranked = [...ideas].sort((a, b) => score(b) - score(a));
    const winner = ranked[0];
    if (!winner.angle?.trim()) throw new Error('Idea Agent returned an idea with no angle.');

    return {
      package: {
        ...context.package,
        story: { ...context.package.story, title: winner.angle.trim() },
        qualityScores: {
          ...context.package.qualityScores,
          engagement: winner.engagement,
          originality: winner.originality,
          educationalValue: winner.educationalValue,
          visualPotential: winner.visualPotential,
          brandFit: winner.brandFit,
          notes: ranked.slice(1).map((idea) => `Alternative: ${idea.angle}${idea.rationale ? ` — ${idea.rationale}` : ''}`),
        },
      },
      message: `Ranked ${ranked.length} angles; selected "${winner.angle}".`,
    };
  },
};
