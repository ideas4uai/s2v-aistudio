import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateText, resetProviderBreakers, resolveChain } from '../src/services/text/index.js';

const ENV_KEYS = ['TEXT_PROVIDERS', 'OPENAI_API_KEY', 'OPENAI_MODEL'];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  resetProviderBreakers();
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('resolveChain', () => {
  it('defaults to gemini so the existing setup keeps working', () => {
    delete process.env.TEXT_PROVIDERS;
    expect(resolveChain().map((p) => p.name)).toEqual(['gemini']);
  });

  it('preserves order and skips unknown names', () => {
    process.env.TEXT_PROVIDERS = 'openai, nope ,gemini';
    expect(resolveChain().map((p) => p.name)).toEqual(['openai', 'gemini']);
  });

  it('throws when nothing resolves rather than silently generating nothing', () => {
    process.env.TEXT_PROVIDERS = 'nope';
    expect(() => resolveChain()).toThrow(/no usable providers/);
  });
});

describe('generateText circuit breaker', () => {
  it('opens on a missing key (401) and skips the provider on the next call', async () => {
    process.env.TEXT_PROVIDERS = 'openai';
    delete process.env.OPENAI_API_KEY;

    // First call reports the real reason...
    await expect(generateText('hi')).rejects.toThrow(/openai: .*no API key/);
    // ...the second finds the circuit open and never retries it.
    await expect(generateText('hi')).rejects.toThrow(/All text providers failed\.\s*$/);
  });

  it('resetProviderBreakers re-arms a provider after a key rotation', async () => {
    process.env.TEXT_PROVIDERS = 'openai';
    delete process.env.OPENAI_API_KEY;
    await expect(generateText('hi')).rejects.toThrow(/no API key/);
    resetProviderBreakers();
    await expect(generateText('hi')).rejects.toThrow(/no API key/);
  });
});
