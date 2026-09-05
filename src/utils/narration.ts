/**
 * Keeping internal strings out of what the viewer hears.
 *
 * Three leaks have been found and they are two shapes of the same bug: the
 * pipeline hands the model its own metadata and hands the viewer the model's raw
 * output, and neither boundary marks which strings are content.
 *
 *   - `NAME:` speaker prefixes reached TTS, captions and the kinetic overlay. A
 *     rendered frame showed the caption "RAVI: This staging" and another showed
 *     the overlay "ARJUN: It's just a routine refresh for".
 *   - A project titled "CRAFT1 - Playwright can now heal your broken selectors"
 *     produced the spoken line "CRAFT1 gives Playwright a vital healing touch" —
 *     the model read the internal test label as a product name.
 *   - hookStrategy's slug was interpolated verbatim, and a YouTube upload opens
 *     on the caption "Shocking. Your software" — the word came from the setting,
 *     not from the writer.
 *
 * So: strip structural markers on the way out (stripSpeakerPrefix), and never
 * hand the model a bare internal token on the way in (stripInternalLabel,
 * hookStrategyBrief).
 */

/** A `NAME:` dialogue prefix at the start of a line. Names are the shape scripts use. */
const SPEAKER_PREFIX = /^[ \t]*["'“]?\s*([A-Z][A-Z0-9 _.'-]{0,23})\s*:\s+/;

/**
 * Removes speaker prefixes from narration before anything speaks or displays it.
 *
 * Runs per line, because a scene may carry more than one. Character attribution
 * is already resolved by detectCharacter() at storyboard time, so nothing
 * downstream still needs the prefix — it is pure formatting that was being read
 * aloud and burned into captions.
 *
 * Deliberately narrow: the name must be upper-case and short, so ordinary prose
 * with a colon ("One rule: never trust the cache") is untouched.
 */
export function stripSpeakerPrefix(text: unknown): string {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(SPEAKER_PREFIX, ''))
    .join('\n')
    .trim();
}

/**
 * Drops a leading internal label from a project title before it becomes a topic.
 *
 * Requires a digit in the label — "CRAFT1 -", "EP12:", "AUDIT-3 —" are clearly
 * identifiers, while "AI - the basics" or "SQL: a primer" are subjects and must
 * survive. That is the line between a naming convention and a real title, and
 * erring toward leaving text alone is right: a stripped subject is worse than a
 * surviving label, which the prompt rule below also guards against.
 */
export function stripInternalLabel(topic: unknown): string {
  const text = String(topic ?? '').trim();
  const stripped = text.replace(/^[A-Za-z][A-Za-z_-]{0,14}\d[A-Za-z0-9_-]*\s*[-–—:]\s+/, '').trim();
  // Never strip away the whole title.
  return stripped || text;
}

/**
 * What a hookStrategy setting should say to the writer.
 *
 * The slug used to be interpolated raw ("Open on a hook of this kind: shocking"),
 * which puts the adjective itself in the model's context as a usable word — and
 * it duly used it. These describe the move instead of naming it, so there is no
 * label to copy.
 */
const HOOK_BRIEFS: Record<string, string> = {
  shocking: 'Open on the single most surprising concrete fact in the material, stated plainly. Let the surprise come from the fact, never from an adjective about it.',
  controversial: 'Open by naming the disagreement — the thing practitioners argue about — and take a side in the first line.',
  curiosity: 'Open on a question the viewer cannot answer yet but wants to, and make sure a later scene answers it.',
  storytelling: 'Open mid-incident, on a specific moment with a person in it, before any explanation.',
  default: '',
};

export function hookStrategyBrief(strategy: unknown): string {
  const key = String(strategy ?? '').trim().toLowerCase();
  if (!key || key === 'default') return '';
  return HOOK_BRIEFS[key] || `Open on a hook that works by being ${key}, without using that word.`;
}

/**
 * A scene that is deliberately silent — an image held for its own beat, with no words.
 *
 * ── Why this needs a name ──────────────────────────────────────────────────────
 * The script prompt has always permitted one: "No scene's narration may be under N
 * words, except at most one wordless reaction beat." The render pipeline did not. The
 * content-integrity check treated any empty narration_text as an unsalvageable scene and
 * halted the whole render, so the pipeline refused the exact thing its own writing
 * instructions asked for.
 *
 * The check itself is right to exist — it stops the renderer quietly rewriting an
 * approved script — and the two cases genuinely look identical field-by-field:
 *
 *   deliberate  a beat of held image, chosen by the writer
 *   accidental  narration that went missing upstream (a failed expansion retry returned
 *               fourteen scenes with `narration: undefined` and was accepted)
 *
 * So they are told apart by SHAPE rather than by the field, which is what the prompt's
 * own rule already implies: a silent beat is a punctuation mark inside a script that
 * speaks. One wordless scene among six is a craft choice. Twelve of fourteen is a
 * script that failed to generate, and halting on that is still correct.
 */
export function isSilentBeat(scene: any): boolean {
  return !String(scene?.narration_text ?? '').trim()
    && !!String(scene?.visuals?.[0]?.prompt ?? '').trim();
}

/**
 * Whether a set of scenes uses silence as punctuation rather than having lost its words.
 *
 * At least one scene must speak, and the silent ones must be the minority. Both halves
 * matter: an all-silent project is a generation failure, and so is one where most beats
 * came back empty.
 */
export function silenceIsDeliberate(scenes: any[]): boolean {
  const list = scenes ?? [];
  const silent = list.filter(isSilentBeat).length;
  const speaking = list.length - silent;
  return silent > 0 && speaking > 0 && silent < speaking;
}
