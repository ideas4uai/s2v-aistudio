import type { TextGenOptions, TextProvider } from './types.js';

/**
 * One provider for every backend that speaks OpenAI's /chat/completions:
 * OpenAI itself, OpenRouter, and local runtimes (Ollama, LM Studio, vLLM).
 * Three of the four requested backends, no SDK required.
 */
export function openAiCompatProvider(config: {
  name: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
}): TextProvider {
  return {
    name: config.name,
    async generate(prompt: string, options?: TextGenOptions): Promise<string> {
      if (!config.apiKey) throw Object.assign(new Error(`${config.name} has no API key configured.`), { status: 401 });
      const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: options?.model ?? config.model,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!response.ok) {
        const body = await response.text();
        // Carry the status so the chain's breaker can tell a dead key (401/402/403)
        // from a transient rate limit (429) — only the former should open it.
        throw Object.assign(new Error(`${config.name} ${response.status}: ${body.slice(0, 300)}`), { status: response.status });
      }
      const data: any = await response.json();
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) throw new Error(`${config.name} returned no text.`);
      return text;
    },
  };
}
