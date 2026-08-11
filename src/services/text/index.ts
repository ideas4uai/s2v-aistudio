import { anthropicProvider } from './anthropic.js';
import { geminiProvider } from './gemini.js';
import { openAiCompatProvider } from './openaiCompat.js';
import { statusOf, type TextGenOptions, type TextProvider } from './types.js';

export type { TextProvider, TextGenOptions } from './types.js';

/**
 * Ordered text-generation chain for Content Studio agents.
 *
 * Set TEXT_PROVIDERS to a comma-separated list (default `gemini`). The existing
 * video pipeline keeps calling AIService directly and is unaffected.
 */
function buildProvider(name: string): TextProvider | null {
  switch (name) {
    case 'gemini':
      return geminiProvider;
    case 'anthropic':
      return anthropicProvider;
    case 'openai':
      return openAiCompatProvider({
        name: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: process.env.OPENAI_API_KEY,
        model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
      });
    case 'openrouter':
      return openAiCompatProvider({
        name: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: process.env.OPENROUTER_API_KEY,
        model: process.env.OPENROUTER_MODEL ?? 'anthropic/claude-sonnet-4.5',
      });
    case 'local':
      return openAiCompatProvider({
        name: 'local',
        baseUrl: process.env.LOCAL_LLM_URL ?? 'http://localhost:11434/v1',
        // Local runtimes ignore the key but the OpenAI shape requires one.
        apiKey: process.env.LOCAL_LLM_KEY ?? 'local',
        model: process.env.LOCAL_LLM_MODEL ?? 'llama3.1',
      });
    default:
      console.warn(`[TextProvider] Unknown provider "${name}" in TEXT_PROVIDERS — skipping.`);
      return null;
  }
}

export function resolveChain(): TextProvider[] {
  const names = (process.env.TEXT_PROVIDERS ?? 'gemini').split(',').map((n) => n.trim()).filter(Boolean);
  const chain = names.map(buildProvider).filter((p): p is TextProvider => p !== null);
  if (!chain.length) throw new Error('TEXT_PROVIDERS resolved to no usable providers.');
  return chain;
}

// Circuit breaker, same rule as the image cascade in aiService: 401/402/403
// means a bad key or exhausted credit and will fail every call, so stop trying
// that provider for the rest of the process. 429/5xx recover, so they never
// open it. In-memory by design — a restart retries.
const deadProviders = new Set<string>();

/** Exposed for tests; also useful after rotating a key without a restart. */
export function resetProviderBreakers(): void {
  deadProviders.clear();
}

export async function generateText(prompt: string, options?: TextGenOptions): Promise<string> {
  const chain = resolveChain();
  const errors: string[] = [];

  for (const provider of chain) {
    if (deadProviders.has(provider.name)) continue;
    try {
      return await provider.generate(prompt, options);
    } catch (error: any) {
      const status = statusOf(error);
      if (status === 401 || status === 402 || status === 403) {
        deadProviders.add(provider.name);
        console.warn(`[TextProvider] ${provider.name} circuit-opened (status ${status}) — skipping for this session.`);
      }
      errors.push(`${provider.name}: ${error?.message ?? error}`);
    }
  }

  throw new Error(`All text providers failed. ${errors.join(' | ')}`);
}
