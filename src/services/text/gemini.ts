import { AIService } from '../aiService.js';
import type { TextGenOptions, TextProvider } from './types.js';

/**
 * Wraps the existing AIService so studio agents inherit what the pipeline
 * already has: the four-key quota rotation in geminiAuth.getKeyForTask and the
 * 429/503 fallback to gemini-2.5-flash-lite. No behavior of its own.
 */
export const geminiProvider: TextProvider = {
  name: 'gemini',
  generate: (prompt: string, options?: TextGenOptions) => AIService.generateText(prompt, options),
};
