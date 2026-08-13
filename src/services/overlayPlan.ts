import { extractFigure } from '../pipeline/agents/scriptPrompt.js';
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

export type OverlayKind = 'kinetic' | 'stat' | 'payoff';

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
  start: number;
  end: number;
}

/** Kinetic text is a phrase, not a paragraph — past this it stops reading as a graphic. */
const MAX_KINETIC_WORDS = 7;
const MAX_PAYOFF_WORDS = 9;
const MAX_STAT_LABEL_WORDS = 4;

const sentences = (text: string): string[] =>
  (String(text || '').match(/[^.!?]+[.!?]*/g) ?? []).map((s) => s.trim()).filter(Boolean);

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
function candidateKinds(scenes: any[]): (OverlayKind | null)[] {
  const spoken = scenes
    .map((s, i) => ({ i, text: String(s?.narration_text || '').trim() }))
    .filter((s) => s.text);
  if (!spoken.length) return scenes.map(() => null);

  const closing = spoken[spoken.length - 1].i;
  const payload = spoken.length >= 3 ? spoken[1].i : -1;

  return scenes.map((s, i) => {
    if (!String(s?.narration_text || '').trim()) return null;
    if (i === closing) return 'payoff';
    if (extractFigure(s.narration_text)) return 'stat';
    return i === payload ? 'kinetic' : null;
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

  const kinds = candidateKinds(scenes);
  // Never two in a row. Back-to-back overlays read as a style rather than emphasis,
  // and this is the whole difference between a call-out and decoration.
  for (let i = 1; i < kinds.length; i++) {
    if (kinds[i] && kinds[i - 1] && kinds[i] !== 'payoff') kinds[i] = null;
  }
  const kind = kinds[index];
  if (!kind) return null;

  const text = String(scene.narration_text || '');
  const words = wordTimings(text, scene);
  if (!words.length) return null;

  const pick = (from: number, count: number): OverlayWord[] =>
    words.slice(from, from + count).map((w) => ({ text: w.word, start: w.start, end: w.end }));

  if (kind === 'stat') {
    const figure = extractFigure(text);
    // Anchor on the word that actually carries the number, so the figure lands when it
    // is spoken rather than at some fixed offset into the scene.
    const at = words.findIndex((w) => w.word.includes(figure.split(/\s+/)[0]));
    const from = at >= 0 ? at : 0;
    const label = pick(from + 1, MAX_STAT_LABEL_WORDS);
    const start = words[from].start;
    return {
      kind, figure, words: label,
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
  const shape = [
    spec.kind, spec.figure || '',
    spec.words.map((w) => w.text).join(' '),
    spec.start.toFixed(2), spec.end.toFixed(2),
  ].join('|');
  let h = 0;
  for (let i = 0; i < shape.length; i++) h = (Math.imul(31, h) + shape.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
