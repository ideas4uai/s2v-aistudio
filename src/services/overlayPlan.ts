import { extractFigure } from '../pipeline/agents/scriptPrompt.js';
import { detectSteps, detectComparison, detectName, countUpParts } from './overlayTreatments.js';
import { wordTimings } from './captionService.js';

/**
 * Decides which scenes get a motion-graphics overlay, and what it says.
 *
 * The point of this file is that the answer is "not many". Kinetic text on every beat
 * is wallpaper — it stops meaning emphasis the moment it stops being rare. So the plan
 * is deliberately sparse: the payload beat, a beat that actually states a figure, and
 * the closing payoff. Everything else renders exactly as it does today.
 *
 * Beat position comes from scene order, NOT from `scene_type`. That field looks like it
 * carries the beat and does not: storyboardAgent.ts:277 documents it as the render
 * vocabulary (bedroom|street|grid|corridor|black) that Metro V4 picks transitions and
 * particles from, and a previous fix deliberately stopped narrative 'hook'/'build'/'cta'
 * being written there because it clobbered the user's pick. Reading it here would revive
 * that collision, and on a real rendered project it is 'default' on every scene anyway.
 *
 * Timings come from wordTimings(), the same per-word division the burned-in captions
 * use, anchored on the measured speech span. An overlay word therefore appears when
 * the caption carrying that word appears — by construction, not by coincidence.
 */

export type OverlayKind =
  | 'kinetic' | 'stat' | 'payoff' | 'diagram' | 'comparison' | 'namecard';

export interface OverlayWord {
  text: string;
  start: number;
  end: number;
}

export interface OverlaySpec {
  kind: OverlayKind;
  /** Speech-synced words. For 'stat' this is the label under the figure. */
  words: OverlayWord[];
  /** The figure itself, for 'stat'. */
  figure?: string;
  /** Count-up target and trailing unit, when the figure is a whole number. */
  countUp?: { to: number; suffix: string };
  /** Ordered nodes for 'diagram', each timed to when it is named. */
  steps?: OverlayWord[];
  /** Exactly two sides for 'comparison': the rejected state, then the kept one. */
  sides?: OverlayWord[];
  /** Lower-third card text for 'namecard'. */
  name?: string;
  descriptor?: string;
  /** A real, safely-licensed brand asset for the named entity, baked into the card. */
  logoPath?: string;
  /** The credit its licence actually requires, or absent when it requires none. */
  credit?: string;
  /** BGR accent, from the universe when it has one. */
  accent?: [number, number, number];
  start: number;
  end: number;
}

/**
 * The generic accent, BGR. Warm amber, matching motion_overlay.py's default.
 */
const DEFAULT_ACCENT: [number, number, number] = [60, 190, 250];

/**
 * A universe's accent colour, if it declares one anywhere the pipeline already stores
 * colour. Same priority idea as resolveArtStyle(): the universe wins, then the
 * project's own palette, then a sensible generic default. Parsing is deliberately
 * narrow — a hex code is unambiguous, and "vibrant and contrasting" is not a colour.
 */
export function universeAccent(project: any): [number, number, number] {
  const sources = [
    project?.universe?.colorPalette, project?.universe?.artStyle,
    project?.settings?.colorPalette, project?.color_palette,
  ];
  for (const src of sources) {
    const hex = /#([0-9a-f]{6})\b/i.exec(String(src || ''));
    if (!hex) continue;
    const n = parseInt(hex[1], 16);
    // BGR: the engine's frames are OpenCV order, not RGB.
    return [n & 255, (n >> 8) & 255, (n >> 16) & 255];
  }
  return DEFAULT_ACCENT;
}

/**
 * How much each treatment is worth when two land next to each other. A diagram shows
 * something the narration cannot; kinetic text restates words the captions already
 * carry. When only one can survive, that ordering is the answer.
 */
const WEIGHT: Record<OverlayKind, number> = {
  payoff: 6, diagram: 5, comparison: 4, stat: 3, namecard: 2, kinetic: 1,
};

/**
 * The kinds that put the narration's own words on screen verbatim.
 *
 * These are the ones that collide with the burned-in captions, because both are
 * drawing the same sentence at the same instant from the same wordTimings() call —
 * by construction, as the header above says. On a real render the closing beat
 * showed the payoff overlay reading "of faster, more reliable test automation,
 * accelerating your delivery." across the middle of the frame while the caption
 * underneath read the same words three at a time, and in the final frames the two
 * blocks overlapped.
 *
 * The other four are exempt on purpose: a diagram, a comparison, a stat figure and
 * a namecard all show something *derived* — steps, sides, a number, a title — which
 * the captions do not carry, so both can coexist and neither is a duplicate.
 */
