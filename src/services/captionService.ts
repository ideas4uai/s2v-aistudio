import { WordTimestamp, CaptionChunk } from '../models/scene.js';

export const captionService = {
  generateCaptions: async (scene: any, audioPath: string, mode: string): Promise<{ words: WordTimestamp[], chunks: CaptionChunk[] }> => {
    return generateCaptions(scene, audioPath, mode);
  }
};

export const generateCaptions = async (scene: any, audioPath: string, mode: string): Promise<{ words: WordTimestamp[], chunks: CaptionChunk[] }> => {
  const text = scene.narration_text || "";
  const wordsStrings = text.split(/\s+/).filter((w: string) => w.length > 0);
  const duration = scene.duration_actual || scene.duration_target || 5;
  const timePerWord = duration / Math.max(wordsStrings.length, 1);

  const wordsWithTiming: WordTimestamp[] = wordsStrings.map((w: string, i: number) => ({
    word: w,
    start: i * timePerWord,
    end: (i + 1) * timePerWord,
    confidence: 0.9
  }));

  // Punchy Shorts-style chunking: max 3 words per block
  const chunks: CaptionChunk[] = [];
  for (let i = 0; i < wordsWithTiming.length; i += 3) {
    const chunkWords = wordsWithTiming.slice(i, i + 3);
    chunks.push({
      words: chunkWords.map(cw => cw.word),
      text: chunkWords.map(cw => cw.word).join(' '),
      start: chunkWords[0].start,
      end: chunkWords[chunkWords.length - 1].end
    });
  }

  return { 
    words: wordsWithTiming, 
    chunks: chunks 
  };
};

export const fallbackCaptions = (scene: any, mode: string): { words: WordTimestamp[], chunks: CaptionChunk[] } => {
  const text = scene.narration_text || "";
  const wordsStrings = text.split(/\s+/).filter((w: string) => w.length > 0);
  const duration = scene.duration_target || 5;
  const timePerWord = duration / Math.max(wordsStrings.length, 1);

  const wordsWithTiming: WordTimestamp[] = wordsStrings.map((w: string, i: number) => ({
    word: w,
    start: i * timePerWord,
    end: (i + 1) * timePerWord,
    confidence: 0.9
  }));

  const chunks: CaptionChunk[] = [];
  for (let i = 0; i < wordsWithTiming.length; i += 3) {
    const chunkWords = wordsWithTiming.slice(i, i + 3);
    chunks.push({
      words: chunkWords.map((cw: any) => cw.word),
      text: chunkWords.map((cw: any) => cw.word).join(' '),
      start: chunkWords[0].start,
      end: chunkWords[chunkWords.length - 1].end
    });
  }

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
