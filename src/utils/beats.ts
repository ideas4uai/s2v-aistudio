import { countWords } from './targetLength.js';

/**
 * Which narrative beat each scene is, and how long that beat wants to be held.
 *
 * The pipeline has never stored this. `scene_type` looks like it carries the beat and
 * does not — storyboardAgent.ts:277 documents it as the render vocabulary
 * (bedroom|street|grid|corridor|black) that Metro V4 picks transitions and particles
 * from, and a previous fix deliberately stopped narrative 'hook'/'build'/'cta' being
 * written there because it clobbered the operator's pick. `project.storyArc` does carry
 * a five-beat spine, but it is handed to the scriptwriter as a prompt and nothing maps
 * its five slots back onto the N scenes that come out.
 *
 * So the beat is derived here, positionally, from the same two facts the rest of the
 * codebase already relies on:
 *
 *   - The payload is the second spoken beat. That is not a guess: scriptPrompt.ts
 *     instructs "the most surprising or most useful thing you have goes in the first
 *     quarter of the runtime", and overlayPlan.candidateKinds already picks spoken[1]
 *     as the payload on exactly that basis.
 *   - The close is the last SPOKEN beat, not the last scene. An episode can end on a
 *     wordless visual (the serialized-universe tease appends one), and the payoff
 *     belongs on the last scene with words. Same rule candidateKinds uses.
 *
 * 'context' from the storyArc's five slots is deliberately absent: nothing positional
 * separates it from the escalation that follows, and inventing a boundary the script
 * does not mark would be pacing scenes off a fiction. Four beats that are actually
 * determinable beat five that are half made up.
 */
export type Beat = 'hook' | 'payload' | 'escalation' | 'payoff';

/**
 * The beat of every scene, in scene order. A scene with no narration gets null — it is
 * a wordless visual and has no beat to pace.
 */
export function sceneBeats(scenes: any[]): (Beat | null)[] {
  const spoken = (scenes || [])
    .map((s, i) => ({ i, text: String(s?.narration_text || '').trim() }))
    .filter((s) => s.text);
  if (!spoken.length) return (scenes || []).map(() => null);

  const beats = new Map<number, Beat>();
  // Assigned weakest-claim first so the stronger claim overwrites: on a two-scene
  // episode the second scene is the close, not the payload.
  spoken.forEach(({ i }) => beats.set(i, 'escalation'));
  if (spoken.length >= 3) beats.set(spoken[1].i, 'payload');
  beats.set(spoken[0].i, 'hook');
  beats.set(spoken[spoken.length - 1].i, 'payoff');

  return (scenes || []).map((_, i) => beats.get(i) ?? null);
}

/**
 * How much of the episode's hold time each beat is worth, relative to what its word
 * count alone would claim.
 *
 * These are multipliers on a share, not seconds. The share every scene claims today is
 * `target * words / totalWords` — purely how much was written in it. That makes the
 * edit a function of sentence length and nothing else, which is the thing a professional
 * edit is not: a hook is cut tight to get to the point, and a close is held so the point
 * can land, whether or not the two happen to be the same number of words.
 *
 * Applied as a weight and renormalised, so the sum of all shares is still exactly the
 * requested target. This changes how the time is distributed, never how much there is.
 *
 * Spread is deliberately narrow (0.8-1.35). planScenePadding never trims narration, so a
 * weight below 1 can only remove hold time a scene was going to spend on a still, and one
 * above 1 is capped at MAX_PAD_FACTOR anyway — a wider spread would mostly be clipped off
 * at both ends and buy nothing but a warning in the log.
 *
 * ponytail: on a script that under-fills its target, MAX_PAD_FACTOR binds before the
 * payoff weight does — measured on a real nine-scene render at a 110s target, the close
 * asked for 14.8s and the 1.5x dead-air cap allowed 8.2s, so the whole hold was clipped.
 * That is the cap doing its job and it is the right trade: exempting the close would buy
 * the lean back in literal silence. If holding the close ever matters more than that,
 * the upgrade is a longer closing line, not a bigger cap.
 */
export const BEAT_HOLD: Record<Beat, number> = {
  // Open on the front foot. A hook held past its words is the reason a viewer leaves.
  hook: 0.85,
  // The claim lands here. Give it a moment on the still afterwards to be taken in.
  payload: 1.15,
  // Tightening — see the ramp below.
  escalation: 0.95,
  // The close. The one beat where holding still IS the edit; overlayPlan already runs
  // the payoff overlay to the end of the clip for the same reason.
  payoff: 1.35,
};

/**
 * The escalation run tightens as it goes: 0.95 on the first escalation beat down to
 * 0.80 on the last. An escalation whose shots are all the same length is not escalating,
 * it is a list. One beat on its own takes the top of the ramp rather than the bottom —
 * there is nothing for it to be accelerating away from.
 */
const ESCALATION_FLOOR = 0.80;

/**
 * Per-scene hold weights, in scene order. A scene with no beat weighs 1 — it is not
 * being paced, so it must not be penalised either.
 */
export function beatHoldWeights(scenes: any[]): number[] {
  const beats = sceneBeats(scenes);
  const run = beats.filter((b) => b === 'escalation').length;
  let seen = 0;
  return beats.map((beat) => {
    if (!beat) return 1;
    if (beat !== 'escalation') return BEAT_HOLD[beat];
    const top = BEAT_HOLD.escalation;
    const t = run > 1 ? seen++ / (run - 1) : 0;
    return top + (ESCALATION_FLOOR - top) * t;
  });
}

/**
 * How many seconds of the episode each scene may claim, in scene order.
 *
 * The share used to be `target * words / totalWords` — purely how much was written in
 * the scene. Weighting it by the beat is what makes the distribution an edit rather
 * than a word count, and dividing by the weighted total is what keeps it honest: the
 * returned shares sum to `targetSeconds` exactly, as the unweighted ones did. This
 * decides HOW the requested runtime is spread, never how much of it there is.
 *
 * A share is a claim, not a duration. planScenePadding still refuses to trim narration
 * below its own length or to pad past MAX_PAD_FACTOR, so a scene that claims less than
 * it speaks simply holds no still afterwards — no word is ever cut to make this fit.
 */
export function beatShares(scenes: any[], targetSeconds: number): number[] {
  const weights = beatHoldWeights(scenes);
  const claims = (scenes || []).map((s, i) => countWords(s?.narration_text) * (weights[i] ?? 1));
  const total = claims.reduce((n, c) => n + c, 0);
  return claims.map((c) => (total > 0 ? (targetSeconds * c) / total : 0));
}
