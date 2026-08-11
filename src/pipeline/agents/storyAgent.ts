import { AIService } from '../../services/aiService.js';
import { DirectorPlan } from './directorAgent.js';

export interface StoryArc {
  beat_1_hook: string;
  beat_2_context: string;
  beat_3_surprise: string;
  beat_4_insight: string;
  beat_5_cta: string;
}

export const StoryAgent = {
  async buildArc(
    topic: string,
    selectedHook: string,
    directorPlan: DirectorPlan
  ): Promise<StoryArc> {
    const prompt = `You are a story architect for YouTube Shorts. Build a 5-beat narrative spine for a Short about: "${topic}"

Opening hook (use verbatim as beat 1): "${selectedHook}"
Mood: ${directorPlan.overall_mood}
Narrative style: ${directorPlan.narrative_arc}

Each beat is a spine note — 1-2 sentences MAX. This is the structure the scriptwriter will expand, not the final script.

Beat definitions:
- beat_1_hook: The selected hook. Copy it verbatim. Do not change a single word.
- beat_2_context: Why this matters RIGHT NOW in 2025-2026. Something changed recently. Present tense. 1-2 sentences.
- beat_3_surprise: The one counterintuitive thing most people get wrong. Include a specific stat, number, or concrete fact if possible.
- beat_4_insight: The actual explanation made simple. Use ONE analogy the viewer already understands. 1-2 sentences.
- beat_5_cta: End with a question or half-revelation that leaves them wanting more. NOT "like and subscribe". NOT "follow me". Something that makes them think "wait, tell me more."

Output ONLY valid JSON, no markdown:
{
  "beat_1_hook": "...",
  "beat_2_context": "...",
  "beat_3_surprise": "...",
  "beat_4_insight": "...",
  "beat_5_cta": "..."
}`;

    const response = await AIService.generateText(prompt, { task: 'script' });

    let parsed: any;
    try {
      parsed = JSON.parse(response);
    } catch {
      const clean = response.replace(/```json\n?|```/g, '').trim();
      const start = clean.indexOf('{');
      const end = clean.lastIndexOf('}');
      if (start === -1 || end === -1) throw new Error('[StoryAgent] Malformed JSON response');
      parsed = JSON.parse(clean.substring(start, end + 1));
    }

    if (!parsed.beat_1_hook) throw new Error('[StoryAgent] Invalid arc — missing beat_1_hook');

    console.log('[StoryAgent] Built 5-beat arc for:', topic);
    return parsed as StoryArc;
  },
};
