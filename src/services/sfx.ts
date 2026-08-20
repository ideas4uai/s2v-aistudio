import fs from 'fs';
import { planOverlay, transitionBetween, type OverlayKind, type OverlaySpec } from './overlayPlan.js';
import { sceneBeats } from '../utils/beats.js';
import { speechWindow } from './captionService.js';

/**
 * The sound-effects layer: a whoosh on a cut that is meant to be felt, a soft tick when
 * a graphic lands. There was no such layer at all — the finished mix was narration plus
 * a music bed, and every cut and every overlay entrance was silent.
 *
 * ── Where the sounds come from ───────────────────────────────────────────────────────
 *
 * They are synthesised here, in about forty lines of arithmetic, rather than sourced.
 * That is not a shortcut around licensing, it is the answer to it: nothing is downloaded,
 * nothing is redistributed, and there is no licence to honour or misread. It matches what
 * this codebase already does for TTS (local Piper/Kokoro rather than a hosted voice) and
 * costs no new dependency — a WAV is a 44-byte header and PCM samples, and Node writes
 * both with Buffer.
 *
 * A whoosh is band-passed noise whose passband sweeps up and back down; a tick is a short
 * decaying sine with one partial. Those are the actual definitions of the two sounds, not
 * approximations of a recording of them.
 *
 * ── Where it goes in the mix ─────────────────────────────────────────────────────────
 *
 * One WAV for the whole timeline, joined as one more input to the master pass's amix
 * BEFORE loudnorm — so loudnorm measures the finished mix including the effects, exactly
 * as it already does for the music bed. Not a separate audio path, and not something
 * layered on after the level has been set.
 */

export const SFX_SAMPLE_RATE = 44100;

export type SfxKind = 'whoosh' | 'tick' | 'riser';

export interface SfxCue {
  /** Seconds into the finished video. */
  at: number;
  kind: SfxKind;
  /** Why it fired, for the render log — this layer is only defensible if it is legible. */
  reason: string;
}

/**
 * Peak amplitude of each sound, as a fraction of full scale: -10 dBFS and -16 dBFS.
 *
 * The first version used -20 and -26, chosen so each sound sat comfortably under the
 * narration's peak. Peak level turned out to be the wrong thing to choose by, and the
 * finished render proved it: measured on the delivered file, band by band against what
 * was already playing underneath,
 *
 *   whoosh   masked by 3-20 dB everywhere below 4.5 kHz; cleared the bed only above it.
 *            The moment got 0.60 dB louder — under the ~1 dB an ear resolves at all.
 *   tick     masked by 6-28 dB in every band up to 7 kHz. The moment got 0.03 dB
 *            QUIETER. It was below the codec's own difference noise.
 *
 * Both were exactly the level they claimed and neither could be heard, because what
 * decides audibility is not a sound's peak but how it compares with the music and speech
 * occupying its own bands at that instant.
 *
 * These levels come from that measurement plus the practice they sit in. Narration in the
 * finished file peaks at -10 dBFS. In short-form editing a transition sound occupies a gap
 * and is routinely as loud as the dialogue around it; a hard effect that overlaps dialogue
 * sits 6-10 dB under it. So: the whoosh at the narration's own peak, the tick below it —
 * and the mix ducks the whole effects bus under the voice (see the master pass), so
 * neither can sit on a line however loud it is in a gap.
 *
 * The whoosh at -10 was confirmed correct on a listen. The tick was heard at -16 and again
 * after the interpolation to -12, and reported as still too small both times, so it now
 * matches the whoosh at -10 — three quarters of the way from the -16 that failed to the -8
 * proof render that was clearly audible, and 2 dB under that proof.
 *
 * Equal peak is not equal loudness here, which is why the tick can take the whoosh's
 * number without becoming the loudest thing in the mix: loudness integrates over roughly
 * 200 ms, and the tick is 55 ms against the whoosh's 420. At the same peak a sound that
 * short still reads several dB quieter. That is the reason two rounds of "it's a bit
 * little" kept coming back from levels the band analysis said were clear — clearing a
 * masker makes a sound detectable, and duration is what makes it feel present.
 *
 * The riser is the one sound that must NOT be the loudest thing at its moment: it exists
 * to build toward the beat it resolves into, and a build that arrives louder than what it
 * is building to has swallowed its own payoff. It sits below both.
 */
