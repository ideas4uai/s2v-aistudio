import { WordTimestamp, CaptionChunk } from '../models/scene.js';

/**
 * The window captions are laid out across.
 *
 * Must be the speech, not the segment. A segment runs `speech + target-length hold +
 * apad tail`; dividing its full length by word count spreads the captions over
 * silence, so every caption after the first lands progressively later than the words
 * it belongs to (measured: last caption 2.85s behind on a 6.58s scene). speech_start
 * and speech_end are measured off the assembled segment by detectSpeechSpan().
 */
export const speechWindow = (scene: any): { start: number; span: number } => {
  const fallback = scene.duration_actual || scene.duration_target || 5;
  const start = Number(scene.speech_start) || 0;
  const end = Number(scene.speech_end) || 0;
  // Only trust a measured span; anything degenerate falls back to the old behaviour.
  if (end > start && end - start >= 0.2) return { start, span: end - start };
  return { start: 0, span: fallback };
};

export const captionService = {
  generateCaptions: async (scene: any, audioPath: string, mode: string): Promise<{ words: WordTimestamp[], chunks: CaptionChunk[] }> => {
    return generateCaptions(scene, audioPath, mode);
  }
};

export const generateCaptions = async (scene: any, audioPath: string, mode: string): Promise<{ words: WordTimestamp[], chunks: CaptionChunk[] }> => {
  const text = scene.narration_text || "";
  const { start: speechStart, span } = speechWindow(scene);

  const WORDS_PER_BLOCK = 3;
  const words = text.split(' ').filter((w: string) => w.trim());
  if (words.length === 0) return { words: [], chunks: [] };

  const blocks: string[] = [];
  for (let i = 0; i < words.length; i += WORDS_PER_BLOCK) {
    blocks.push(words.slice(i, i + WORDS_PER_BLOCK).join(' '));
  }

  const blockDuration = span / blocks.length;

  // WordTimestamp array for compatibility (per-word even distribution)
  const timePerWord = span / words.length;
  const wordsWithTiming: WordTimestamp[] = words.map((w: string, i: number) => ({
    word: w,
    start: speechStart + i * timePerWord,
    end: speechStart + (i + 1) * timePerWord,
    confidence: 0.9
  }));

  const chunks: CaptionChunk[] = blocks.map((blockText, i) => {
    const colorTag = '{\\c&H00FFFFFF&}';
    return {
      words: blockText.split(' '),
      text: `${colorTag}${blockText}`,
      start: speechStart + i * blockDuration,
      end: speechStart + (i + 1) * blockDuration,
    };
  });

  return { words: wordsWithTiming, chunks };
};

export const fallbackCaptions = (scene: any, mode: string): { words: WordTimestamp[], chunks: CaptionChunk[] } => {
  const text = scene.narration_text || "";
  // No segment has been assembled on this path, so there is no measured speech span
  // — but honour one if it happens to be present rather than re-introducing the bug.
  const { start: speechStart, span } = speechWindow({ ...scene, duration_actual: scene.duration_target || 5 });

  const WORDS_PER_BLOCK = 3;
  const words = text.split(' ').filter((w: string) => w.trim());
  if (words.length === 0) return { words: [], chunks: [] };

  const blocks: string[] = [];
  for (let i = 0; i < words.length; i += WORDS_PER_BLOCK) {
    blocks.push(words.slice(i, i + WORDS_PER_BLOCK).join(' '));
  }
  const blockDuration = span / blocks.length;

  const timePerWord = span / words.length;
  const wordsWithTiming: WordTimestamp[] = words.map((w: string, i: number) => ({
    word: w,
    start: speechStart + i * timePerWord,
    end: speechStart + (i + 1) * timePerWord,
    confidence: 0.9
  }));

  const chunks: CaptionChunk[] = blocks.map((blockText, i) => {
    const colorTag = '{\\c&H00FFFFFF&}';
    return {
      words: blockText.split(' '),
      text: `${colorTag}${blockText}`,
      start: speechStart + i * blockDuration,
      end: speechStart + (i + 1) * blockDuration,
    };
  });

  return { words: wordsWithTiming, chunks };
};

export const validateCaptionTiming = (scene: any, mode: string) => {
  // Ensure we don't exceed duration
  const duration = scene.duration_actual || 5;
  if (scene.captions) {
    scene.captions.forEach((w: any) => {
      if (w.end > duration) w.end = duration;
    });
  }
};

export const generateCaptionChunks = (scene: any) => {
  return scene.caption_chunks || [];
};

export const applyCaptionStyling = (scene: any) => {
  return scene.caption_chunks || [];
};

export const wrapCaptionText = (input: string | { text: string }, maxChars: number | string) => {
  const text = typeof input === 'string' ? input : input.text;
  return text;
};
