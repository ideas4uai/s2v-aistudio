/**
 * Bounds for a target length. Both come off what the rest of the pipeline was
 * already built to handle, not from taste:
 *
 * - 5s floor: at ~2.5 words/sec that is twelve words, which is one hook and
 *   nothing else. Under it there is no script left to pace.
 * - 600s ceiling: DirectorAgent's scene-count guidance tops out at 10m, and one
 *   image plus one TTS call per scene means past that a single render outlives
 *   the sitting that started it.
 */
export const MIN_TARGET_SECONDS = 5;
export const MAX_TARGET_SECONDS = 600;

/**
 * Spoken words per second. 2.5 was already the figure three call sites had each
 * hardcoded; it lives here now so the script prompt, the padding plan and the UI
 * word-count hint cannot drift apart.
 *
 * Not to be confused with Kokoro's ~1.18x realtime, which is how fast the
 * synthesiser produces audio, not how fast the audio speaks.
 */
export const WORDS_PER_SECOND = 2.5;

/** Words a `seconds`-long narration needs at the rate above. */
export const targetWordCount = (seconds: number): number => Math.round(seconds * WORDS_PER_SECOND);

/**
 * The inverse: how long a written line actually takes to say.
 *
 * Every scene constructor used to write `duration_target: s.duration || 5`, and
 * the scriptwriter does not emit a duration, so every scene in every
 * pipeline-created project asked for exactly 5 seconds no matter what was
 * written in it. Narration then ran 6-9.7s and overran uniformly, which is what
 * turned the edit metronomic: measured shot-length stdev of 0.48s on a 6.18s
 * mean, against 1.44s on 3.76s for the video that shipped to YouTube.
 *
 * Deriving the target from the words that were actually written makes the
 * target honest, so a short beat stays short instead of being held to five
 * seconds. Rounded to a quarter-second: the renderer works in frames, and a
 * target carrying six decimals only pretends to a precision TTS does not have.
 */
export const secondsForWords = (words: number): number => {
  const secs = Math.max(words, 0) / WORDS_PER_SECOND;
  return Math.max(1, Math.round(secs * 4) / 4);
};

/** Words in a narration line, the way every caller was counting them inline. */
export const countWords = (text: unknown): number =>
  String(text ?? '').trim().split(/\s+/).filter(Boolean).length;

/**
 * How many scenes a `seconds`-long video should be cut into.
 *
 * Replaces the preset lookup table DirectorAgent carried, which had nothing to
 * say about a length that was not one of its five keys. The two rates are the
 * shape that table already had: shorts ran ~7s per scene, long-form ~11s.
 */
export const sceneCountRange = (seconds: number): [number, number] => {
  const perScene = seconds <= 60 ? 7 : 11;
  return [
    Math.max(2, Math.round(seconds / (perScene * 1.2))),
    Math.max(3, Math.round(seconds / (perScene * 0.85))),
  ];
};

// Parses a targetLength setting into seconds. Accepts '30s', '60s', '3m',
// '5m', '10m', bare numbers ('300' or 300 = seconds) — scales linearly for
// any length instead of silently falling back to 60s for unknown values.
//
// The clamp is the single gate every consumer passes through (orchestrator,
// DirectorAgent, the script prompt), so an out-of-range value saved by an older
// client or a hand-edited project file renders something sane rather than
// planning a 60-scene episode nobody asked for.
export const targetLengthSeconds = (t: unknown): number => {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m)?$/.exec(String(t ?? '').trim());
  if (!m) return 60;
  const secs = parseFloat(m[1]) * (m[2] === 'm' ? 60 : 1);
  return Math.min(Math.max(secs, MIN_TARGET_SECONDS), MAX_TARGET_SECONDS);
};

// Landing within ±15% of the requested length counts as on target — no point
// holding a still for a second nobody asked for.
export const TARGET_TOLERANCE = 0.15;
// A scene may never be held longer than 1.5x its narration: past that the extra
// still time stops reading as a beat and starts reading as dead air.
export const MAX_PAD_FACTOR = 1.5;

export interface PaddingPlan {
  /** Per-scene durations after padding. Never shorter than the narration. */
  durations: number[];
  /** Sum of `durations`. */
  total: number;
  /** False when the per-scene cap left us short of the target — a content problem. */
  reachedTarget: boolean;
  /** Longest total the cap allows for this much narration. */
  maxAchievable: number;
}

/**
 * Plans extra still time so the video lands near `targetSeconds`. Padding only —
 * narration is never trimmed and silence is never injected past the cap. Every
 * scene is padded by the same factor, so longer scenes absorb proportionally
 * more of the hold.
 */
export const planScenePadding = (
  narrationDurations: number[],
  targetSeconds: number,
  maxPadFactor: number = MAX_PAD_FACTOR
): PaddingPlan => {
  const actual = narrationDurations.reduce((sum, d) => sum + d, 0);
  const maxAchievable = actual * maxPadFactor;
  const floor = targetSeconds * (1 - TARGET_TOLERANCE);
  // Nothing to pad, or already inside tolerance / over target: leave it alone.
  if (actual <= 0 || actual >= floor) {
    return { durations: [...narrationDurations], total: actual, reachedTarget: actual > 0, maxAchievable };
  }
  const factor = Math.min(targetSeconds / actual, maxPadFactor);
  return {
    durations: narrationDurations.map(d => d * factor),
    total: actual * factor,
    reachedTarget: actual * factor >= floor,
    maxAchievable,
  };
};