const PEAK: Record<SfxKind, number> = { whoosh: 0.316, tick: 0.316, riser: 0.251 };

/**
 * Length of each sound. A whoosh past half a second stops punctuating and starts being a
 * bed; a riser under about a second has no time to build and just sounds like a swell.
 */
const DURATION: Record<SfxKind, number> = { whoosh: 0.42, tick: 0.055, riser: 1.2 };

/** Exported so a test can check the spacing rule without re-declaring these numbers. */
export const SFX_DURATION: Readonly<Record<SfxKind, number>> = DURATION;

/**
 * A whoosh peaks after it starts, and the peak wants to be ON the cut — so it begins this
 * far before the boundary. Standard practice, and the reason a transition sound placed
 * exactly on the cut always sounds late.
 *
 * The number is not taste: it is where synthesize('whoosh') actually peaks, measured at
 * 211 ms of its 420 ms. The test asserts the two stay equal, so reshaping the envelope
 * cannot silently slide every whoosh off its cut.
 */
export const WHOOSH_LEAD = 0.21;

/**
 * A tick lands this far BEFORE the word whose overlay it marks.
 *
 * Not a refinement — it is the difference between hearing it and not. The overlay's
 * entrance is by construction the instant the first word is spoken, which is the most
 * masking instant in the whole scene: measured on the delivered render, the tick sitting
 * exactly on that onset was 22 dB under it in its own band and 6-28 dB under it in every
 * band up to 7 kHz. Eighty milliseconds earlier is the leading silence before the line,
 * where the only thing to clear is the music bed. It also reads better — the graphic
 * snapping on and then the word, which is the order the eye and ear expect.
 */
export const TICK_LEAD = 0.08;

/**
 * A riser needs the beat it builds through to be at least this long — twice its own
 * length. Under that it would start on or before the cut into that beat, so instead of
 * building through a shot it would be smeared across two, and the ear would hear a swell
 * with no shape rather than an approach to something.
 */
export const RISER_MIN_BEAT = 2.4;

/**
 * ...and it needs this much of that beat's tail to be free of narration.
 *
 * A riser's whole shape is in its last third, and a riser whose last third sits under a
 * spoken line is ducked by the effects sidechain exactly when it should be arriving. If
 * the escalation talks right up to the cut there is no room to build in, and the honest
 * answer is to place nothing. This is the riser's version of the "does this moment
 * actually benefit" test the overlay planner applies.
 */
export const RISER_MIN_TAIL = 0.5;

/** Closest two effects may land. Under this they stop reading as two events and turn to mud. */
const MIN_GAP = 1.2;

/** One effect per this many seconds of runtime, at most. Restraint is the whole point. */
const SECONDS_PER_CUE = 8;

/**
 * The overlay kinds whose entrance earns a tick.
 *
 * A stat and a kinetic line both ARRIVE — a number snaps on, a phrase starts building —
 * and a tick is what an editor puts under an arrival. The other four are deliberately
 * silent: a diagram and a comparison reveal over seconds rather than landing on one
 * frame, a namecard slides in as a lower third and is silent by convention, and the
 * payoff runs to the end of the clip, so a tick at its head is a poke at a slow reveal.
 */
const TICKS_ON: ReadonlySet<OverlayKind> = new Set<OverlayKind>(['stat', 'kinetic']);

/**
 * Raised-cosine fades so no sample starts or ends on a step.
 *
 * The head fade is a tenth of the tail's on purpose. A tick's whole character is its
 * attack, and a 4 ms fade-in sits right on top of it: measured, a 4 ms head fade pulled
 * the tick's real peak down to -33.7 dBFS against the -26 it declares, because the first
 * cycle of an 1.8 kHz tone is 0.6 ms in and the ramp there is near zero. 0.4 ms is two
 * cycles at that frequency — enough that the waveform does not start on a step, short
 * enough that the transient survives.
 */
