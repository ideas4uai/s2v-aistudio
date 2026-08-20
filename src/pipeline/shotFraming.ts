/**
 * Makes consecutive shots look different from each other, without changing what is in them.
 *
 * The measured problem: at a stricter scene-detection threshold only 67% of this
 * pipeline's cuts were separable, against 100% for the reference uploads. The cause is not
 * the cut — it is that two adjacent AI-generated stills of the same subject, generated from
 * two prompts that differ only in wording, come back framed almost identically. A detector
 * cannot see a cut there and neither can an eye: the video reads as one long shot with the
 * picture twitching.
 *
 * StoryboardAgent already cycles a SHOT TYPE line through its expansion prompt, and that is
 * where this idea belongs — except that line only reaches scenes that agent wrote. Scenes
 * that came from the fast path, from generateScenes, from an editor edit, or from an older
 * project never had one, and the line is a suggestion inside a long prompt that the image
 * model frequently ignores. This runs later, on the finished image prompt itself, on the one
 * code path every scene passes through.
 *
 * ── What it changes, and what it must not ────────────────────────────────────────────
 *
 * Framing only: shot distance, camera height, and where the subject sits in the frame. It
 * appends a clause and never edits, reorders or removes a word of the prompt it is given,
 * so the subject, the character description, the locked art style and the region context
 * that earlier work fought to keep are all still there, untouched, in front of it. The test
 * asserts the original prompt is a literal prefix of the result.
 *
 * That distinction is the whole point: consecutive shots of the SAME subject from different
 * distances is what an edit looks like. Consecutive shots of different subjects is what a
 * broken edit looks like.
 */

/**
 * The cycle. Adjacent entries differ on shot distance first, because that is the axis a
 * scene detector measures and the one an eye reads fastest; angle and placement vary
 * underneath it so two shots four apart are not identical either.
 *
 * Five entries against the more usual three: with an even-length cycle every other scene
 * repeats a framing, and a 6-8 scene episode would land the same two shots three times.
 */
const FRAMINGS: string[] = [
  'wide establishing shot, subject small in frame, eye-level camera',
  'tight close-up, subject filling the frame, slightly low camera angle',
  'medium shot from the waist up, subject off-centre, eye-level camera',
  'extreme close-up detail of one part of the subject, shallow depth of field',
  // Medium-wide rather than wide, so the cycle's wrap-around does not put two wide shots
  // next to each other — the last entry sits beside the first as often as beside the
  // fourth, and adjacency has to hold across the seam or every fifth cut goes soft.
  'medium-wide shot from a high angle looking down, subject in the lower third',
];

/**
 * Words that mean the prompt has already decided its framing.
 *
 * When the script asked for a specific shot — "extreme close-up of the cursor blinking" —
 * that is an editorial decision from the beat itself, and overruling it with a positional
 * cycle would be this file deciding it knows better than the writing. Restraint here is the
 * same principle the overlay planner and the effects layer both follow: fire where it adds
 * something, stay out of the way where the content already spoke.
 */
const ALREADY_FRAMED =
  /\b(wide|close[- ]?up|closeup|medium shot|extreme close|macro|aerial|overhead|bird'?s[- ]eye|worm'?s[- ]eye|over[- ](the[- ])?shoulder|establishing|full[- ]body|portrait shot|low[- ]angle|high[- ]angle)\b/i;

/** True when this prompt states its own framing and should be left alone. */
export const hasOwnFraming = (prompt: string): boolean => ALREADY_FRAMED.test(String(prompt || ''));

/**
 * The framing clause for a scene at `index`, or '' when the prompt already has one.
 *
 * Deterministic in the index, so the same scene gets the same framing on every render —
 * a re-render must not reshuffle the edit, and the clip cache key would otherwise change
 * for no reason.
 */
export function framingFor(prompt: string, index: number): string {
  if (!String(prompt || '').trim()) return '';
  if (hasOwnFraming(prompt)) return '';
  return FRAMINGS[((index % FRAMINGS.length) + FRAMINGS.length) % FRAMINGS.length];
}

/**
 * The prompt with a framing clause appended, or unchanged.
 *
 * Appended, never substituted: everything the prompt already said survives verbatim.
 */
export function applyShotFraming(prompt: string, index: number): string {
  const framing = framingFor(prompt, index);
  if (!framing) return prompt;
  const base = String(prompt).trimEnd().replace(/[.,;]+$/, '');
  return `${base}, ${framing}`;
}

/**
 * How different two scenes' framings are, 0-2. Used by the test to assert that neighbours
 * never share a shot distance, which is the property the cut-detection gap needs.
 */
export function framingDistance(a: number, b: number): number {
  const n = FRAMINGS.length;
  const d = Math.abs((a % n) - (b % n));
  return Math.min(d, n - d);
}

/** Exported for the test, so the cycle's length is asserted rather than assumed. */
export const FRAMING_COUNT = FRAMINGS.length;
