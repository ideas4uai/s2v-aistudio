/**
 * The one canonical set of language codes, and the only place a language value is
 * interpreted.
 *
 * ── Why this file exists ───────────────────────────────────────────────────────
 * `settings.language` had two writers disagreeing about what it holds. CreateProject
 * wrote ISO codes ('en', 'te', 'hi'); ProjectEditor wrote display names ('English',
 * 'Telugu', 'Hindi'). Nothing broke only because the one reader — the TTS voice
 * router — lowercased the value and then had a fallthrough that happened to catch
 * both shapes. A third writer, or a reader without that fallthrough, silently gets a
 * language it does not recognise, and the failure mode for a wrong language is not an
 * error: it is a finished video nobody can understand.
 *
 * So: the stored value is a CODE, both dropdowns write codes, and anything that needs
 * a name for a prompt asks languageName(). Existing projects on disk hold display
 * names, so normalizeLanguage reads both shapes forever — migration by reading, not
 * by rewriting records.
 */

/** Supported languages, code -> the name a prompt should use for them. */
export const LANGUAGES = {
  en: 'English',
  te: 'Telugu',
  hi: 'Hindi',
} as const;

export type LanguageCode = keyof typeof LANGUAGES;

/** What a project gets when nothing was chosen. */
export const DEFAULT_LANGUAGE: LanguageCode = 'en';

const BY_NAME = new Map<string, LanguageCode>(
  Object.entries(LANGUAGES).map(([code, name]) => [name.toLowerCase(), code as LanguageCode]),
);

/**
 * The code this value names, or null when it names no supported language.
 *
 * Null rather than a default on purpose: a caller that wants a fallback says so, and a
 * caller that must fail loudly on an unoffered language (the voice router, which
 * throws for Spanish rather than quietly substituting English) can still tell the
 * difference between "unset" and "not one of ours".
 */
export function normalizeLanguage(value?: string | null): LanguageCode | null {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (raw in LANGUAGES) return raw as LanguageCode;
  // 'te-IN' and 'en_US' are the shapes a browser or an OAuth profile hands over.
  const base = raw.split(/[-_]/)[0];
  if (base in LANGUAGES) return base as LanguageCode;
  return BY_NAME.get(raw) ?? null;
}

/** Display name for a prompt ('Telugu'), or '' when the value names no supported language. */
export function languageName(value?: string | null): string {
  const code = normalizeLanguage(value);
  return code ? LANGUAGES[code] : '';
}

/** Every code, for building a dropdown without restating the list. */
export const LANGUAGE_OPTIONS: Array<{ code: LanguageCode; name: string; native: string }> = [
  { code: 'en', name: 'English', native: 'English' },
  { code: 'te', name: 'Telugu', native: 'తెలుగు' },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी' },
];

/**
 * Whether this language is written in a script the caption overlay can draw.
 *
 * The overlay font renders Devanagari and Telugu as '?????', so overlayPlan already
 * drops those lines — see isRenderable there. This says the same thing one stage
 * earlier, where a caller can warn about it instead of silently shipping a video with
 * no captions.
 */
export function hasLatinScript(value?: string | null): boolean {
  return normalizeLanguage(value) === 'en';
}

/**
 * Whether captions should be burned for this project's language.
 *
 * Same question as hasLatinScript with one deliberate difference: an UNSET language
 * means the default, not "unsupported". Most projects on disk never set the field, and
 * reading that as "no captions" silently stripped captions from every one of them --
 * caught by the segment-reuse tests, which is exactly the kind of quiet removal this
 * whole area is supposed to prevent.
 */
export function captionsSupported(value?: string | null): boolean {
  return hasLatinScript(normalizeLanguage(value) ?? DEFAULT_LANGUAGE);
}