const FADE_IN = 0.0004;
const FADE_OUT = 0.004;

/** One-pole filter — enough to shape noise into a whoosh, and the whole DSP budget needed. */
const lowpass = (x: number, prev: number, cutoff: number): number => {
  const a = Math.min(1, (2 * Math.PI * cutoff) / SFX_SAMPLE_RATE);
  return prev + a * (x - prev);
};

/** Samples for one effect, peak-normalised to PEAK[kind]. */
export function synthesize(kind: SfxKind, seed = 1): Float32Array {
  const n = Math.round(DURATION[kind] * SFX_SAMPLE_RATE);
  const out = new Float32Array(n);
  // Deterministic noise: the same render must produce the same bytes, or the effects
  // layer would be a reason for an otherwise identical re-render to differ.
  let rng = seed >>> 0 || 1;
  const noise = () => {
    rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
    return (rng / 0x80000000) - 1;
  };

  let lo = 0;
  let hi = 0;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    let s: number;
    if (kind === 'whoosh') {
      // Passband sweeps 300 Hz up to ~5 kHz and back down. The rise is the approach, the
      // fall is the settle; a sweep that only goes one way reads as a rocket, not a cut.
      const cut = 300 + 4700 * Math.sin(Math.PI * Math.min(1, t * 1.15));
      lo = lowpass(noise(), lo, cut);
      hi = lowpass(lo, hi, 220);   // subtracting a low pole opens the bottom out
      s = lo - hi;
      // Swell in, fall away, weighted so the peak lands where WHOOSH_LEAD puts the cut.
      s *= Math.pow(Math.sin(Math.PI * t), 1.4);
    } else if (kind === 'riser') {
      // Two things climbing together. The noise is the energy — a passband walking from
      // 400 Hz to about 7 kHz — and the tone is what makes it read as RISING rather than
      // merely getting louder; without a pitch in it a riser is just a swell. Both sweep
      // exponentially because pitch is heard logarithmically, so a linear ramp spends
      // most of its length in the top octave and arrives early.
      const cut = 400 * Math.pow(18, t);
      lo = lowpass(noise(), lo, cut);
      hi = lowpass(lo, hi, 180);
      phase += (2 * Math.PI * (180 * Math.pow(6.5, t))) / SFX_SAMPLE_RATE;
      s = (lo - hi) * 0.75 + Math.sin(phase) * 0.45;
      // Quiet for the first half and steep into the resolve: an even ramp announces
      // itself too early and stops being an approach. Then a 3% release, so the sound
      // stops dead on the beat it resolves into instead of smearing across it.
      s *= Math.pow(t, 2.2) * (t > 0.97 ? (1 - t) / 0.03 : 1);
    } else {
      // A soft pop: 1.8 kHz with its octave a third down, decaying in about 25 ms.
      const ph = (2 * Math.PI * 1800 * i) / SFX_SAMPLE_RATE;
      s = (Math.sin(ph) + 0.33 * Math.sin(2 * ph)) * Math.exp(-t * 14);
    }
    out[i] = s;
  }

  // Anti-click first, THEN normalise — in that order, so PEAK[kind] is the level the
  // sound actually reaches. Normalising before the fades meant the declared peak was
  // whatever survived them, which for the tick was 8 dB lower than this file claims.
  const inFade = Math.max(1, Math.round(FADE_IN * SFX_SAMPLE_RATE));
  const outFade = Math.max(1, Math.round(FADE_OUT * SFX_SAMPLE_RATE));
  const ramp = (i: number) => {
    const head = i < inFade ? 0.5 - 0.5 * Math.cos((Math.PI * i) / inFade) : 1;
    const tail = n - 1 - i < outFade ? 0.5 - 0.5 * Math.cos((Math.PI * (n - 1 - i)) / outFade) : 1;
    return Math.min(head, tail);
  };
  let peak = 0;
  for (let i = 0; i < n; i++) {
    out[i] *= ramp(i);
    peak = Math.max(peak, Math.abs(out[i]));
  }
  const gain = peak > 0 ? PEAK[kind] / peak : 0;
  for (let i = 0; i < n; i++) out[i] *= gain;
  return out;
}

