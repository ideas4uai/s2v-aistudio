import { WordTimestamp, CaptionChunk } from '../models/scene.js';

export const captionService = {
  generateCaptions: async (scene: any, audioPath: string, mode: string): Promise<{ words: WordTimestamp[], chunks: CaptionChunk[] }> => {
    return generateCaptions(scene, audioPath, mode);
  }
};

export const generateCaptions = async (scene: any, audioPath: string, mode: string): Promise<{ words: WordTimestamp[], chunks: CaptionChunk[] }> => {
  const text = scene.narration_text || "";
  const duration = scene.duration_actual || scene.duration_target || 5;

  const WORDS_PER_BLOCK = 3;
  const words = text.split(' ').filter((w: string) => w.trim());
  if (words.length === 0) return { words: [], chunks: [] };

  const blocks: string[] = [];
  for (let i = 0; i < words.length; i += WORDS_PER_BLOCK) {
    blocks.push(words.slice(i, i + WORDS_PER_BLOCK).join(' '));
  }

  const blockDuration = duration / blocks.length;

  // WordTimestamp array for compatibility (per-word even distribution)
  const timePerWord = duration / words.length;
  const wordsWithTiming: WordTimestamp[] = words.map((w: string, i: number) => ({
    word: w,
    start: i * timePerWord,
    end: (i + 1) * timePerWord,
    confidence: 0.9
  }));

  const chunks: CaptionChunk[] = blocks.map((blockText, i) => {
    const colorTag = '{\\c&H00FFFFFF&}';
    return {
      words: blockText.split(' '),
      text: `${colorTag}${blockText}`,
      start: i * blockDuration,
      end: (i + 1) * blockDuration,
    };
  });

  return { words: wordsWithTiming, chunks };
};

export const fallbackCaptions = (scene: any, mode: string): { words: WordTimestamp[], chunks: CaptionChunk[] } => {
  const text = scene.narration_text || "";
  const duration = scene.duration_target || 5;

  const WORDS_PER_BLOCK = 3;
  const words = text.split(' ').filter((w: string) => w.trim());
  if (words.length === 0) return { words: [], chunks: [] };

  const blocks: string[] = [];
  for (let i = 0; i < words.length; i += WORDS_PER_BLOCK) {
    blocks.push(words.slice(i, i + WORDS_PER_BLOCK).join(' '));
  }
  const blockDuration = duration / blocks.length;

  const timePerWord = duration / words.length;
  const wordsWithTiming: WordTimestamp[] = words.map((w: string, i: number) => ({
    word: w,
    start: i * timePerWord,
    end: (i + 1) * timePerWord,
    confidence: 0.9
  }));

  const chunks: CaptionChunk[] = blocks.map((blockText, i) => {
    const colorTag = '{\\c&H00FFFFFF&}';
    return {
      words: blockText.split(' '),
      text: `${colorTag}${blockText}`,
      start: i * blockDuration,
      end: (i + 1) * blockDuration,
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
