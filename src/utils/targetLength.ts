// Parses a targetLength setting into seconds. Accepts '30s', '60s', '3m',
// '5m', '10m', bare numbers ('300' or 300 = seconds) — scales linearly for
// any length instead of silently falling back to 60s for unknown values.
export const targetLengthSeconds = (t: unknown): number => {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m)?$/.exec(String(t ?? '').trim());
  return m ? parseFloat(m[1]) * (m[2] === 'm' ? 60 : 1) : 60;
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