/**
 * Where the effects go, given the scenes and the measured length of each rendered
 * segment. Segment durations come from the ffprobe the stitch already runs, so a cut
 * boundary here is the frame the concat actually cuts on, not an estimate from
 * duration_target.
 *
 * Nothing fires on its own schedule. Every whoosh sits on a cut transitionBetween had
 * already decided should be felt, or on the turn into the close; every tick sits on an
 * overlay entrance planOverlay had already decided was worth drawing, at the timing
 * wordTimings() gave it. If those two say nothing for a project — which for most scenes
 * they do — this returns nothing and the render sounds exactly as it does today.
 */
export function planSfxCues(scenes: any[], project: any, segmentDurations: number[]): SfxCue[] {
  const list: any[] = scenes || [];
  if (list.length < 1 || segmentDurations.length !== list.length) return [];

  const offsets: number[] = [];
  let running = 0;
  for (const d of segmentDurations) { offsets.push(running); running += d; }
  const total = running;
  if (!(total > 0)) return [];

  const specs: (OverlaySpec | null)[] = list.map((s, i) => {
    try { return planOverlay(s, project, segmentDurations[i]); } catch { return null; }
  });
  const beats = sceneBeats(list);

  const cues: SfxCue[] = [];

  // ── The riser, building out of an escalation into the beat it resolves on ────────
  //
  // Which boundary that is comes from sceneBeats and nothing else. With the beat model
  // the pipeline actually has, exactly one boundary can qualify: sceneBeats lays an
  // episode out as hook, payload, escalation..., payoff, so the payload is preceded by
  // the hook and the only escalation-into-something transition in the whole episode is
  // the one into the close. An escalation-into-payload cannot occur — worth saying
  // plainly rather than writing a branch that can never run.
  //
  // That also makes the riser at most one per render, which is the right ceiling for the
  // largest gesture in the layer.
  let riserInto = -1;
  for (let i = 1; i < list.length; i++) {
    if (beats[i] !== 'payoff' || beats[i - 1] !== 'escalation') continue;
    // Room to build through, and room at the end to build INTO. Both are measured, not
    // assumed: the beat's length is the ffprobe'd segment, and its tail comes from the
    // same speech span wordTimings lays the captions across.
    const beatLength = segmentDurations[i - 1];
    const { start, span } = speechWindow(list[i - 1]);
    const tail = beatLength - (start + span);
    if (beatLength < RISER_MIN_BEAT || tail < RISER_MIN_TAIL) continue;
    // It resolves ON the cut — the measured concat boundary, not an offset from it.
    //
    // The first version resolved on the close's first word instead, a quarter-second
    // later. Measured on that render, the climax was arriving exactly as the voice did
    // and the effects sidechain was pulling it down on the way in: the loudest surviving
    // instant had slid back to the cut anyway, with the intended peak ducked off. The cut
    // is both the right place musically and the only place the duck leaves alone.
    //
    // The speech span is what proves that: a scene's words start `speech_start` after its
    // own cut, so the riser's climax always lands in the close's leading silence, before
    // the key opens. That is also why this is safe to anchor on the boundary rather than
    // on speech — the two are separated by a measured, non-zero gap.
    const resolveAt = offsets[i];
    riserInto = i;
    cues.push({
      at: resolveAt - DURATION.riser,
      kind: 'riser',
      reason: `building through scene ${i} into the close at scene ${i + 1}`,
    });
    break;
  }

  // ── Whooshes, on cuts already meant to be felt ───────────────────────────────────
  for (let i = 1; i < list.length; i++) {
    const designed = transitionBetween(specs[i - 1], specs[i]);
    // The turn into the close. Every short-form edit marks it, and it is the one cut
    // whose position is known from the beat rather than from an overlay.
    //
    // Unless a riser already resolves there. A riser IS that mark, and a better one —
    // it arrives at the same instant having spent a second earning it. Stacking a whoosh
    // on top would be two transition sounds on one cut. The spacing rule below would
    // drop one of them anyway; doing it here means the right one survives rather than
    // whichever happened to sort first.
    const intoClose = beats[i] === 'payoff' && beats[i - 1] !== 'payoff' && i !== riserInto;
    if (!designed && !intoClose) continue;
    cues.push({
      at: offsets[i] - WHOOSH_LEAD,
      kind: 'whoosh',
      reason: designed ? `${designed} cut into scene ${i + 1}` : `turn into the close at scene ${i + 1}`,
    });
  }

  // ── Ticks, on a graphic landing ──────────────────────────────────────────────────
  specs.forEach((spec, i) => {
    if (!spec || !TICKS_ON.has(spec.kind)) return;
    cues.push({
      at: offsets[i] + spec.start - TICK_LEAD,
      kind: 'tick',
      reason: `${spec.kind} overlay entrance on scene ${i + 1}`,
    });
  });

  // ── Restraint ────────────────────────────────────────────────────────────────────
  // In time order: drop anything too close to the effect before it, anything at the very
  // head or tail (a whoosh at frame 0 has nothing to transition out of), and anything
  // past the density cap.
  const cap = Math.max(1, Math.ceil(total / SECONDS_PER_CUE));
  const kept: SfxCue[] = [];
  for (const cue of cues.sort((a, b) => a.at - b.at)) {
    if (cue.at < 0.25 || cue.at + DURATION[cue.kind] > total - 0.15) continue;
    // MIN_GAP is clear air BETWEEN two effects, measured from the end of one to the start
    // of the next. It used to be start-to-start, which was fine while every effect was
    // under half a second and wrong the moment one of them ran for 1.2s: a tick 1.3s
    // after a riser began would have passed the old rule while landing inside the riser.
    if (kept.length) {
      const previous = kept[kept.length - 1];
      if (cue.at - (previous.at + DURATION[previous.kind]) < MIN_GAP) continue;
    }
    if (kept.length >= cap) break;
    kept.push(cue);
  }
  return kept;
}