export const OVERLAY_RESTATES_NARRATION: ReadonlySet<OverlayKind> = new Set<OverlayKind>(['kinetic', 'payoff']);

/** Kinetic text is a phrase, not a paragraph — past this it stops reading as a graphic. */
const MAX_KINETIC_WORDS = 7;
const MAX_PAYOFF_WORDS = 9;
const MAX_STAT_LABEL_WORDS = 4;

const sentences = (text: string): string[] =>
  (String(text || '').match(/[^.!?]+[.!?]*/g) ?? []).map((s) => s.trim()).filter(Boolean);

/**
 * Longest a line can be and still read as something worth revealing word by word.
 *
 * Measured over the closing beat of all 44 real renders on disk: median 8 words, 75th
 * percentile 13, and then nothing at all until 17. That gap is where a payoff stops and
 * an explanation starts — "What groundbreaking features will you ship next?" on one side,
 * "The tradeoff is that every write must also update the index, so more indexes make
 * reads faster and writes slower" on the other. 14 keeps the whole observed payoff
 * population and drops the tail.
 */
const MAX_REVEAL_WORDS = 14;

/** A line the overlay font cannot draw. Devanagari and Telugu narration came out `?????`. */
const isRenderable = (text: string): boolean => {
  const letters = (String(text).match(/\p{L}/gu) ?? []).length;
  if (!letters) return false;
  return (String(text).match(/[A-Za-z]/g) ?? []).length / letters >= 0.5;
};

