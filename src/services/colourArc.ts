/**
 * Where a scene sits in its episode, as a number the grade can ride.
 *
 * The colour grade is decided per scene from that scene's own detected emotion, in
 * isolation — see EMOTION_PALETTES in metro_engine_v4.py. Nine scenes graded that way have
 * no direction between them: an episode that opens and closes on the same detected emotion
 * opens and closes on the same picture, and whatever variety it has is an accident of what
 * each line happened to say.
 *
 * This is the one number that crosses into the engine to fix that. The curve itself lives
 * in Python, next to the pixels it moves (apply_colour_arc); all that has to agree across
 * the boundary is "how far through the episode is this", which is what this returns.
 *
 * It is also part of the clip's cache key, for the same reason the Cinematic Effect and the
 * overlay already are: it changes the frames and no timestamp comparison can see it.
 */

/** No arc — a one-scene render, or a caller that has not said where it is. */
export const NO_ARC = -1;

/**
 * 0 at the open, 1 at the close, linear in scene order.
 *
 * Scene order rather than elapsed time on purpose: the arc is an editorial progression
 * through the beats, not a clock. Two scenes of very different length are still one step
 * apart in the story, and a long escalation beat should not eat half the drift.
 */
export function arcPosition(index: number, count: number): number {
  if (!Number.isFinite(index) || !Number.isFinite(count)) return NO_ARC;
  if (index < 0 || count < 2) return NO_ARC;
  return Math.min(1, Math.max(0, index / (count - 1)));
}

/** The arc as it appears in a clip's cache key — two decimals is finer than the eye. */
export function arcKey(pos: number): string {
  return pos < 0 ? '' : `a${Math.round(pos * 100)}`;
}
