import { AIService } from '../../services/aiService.js';

export interface HookOption {
  type: 'question' | 'statement' | 'story';
  text: string;
}

export const HookAgent = {
  async generateHooks(
    topic: string,
    targetAudience: string = 'Indian tech-curious viewers, 18-30'
  ): Promise<HookOption[]> {
    const prompt = `You are a YouTube Shorts hook writer. Generate exactly 3 hooks for a Short about: "${topic}"

Target audience: ${targetAudience}
Tone: "Curious Friend" — sounds like "Wait, have you heard about this?"

HARD RULES for every hook:
- Maximum 15 words
- No jargon, no technical acronyms without explanation
- No "In this video" or "Today we're going to"
- No definitions ("X is a technology that...")
- Must create immediate curiosity or mild discomfort

Generate exactly ONE hook of each type:

question — starts with "What if", "Did you know", "Why do", or a question that challenges assumptions
statement — a surprising or counterintuitive claim that makes you think "wait, really?"
story — first-person, past tense, a real moment that pulls the reader in immediately

Examples for "What is Vibe Coding?":
- question: "What if you never had to write code manually again?"
- statement: "Developers who ignore this in 2026 will seriously regret it."
- story: "I asked an AI to build an entire app yesterday. Here's what happened."

Output ONLY valid JSON, no markdown, no explanation:
{
  "hooks": [
    { "type": "question", "text": "..." },
    { "type": "statement", "text": "..." },
    { "type": "story", "text": "..." }
  ]
}`;

    const response = await AIService.generateText(prompt, { task: 'script' });

    let parsed: any;
    try {
      parsed = JSON.parse(response);
    } catch {
      const clean = response.replace(/```json\n?|```/g, '').trim();
      const start = clean.indexOf('{');
      const end = clean.lastIndexOf('}');
      if (start === -1 || end === -1) throw new Error('[HookAgent] Malformed JSON response');
      parsed = JSON.parse(clean.substring(start, end + 1));
    }

    const hooks: HookOption[] = (parsed.hooks || []).slice(0, 3);
    if (hooks.length === 0) throw new Error('[HookAgent] No hooks returned');

    console.log(`[HookAgent] Generated ${hooks.length} hooks for: ${topic}`);
    hooks.forEach(h => console.log(`  [${h.type}] ${h.text}`));
    return hooks;
  },
};
