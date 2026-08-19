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

/**
 * Per-word timings across the speech window.
 *
 * Even division inside the measured span — the same approximation the captions have
 * always used. It is exported because the motion-graphics overlay needs the same
 * numbers: two timing systems drifting apart is exactly the bug speechWindow() was
 * introduced to fix, so kinetic text reads its words from here rather than deriving
 * its own from the scene duration.
 */
export const wordTimings = (text: string, scene: any): WordTimestamp[] => {
  const { start, span } = speechWindow(scene);
  const words = String(text || '').split(' ').filter((w: string) => w.trim());
  if (!words.length) return [];
  const per = span / words.length;
  return words.map((word: string, i: number) => ({
    word,
    start: start + i * per,
    end: start + (i + 1) * per,
    confidence: 0.9,
  }));
};

export const captionService = {
  generateCaptions: async (scene: any, audioPath: string, mode: string): Promise<{ words: WordTimestamp[], chunks: CaptionChunk[] }> => {
    return generateCaptions(scene, audioPath, mode);
  }
};

/** Words per cue. Three is the short-form norm and stays the ceiling, not the quota. */
export const MAX_WORDS_PER_BLOCK = 3;

/**
 * Groups words into cues, breaking at punctuation rather than every third word.
 *
 * Blind `slice(i, i+3)` is why real renders read "slower, because the" and
 * "and never look" — a cue that ends mid-clause makes the viewer hold an
 * unfinished phrase across a hard cut. Ending a cue on the word that carries the
 * punctuation costs nothing and lines the cues up with the pauses in the speech.
 *
 * Exported so the test can assert the grouping without going through a render.
 */
export const groupWords = (words: string[], maxPerBlock = MAX_WORDS_PER_BLOCK): string[][] => {
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const word of words) {
    current.push(word);
    // Break on a clause boundary, or when the cue is full.
    if (current.length >= maxPerBlock || /[.,!?;:—]$/.test(word)) {
      blocks.push(current);
      current = [];
    }
  }
  if (current.length) blocks.push(current);
  // A single trailing word flashing alone reads as a dropped word. Fold it into
  // the previous cue if that cue has room; otherwise borrow one word back from
  // it, so "a b c | d" becomes "a b | c d" rather than leaving an orphan.
  const last = blocks[blocks.length - 1];
  const prev = blocks[blocks.length - 2];
  if (blocks.length > 1 && last.length === 1) {
    if (prev.length < maxPerBlock) {
      prev.push(last[0]);
      blocks.pop();
    } else if (prev.length > 1) {
      last.unshift(prev.pop() as string);
    }
  }
  return blocks;
};

export const generateCaptions = async (scene: any, audioPath: string, mode: string): Promise<{ words: WordTimestamp[], chunks: CaptionChunk[] }> => {
  const text = scene.narration_text || "";
  const words = text.split(' ').filter((w: string) => w.trim());
  if (words.length === 0) return { words: [], chunks: [] };

  // Timings come from wordTimings() rather than being re-derived here. The old
  // code divided the speech window by BLOCK count, so every cue got an equal
  // slice regardless of how many words it held — a one-word cue and a three-word
  // cue were held exactly as long. Now a cue spans its own words, so cue length
  // tracks how long those words actually take to say, and the captions cannot
  // drift apart from the kinetic overlay, which reads the same function.
  const timings = wordTimings(text, scene);
  const { start: speechStart, span } = speechWindow(scene);

  const chunks: CaptionChunk[] = [];
  let cursor = 0;
  for (const block of groupWords(words)) {
    const first = timings[cursor];
    const last = timings[cursor + block.length - 1];
    cursor += block.length;
    const colorTag = '{\\c&H00FFFFFF&}';
    chunks.push({
      words: block,
      text: `${colorTag}${block.join(' ')}`,
      start: first ? first.start : speechStart,
      end: last ? last.end : speechStart + span,
    });
  }

  return { words: timings, chunks };
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

  const chunks: CaptionChunk[] = blocks.map((blockText, i) => {
    const colorTag = '{\\c&H00FFFFFF&}';
    return {
      words: blockText.split(' '),
      text: `${colorTag}${blockText}`,
      start: speechStart + i * blockDuration,
      end: speechStart + (i + 1) * blockDuration,
    };
  });

  return { words: wordTimings(text, { ...scene, duration_actual: scene.duration_target || 5 }), chunks };
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
