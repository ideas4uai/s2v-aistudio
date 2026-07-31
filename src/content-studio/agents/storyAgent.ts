import { generateText } from '../../services/text/index.js';
import { parseJsonResponse } from '../../utils/parseJsonResponse.js';
import { buildKnowledgeContext } from '../knowledgeContext.js';
import type { KnowledgeDocument, StoryPlan } from '../domain/types.js';
import type { AgentContext, AgentResult, StudioAgent } from '../workflow/types.js';

interface StoryResponse extends StoryPlan {
  review?: { overall?: number; clarity?: number; shareability?: number; feedback?: string[] };
}

/**
 * Writes the narrative and scores it in the same call — the spec's separate
 * "review" stage was a second round-trip to grade text the model had just
 * written, which it can do while it still has the reasoning in context.
 *
 * Requires approval: this is the gate before the package stage starts spending
 * image and render budget.
 */
export const storyAgent: StudioAgent = {
  stage: 'story',
  name: 'Story Agent',

  validate(context: AgentContext): string[] {
    return context.package.story.title?.trim() ? [] : ['Run the idea stage before writing the story.'];
  },

  async execute(context: AgentContext): Promise<AgentResult> {
    const knowledge = buildKnowledgeContext(
      context.knowledge as unknown as KnowledgeDocument[],
      ['character_bible', 'running_jokes', 'relationships', 'brand_bible', 'production_bible'],
    );

    const raw = await generateText(
      `You are a story editor for short-form video.

ANGLE: "${context.package.story.title}"
${knowledge}

Write the episode's narrative spine, then critique your own work honestly.

Output ONLY JSON:
{
  "title": "final episode title",
  "hook": "the strongest opening line",
  "hookVariations": [{"text": "alternative hook", "score": 7}],
  "conflict": "...", "escalation": "...", "twist": "...", "ending": "...",
  "lesson": "the takeaway", "cta": "the call to action",
  "review": {"overall": 8, "clarity": 7, "shareability": 9, "feedback": ["what would make this a 10"]}
}`,
      { task: 'script' },
    );

    const story = parseJsonResponse<StoryResponse>(raw);
    if (!story?.title?.trim() || !story?.hook?.trim()) throw new Error('Story Agent returned no title or hook.');

    const { review, ...plan } = story;
    return {
      package: {
        ...context.package,
        story: { ...plan, title: plan.title.trim(), hookVariations: plan.hookVariations ?? [] },
        qualityScores: {
          ...context.package.qualityScores,
          overall: review?.overall,
          clarity: review?.clarity,
          shareability: review?.shareability,
          notes: [...(context.package.qualityScores.notes ?? []), ...(review?.feedback ?? [])],
        },
      },
      message: `Story drafted and self-scored ${review?.overall ?? '?'}/10. Approve to continue.`,
      requiresApproval: true,
    };
  },
};
