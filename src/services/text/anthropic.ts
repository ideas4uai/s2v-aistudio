import Anthropic from '@anthropic-ai/sdk';
import type { TextGenOptions, TextProvider } from './types.js';

// Separate from openAiCompatProvider because the Messages API has its own
// request/response shape. Thinking is deliberately unset: on Opus 5 that runs
// adaptive thinking, which is what we want for planning prompts.
const DEFAULT_MODEL = 'claude-opus-5';

let client: Anthropic | null = null;
const getClient = (): Anthropic => (client ??= new Anthropic());

export const anthropicProvider: TextProvider = {
  name: 'anthropic',
  async generate(prompt: string, options?: TextGenOptions): Promise<string> {
    const message = await getClient().messages.create({
      model: options?.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL,
      max_tokens: 16000,
      messages: [{ role: 'user', content: prompt }],
    });
    // A refusal returns HTTP 200 with empty or partial content — reading
    // content[0] blind would surface an index error instead of the real reason.
    if (message.stop_reason === 'refusal') {
      throw new Error(`Anthropic declined the request (${(message as any).stop_details?.category ?? 'unspecified'}).`);
    }
    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');
    if (!text.trim()) throw new Error('Anthropic returned no text.');
    return text;
  },
};