/** `RAJ: ...` — a character speaking, not narration making a point. */
const isDialogue = (text: string): boolean => /^[A-Z][A-Z' ]{1,20}:/.test(String(text).trim());

/**
 * Whether a beat earns the word-by-word reveal — the one treatment that was chosen by
 * position alone rather than by what the beat says.
 *
 * Measured across 251 real narrated scenes, 64 of the 95 treatments came from the two
 * positional rules and only 31 from content. Among the 44 payoffs that produced: two
 * were non-Latin narration the font drew as question marks, five were character dialogue
 * with a speaker prefix, and eight were long explanatory sentences that got shown as a
 * nine-word tail fragment revealed one word at a time. None of those is emphasis.
 *
 * The other treatments are left alone: a diagram, a comparison, a figure and a name are
 * each already conditional on the beat actually containing one.
 */
function deservesWordReveal(text: string): boolean {
  const full = String(text || '').trim();
  if (!full || !isRenderable(full) || isDialogue(full)) return false;
  const all = sentences(full);
  const line = all.length ? all[all.length - 1] : full;
  const words = line.split(/\s+/).filter(Boolean).length;
  return words >= 2 && words <= MAX_REVEAL_WORDS;
}

/**
 * Which kind each scene would take on its own merits, before any spacing rule.
 *
 * Beats are counted over the scenes that actually speak. An episode can end on a silent
 * visual beat — the serialized-universe tease appends one — and the closing line belongs
 * on the last scene with words, not on the wordless one after it.
 *
 * The payload is the second spoken beat. The Script Agent is instructed to front-load it
 * ("the most surprising or most useful thing you have goes in the first quarter of the
 * runtime"): the first beat states the problem, and the one after it is where the subject
 * is named and the claim lands.
 */
function candidateKinds(scenes: any[], topic = ''): (OverlayKind | null)[] {
  const spoken = scenes
    .map((s, i) => ({ i, text: String(s?.narration_text || '').trim() }))
    .filter((s) => s.text);
  if (!spoken.length) return scenes.map(() => null);

  const closing = spoken[spoken.length - 1].i;
  const payload = spoken.length >= 3 ? spoken[1].i : -1;

  // A tool is introduced once. Naming it again in beat four is the script repeating
  // itself, not a second introduction, so only the first beat that names it can card.
  let named = false;

  return scenes.map((s, i) => {
    const text = String(s?.narration_text || '').trim();
    if (!text) return null;
    // Order is precedence. A beat that walks through steps AND states a figure is a
    // process beat: the diagram is what the viewer cannot get from the narration alone.
    // Position says WHERE a reveal could go; the beat itself says whether it should.
    // Both word-reveal kinds now ask, and a closing beat that does not earn one falls
    // through to the content checks below rather than taking the treatment by default.
    if (i === closing && deservesWordReveal(text)) return 'payoff';
    if (detectSteps(text)) return 'diagram';
    if (detectComparison(text)) return 'comparison';
    if (extractFigure(text)) return 'stat';
    if (!named && detectName(text, topic)) { named = true; return 'namecard'; }
    return i === payload && deservesWordReveal(text) ? 'kinetic' : null;
  });
}

/**
 * The overlay for one scene, or null if it gets none.
 *
 * @param clipDuration Length of the rendered clip — narration plus the target-length
 *   hold. The payoff runs to the end of it on purpose; see below.
 */
export function planOverlay(scene: any, project: any, clipDuration: number): OverlaySpec | null {
  const scenes: any[] = project?.scenes || [];
  const index = scenes.findIndex((s) => s?.scene_id === scene?.scene_id);
  if (index < 0) return null;

  const kinds = candidateKinds(scenes, String(project?.topic || ''));
  // Never two in a row — now across the whole treatment set, not just the original two
  // kinds. Back-to-back overlays read as a style rather than emphasis, and that is the
  // difference between a call-out and decoration. The payoff is exempt: it is the last
  // beat and there is nothing after it to crowd.
  //
  // When two do collide the heavier one survives, rather than whichever happened to be
  // earlier. The first version dropped the later beat unconditionally, which meant a
  // real process diagram was silently deleted because the beat before it had picked up
  // kinetic text by position — the least informative treatment starving the most
  // informative one.
  for (let i = 1; i < kinds.length; i++) {
    const here = kinds[i];
    const prev = kinds[i - 1];
    if (!here || !prev || here === 'payoff') continue;
    if (WEIGHT[here] > WEIGHT[prev]) kinds[i - 1] = null;
    else kinds[i] = null;
  }
  const kind = kinds[index];
  if (!kind) return null;

  const text = String(scene.narration_text || '');
  const words = wordTimings(text, scene);
  if (!words.length) return null;
  const accent = universeAccent(project);

  const pick = (from: number, count: number): OverlayWord[] =>
    words.slice(from, from + count).map((w) => ({ text: w.word, start: w.start, end: w.end }));
  /** A label the script named, timed to the word that named it. */
  const at = (label: string, wordIndex: number, hold: number): OverlayWord => {
    const w = words[Math.min(wordIndex, words.length - 1)];
    return { text: label, start: w.start, end: Math.min(clipDuration, w.start + hold) };
  };

  if (kind === 'diagram') {
    const steps = detectSteps(text)!.map((s) => at(s.label, s.wordIndex, 2.4));
    return {
      kind, accent, words: [], steps,
      start: steps[0].start,
      // Holds past the last node so the finished diagram is readable as a whole, which
      // is the only moment it says anything a caption could not.
      end: Math.min(clipDuration, steps[steps.length - 1].start + 2.6),
    };
  }

  if (kind === 'comparison') {
    const c = detectComparison(text)!;
    const sides = [at(c.before, c.beforeIndex, 2.0), at(c.after, c.afterIndex, 2.0)];
    return {
      kind, accent, words: [], sides,
      start: sides[0].start,
      end: Math.min(clipDuration, sides[1].start + 2.4),
    };
  }

  if (kind === 'namecard') {
    const n = detectName(text, String(project?.topic || ''))!;
    const start = words[Math.min(n.wordIndex, words.length - 1)].start;
    // The sourced brand asset, if one was found for this same entity. It is resolved
    // once per project before the render loop (resolveEntityImage), so this stays a
    // synchronous read: planOverlay is called for a scene's neighbours as well as
    // itself, and a network call in here would fire several times per scene.
    const sourced = project?.entity_image?.image;
    const logo = sourced && sourced.entity === n.name ? sourced : null;
    return {
      kind, accent, words: [], name: n.name,
      descriptor: String(project?.universe?.title || '').trim() || undefined,
      logoPath: logo?.localPath || undefined,
      // Empty string means "licence requires no credit" — the overlay draws nothing.
      credit: logo ? (logo.credit || undefined) : undefined,
      start,
      // A card carrying a logo and a credit line is worth a moment longer than one
      // carrying a word; the credit has to be readable if a viewer looks for it.
      end: Math.min(clipDuration, start + (logo ? 3.4 : 2.8)),
    };
  }

  if (kind === 'stat') {
    const figure = extractFigure(text);
    // Anchor on the word that actually carries the number, so the figure lands when it
    // is spoken rather than at some fixed offset into the scene.
    const idx = words.findIndex((w) => w.word.includes(figure.split(/\s+/)[0]));
    const from = idx >= 0 ? idx : 0;
    const label = pick(from + 1, MAX_STAT_LABEL_WORDS);
    const start = words[from].start;
    return {
      kind, figure, accent, words: label,
      countUp: countUpParts(text) || undefined,
      start,
      // Long enough to read a number and its label; never past the clip.
      end: Math.min(clipDuration, Math.max(start + 1.8, label.length ? label[label.length - 1].end : start + 1.8)),
    };
  }

  if (kind === 'payoff') {
    const all = sentences(text);
    const closing = all.length ? all[all.length - 1] : text;
    const from = Math.max(0, words.length - closing.split(/\s+/).filter(Boolean).length);
    const shown = pick(from, MAX_PAYOFF_WORDS).length >= MAX_PAYOFF_WORDS
      ? pick(words.length - MAX_PAYOFF_WORDS, MAX_PAYOFF_WORDS)
      : pick(from, MAX_PAYOFF_WORDS);
    if (!shown.length) return null;
    // Runs to the end of the clip, not to the end of the words. The last scene holds
    // still through pad_seconds of deliberate silence — that tail currently shows
    // nothing at all, and it is exactly where a closing question wants to sit.
    return { kind, words: shown, start: shown[0].start, end: clipDuration };
  }

  const opening = sentences(text)[0] || text;
  const shown = pick(0, Math.min(MAX_KINETIC_WORDS, opening.split(/\s+/).filter(Boolean).length));
  if (shown.length < 2) return null;
  return { kind, words: shown, start: shown[0].start, end: shown[shown.length - 1].end + 0.6 };
}

/**
 * Short stable fingerprint of a scene's overlay, for the clip filename.
 *
 * The overlay is not a file, so a timestamp comparison cannot see it change — the same
 * reason the Cinematic Effect is already part of visualClipPath. Putting it in the name
 * keeps each scene's cache independent: editing one scene's narration changes only that
 * scene's key, so every other scene's clip is still a hit.
 */
export function overlayKey(spec: OverlaySpec | null): string {
  if (!spec) return '';
  // Every field that reaches the screen. The first version hashed only `words`, which
  // is empty for the structured treatments — so a diagram whose node labels had been
  // rewritten produced the same key and was served from cache with the old labels.
  const parts = (list?: OverlayWord[]) =>
    (list ?? []).map((w) => `${w.text}@${w.start.toFixed(2)}`).join(' ');
  const shape = [
    spec.kind, spec.figure || '', spec.name || '', spec.descriptor || '',
    // The logo and its credit are both burned into the clip, and neither is a file the
    // freshness check compares — swapping in a differently-licensed asset changes what
    // the frame says, so it has to change the name too.
    spec.logoPath || '', spec.credit || '',
    spec.countUp ? `${spec.countUp.to}${spec.countUp.suffix}` : '',
    parts(spec.words), parts(spec.steps), parts(spec.sides),
    (spec.accent || []).join(','),
    spec.start.toFixed(2), spec.end.toFixed(2),
  ].join('|');
  let h = 0;
  for (let i = 0; i < shape.length; i++) h = (Math.imul(31, h) + shape.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Treatments heavy enough that the cut out of them wants to be felt. */
const HEAVY: OverlayKind[] = ['diagram', 'comparison', 'stat', 'namecard'];

/**
 * The transition between two consecutive beats, or '' to leave the engine's own
 * scene-type table alone.
 *
 * This is how the two new transitions are selected: not as a dropdown the operator has
 * to think about per scene, but as a consequence of what the beats are doing. A
 * comparison beat is entered through a shape wipe because a shape sweeping the frame
 * is the visual grammar of "here is a different state"; a beat that just landed a
 * diagram or a figure exits on a whip-flash because a hard cut off a made point reads
 * as punctuation. Everything else keeps the transition it has today.
 *
 * Both sides of one cut must agree or the concat seam shows, so this is computed from
 * the pair, and the caller sets clip N's out-kind and clip N+1's in-kind from the same
 * call. The engine asserts nothing about that; the symmetry is this function's job.
 */
export function transitionBetween(from: OverlaySpec | null, to: OverlaySpec | null): string {
  if (to?.kind === 'comparison') return 'shape_wipe';
  if (from && HEAVY.includes(from.kind)) return 'whip_flash';
  return '';
}

/** BGR accent as the engine's --transition_color expects it. */
export const transitionColor = (project: any): string => universeAccent(project).join(',');

/**
 * Everything about a scene's clip that is not a file: its overlay, and the transitions
 * on either side. All of it belongs in the clip's name for the same reason the
 * Cinematic Effect already is — a timestamp comparison cannot see any of it change.
 */
export function sceneVisualKey(scene: any, project: any, clipDuration: number): string {
  const scenes: any[] = project?.scenes || [];
  const i = scenes.findIndex((s) => s?.scene_id === scene?.scene_id);
  if (i < 0) return '';
  const spec = planOverlay(scene, project, clipDuration);
  const at = (j: number) => (scenes[j] ? planOverlay(scenes[j], project, clipDuration) : null);
  const tr = [transitionBetween(at(i - 1), spec), transitionBetween(spec, at(i + 1))]
    .filter(Boolean).join('');
  const key = overlayKey(spec);
  if (!key && !tr) return '';
  return `${key}${tr ? `t${tr.replace(/[^a-z]/g, '').slice(0, 6)}` : ''}`;
}
