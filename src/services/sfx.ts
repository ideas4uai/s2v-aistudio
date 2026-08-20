import fs from 'fs';
import { planOverlay, transitionBetween, type OverlayKind, type OverlaySpec } from './overlayPlan.js';
import { sceneBeats } from '../utils/beats.js';

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

export type SfxKind = 'whoosh' | 'tick';

export interface SfxCue {
  /** Seconds into the finished video. */
  at: number;
  kind: SfxKind;
  /** Why it fired, for the render log — this layer is only defensible if it is legible. */
  reason: string;
}

/**
 * Peak amplitude of each sound, as a fraction of full scale: -20 dBFS and -26 dBFS.
 *
 * Narration reaches the amix compressed to roughly -6 dBFS peak, so the whoosh sits ~14 dB
 * and the tick ~20 dB below the voice at their loudest instant, and both are transients an
 * order of magnitude shorter than loudness integration's 400 ms window. sfxHeadroom()
 * reports this so the render log carries the number rather than this comment carrying a
 * claim.
 */
const PEAK: Record<SfxKind, number> = { whoosh: 0.10, tick: 0.05 };

/** Length of each sound. A whoosh past half a second stops punctuating and starts being a bed. */
const DURATION: Record<SfxKind, number> = { whoosh: 0.42, tick: 0.055 };

/**
 * A whoosh peaks after it starts, and the peak wants to be ON the cut — so it begins this
 * far before the boundary. Standard practice, and the reason a transition sound placed
 * exactly on the cut always sounds late.
 */
const WHOOSH_LEAD = 0.14;

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

/** A raised-cosine fade this long at each end, so no sample starts or ends on a step. */
const ANTICLICK = 0.004;

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
    } else {
      // A soft pop: 1.8 kHz with its octave a third down, decaying in about 25 ms.
      const ph = (2 * Math.PI * 1800 * i) / SFX_SAMPLE_RATE;
      s = (Math.sin(ph) + 0.33 * Math.sin(2 * ph)) * Math.exp(-t * 14);
    }
    out[i] = s;
  }

  // Peak-normalise, then anti-click both ends.
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  const gain = peak > 0 ? PEAK[kind] / peak : 0;
  const fade = Math.max(1, Math.round(ANTICLICK * SFX_SAMPLE_RATE));
  for (let i = 0; i < n; i++) {
    const edge = Math.min(i, n - 1 - i);
    const ramp = edge < fade ? 0.5 - 0.5 * Math.cos((Math.PI * edge) / fade) : 1;
    out[i] *= gain * ramp;
  }
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

  // ── Whooshes, on cuts already meant to be felt ───────────────────────────────────
  for (let i = 1; i < list.length; i++) {
    const designed = transitionBetween(specs[i - 1], specs[i]);
    // The turn into the close. Every short-form edit marks it, and it is the one cut
    // whose position is known from the beat rather than from an overlay.
    const intoClose = beats[i] === 'payoff' && beats[i - 1] !== 'payoff';
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
      at: offsets[i] + spec.start,
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
    if (kept.length && cue.at - kept[kept.length - 1].at < MIN_GAP) continue;
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