/** 16-bit mono PCM WAV. The master pass's aformat handles the rest. */
function writeWav(samples: Float32Array, outPath: string): void {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const clipped = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(clipped * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);            // PCM
  header.writeUInt16LE(1, 22);            // mono
  header.writeUInt32LE(SFX_SAMPLE_RATE, 24);
  header.writeUInt32LE(SFX_SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(outPath, Buffer.concat([header, data]));
}

/**
 * Renders the cues to a single silent-except-for-the-effects WAV the length of the video.
 * One file, so the master pass takes one extra input rather than one per hit.
 *
 * Returns false when there is nothing to render, and the master pass then runs exactly the
 * filter graph it ran before.
 */
export function renderSfxBed(cues: SfxCue[], totalSeconds: number, outPath: string, gain = 1): boolean {
  if (!cues.length || !(totalSeconds > 0) || gain <= 0) return false;
  const bed = new Float32Array(Math.ceil(totalSeconds * SFX_SAMPLE_RATE));
  // One synthesis per kind, reused at every cue — the sounds are deterministic, so two
  // whooshes in one render are the same whoosh, which is what a sample library would give.
  const voice: Partial<Record<SfxKind, Float32Array>> = {};
  for (const cue of cues) {
    const samples = voice[cue.kind] ?? (voice[cue.kind] = synthesize(cue.kind));
    const from = Math.max(0, Math.round(cue.at * SFX_SAMPLE_RATE));
    for (let i = 0; i < samples.length && from + i < bed.length; i++) {
      bed[from + i] += samples[i] * gain;
    }
  }
  writeWav(bed, outPath);
  return true;
}

/**
 * Peak level of the effects layer, in dBFS. The master pass logs it, so "it does not
 * compete with the voice" is a number in the render log rather than a claim in a comment.
 */
export function sfxHeadroom(cues: SfxCue[], gain = 1): number {
  if (!cues.length) return -Infinity;
  const peak = Math.max(...cues.map((c) => PEAK[c.kind])) * gain;
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}
