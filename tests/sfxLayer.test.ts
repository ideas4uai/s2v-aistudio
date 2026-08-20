import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  synthesize, planSfxCues, renderSfxBed, sfxHeadroom, SFX_SAMPLE_RATE, WHOOSH_LEAD,
} from '../src/services/sfx.js';
import { planOverlay } from '../src/services/overlayPlan.js';

/**
 * There was no sound-effects layer at all — not a thin one, an absent one. The finished
 * mix was narration and, since the mixing work, a music bed. Every cut and every graphic
 * entrance landed in silence.
 *
 * The two things worth pinning are the two things that make an effects layer either
 * craft or noise: WHEN it fires (rarely, and only where the edit already decided
 * something was happening) and WHERE exactly it lands (on the frame, off the same
 * timings the captions and overlays use).
 */

const S = (i: number, text: string) => ({
  scene_id: `s${i}`,
  order: i,
  narration_text: text,
  duration_actual: 6,
  speech_start: 0.2,
  speech_end: 5.4,
});

/** Six beats that between them earn a kinetic line, a figure, and a closing question. */
const episode = () => [
  S(0, 'Your test suite takes forty minutes and nobody trusts it.'),
  S(1, 'One change cut that to four minutes flat.'),
  S(2, 'The team still writes the same checks by hand each week.'),
  S(3, 'Teams report 40% fewer flaky failures after the switch.'),
  S(4, 'It runs on every commit without anyone remembering to start it.'),
  S(5, 'What will you ship with the time you get back?'),
];
const projectOf = (scenes: any[]) => ({ project_id: 'p', topic: 'Playwright', scenes });
const evenly = (scenes: any[], each = 6) => scenes.map(() => each);

describe('the sounds themselves', () => {
  it('are synthesised, so there is no licence to get wrong', () => {
    // The whole reason this is arithmetic and not a sample pack. Nothing is fetched and
    // nothing is bundled — if this ever needs a file on disk, that decision should be
    // made deliberately and not slip in.
    const src = fs.readFileSync(path.join(process.cwd(), 'src/services/sfx.ts'), 'utf-8');
    expect(src).not.toMatch(/fetch\(|https?:\/\/|require\(['"]node-fetch/);
    expect(synthesize('whoosh').length).toBeGreaterThan(0);
  });

  it('is deterministic — the same render makes the same bytes', () => {
    expect(Array.from(synthesize('whoosh'))).toEqual(Array.from(synthesize('whoosh')));
    expect(Array.from(synthesize('tick'))).toEqual(Array.from(synthesize('tick')));
  });

  it('starts and ends at silence, so no effect clicks', () => {
    for (const kind of ['whoosh', 'tick'] as const) {
      const s = synthesize(kind);
      expect(Math.abs(s[0])).toBeLessThan(1e-3);
      expect(Math.abs(s[s.length - 1])).toBeLessThan(1e-3);
    }
  });

  it('leaves the voice at least 12 dB of room at its loudest instant', () => {
    // Narration reaches the mix compressed to roughly -6 dBFS peak. An effect that
    // reaches within 12 dB of that is competing with the line, not punctuating it.
    for (const kind of ['whoosh', 'tick'] as const) {
      const peak = Math.max(...Array.from(synthesize(kind)).map(Math.abs));
      expect(20 * Math.log10(peak)).toBeLessThan(-18);
    }
    // and the tick is the quieter of the two — it lands under a line, not between them
    const p = (k: 'whoosh' | 'tick') => Math.max(...Array.from(synthesize(k)).map(Math.abs));
    expect(p('tick')).toBeLessThan(p('whoosh'));
  });

  it('reaches the level it declares, rather than whatever survives the fades', () => {
    // The first version normalised before applying the anti-click ramps, so the tick's
    // peak — its whole character, 0.6 ms in — was multiplied by a near-zero head fade
    // and the sound landed at -33.7 dBFS against the -26 it claimed. The level a mix is
    // built around has to be the level the sound actually reaches.
    const peak = (k: 'whoosh' | 'tick') => 20 * Math.log10(Math.max(...Array.from(synthesize(k)).map(Math.abs)));
    expect(peak('whoosh')).toBeCloseTo(-20, 1);
    expect(peak('tick')).toBeCloseTo(-26, 1);
  });

  it('keeps the tick an attack, not a swell', () => {
    const s = synthesize('tick');
    const peak = Math.max(...Array.from(s).map(Math.abs));
    const at = Array.from(s).findIndex((x) => Math.abs(x) === peak) / SFX_SAMPLE_RATE;
    expect(at).toBeLessThan(0.003);
  });

  it('keeps the whoosh short enough to punctuate rather than wash', () => {
    expect(synthesize('whoosh').length / SFX_SAMPLE_RATE).toBeLessThan(0.5);
    expect(synthesize('tick').length / SFX_SAMPLE_RATE).toBeLessThan(0.1);
  });
});

describe('when an effect fires', () => {
  it('marks a cut the transition system had already decided to make felt', () => {
    const scenes = episode();
    const cues = planSfxCues(scenes, projectOf(scenes), evenly(scenes));
    const whooshes = cues.filter((c) => c.kind === 'whoosh');
    expect(whooshes.some((c) => c.reason.includes('whip_flash'))).toBe(true);
  });

  it('marks the turn into the close', () => {
    const scenes = episode();
    const cues = planSfxCues(scenes, projectOf(scenes), evenly(scenes));
    expect(cues.some((c) => c.reason.includes('turn into the close'))).toBe(true);
  });

  it('ticks a stat and a kinetic line, and nothing else', () => {
    const scenes = episode();
    const project = projectOf(scenes);
    const cues = planSfxCues(scenes, project, evenly(scenes));
    const ticked = cues.filter((c) => c.kind === 'tick').map((c) => c.reason);
    expect(ticked.some((r) => r.startsWith('stat'))).toBe(true);
    expect(ticked.some((r) => r.startsWith('kinetic'))).toBe(true);
    // The closing scene really does carry a payoff overlay, and it really is silent.
    expect(planOverlay(scenes[5], project, 6)?.kind).toBe('payoff');
    expect(ticked.some((r) => r.startsWith('payoff'))).toBe(false);
  });

  it('stays silent on a project the edit gave nothing to mark', () => {
    // One scene: no cut to punctuate, no close to turn into. The render sounds exactly
    // as it does today, which is the correct answer and not a failure.
    const scenes = [S(0, 'A single quiet line with nothing else around it.')];
    expect(planSfxCues(scenes, projectOf(scenes), [6])).toEqual([]);
  });

  it('is rare — never more than one effect per eight seconds of runtime', () => {
    const scenes = episode();
    const cues = planSfxCues(scenes, projectOf(scenes), evenly(scenes));
    const total = 36;
    expect(cues.length).toBeLessThanOrEqual(Math.ceil(total / 8));
    expect(cues.length).toBeGreaterThan(0);
  });

  it('never lands two effects on top of each other', () => {
    const scenes = episode();
    const cues = planSfxCues(scenes, projectOf(scenes), evenly(scenes));
    for (let i = 1; i < cues.length; i++) {
      expect(cues[i].at - cues[i - 1].at).toBeGreaterThanOrEqual(1.2);
    }
  });

  it('refuses to guess when a segment could not be measured', () => {
    const scenes = episode();
    // Wrong-length duration list: nothing is placed rather than placed approximately.
    expect(planSfxCues(scenes, projectOf(scenes), [6, 6])).toEqual([]);
    expect(planSfxCues(scenes, projectOf(scenes), [])).toEqual([]);
  });

  it('says why every effect fired', () => {
    const scenes = episode();
    const cues = planSfxCues(scenes, projectOf(scenes), evenly(scenes));
    expect(cues.every((c) => c.reason.length > 0)).toBe(true);
  });
});

describe('where the effect lands', () => {
  it('leads the cut so the whoosh peaks ON the boundary', () => {
    // The lead is where the sound actually peaks, not a round number. If the envelope
    // is ever reshaped, this fails rather than sliding every whoosh quietly off its cut.
    const whoosh = synthesize('whoosh');
    const peak = Math.max(...Array.from(whoosh).map(Math.abs));
    const peakAt = Array.from(whoosh).findIndex((x) => Math.abs(x) === peak) / SFX_SAMPLE_RATE;
    expect(WHOOSH_LEAD).toBeCloseTo(peakAt, 2);

    const scenes = episode();
    const durations = [5, 7, 4, 6, 8, 5];
    const cues = planSfxCues(scenes, projectOf(scenes), durations);
    const boundary = (i: number) => durations.slice(0, i).reduce((n, d) => n + d, 0);
    const whooshes = cues.filter((c) => c.kind === 'whoosh');
    expect(whooshes.length).toBeGreaterThan(0);
    for (const cue of whooshes) {
      const i = Number(/scene (\d+)/.exec(cue.reason)![1]) - 1;
      expect(cue.at).toBeCloseTo(boundary(i) - WHOOSH_LEAD, 6);
      // and its loudest instant really does land on the cut, within a frame at 24fps
      expect(Math.abs(cue.at + peakAt - boundary(i))).toBeLessThan(1 / 24);
    }
  });

  it('puts the tick on the overlay entrance, off the same timings the captions use', () => {
    // Not a separate timing system: planOverlay anchors on wordTimings(), and this is
    // that number plus where the scene starts in the concat.
    const scenes = episode();
    const project = projectOf(scenes);
    const durations = [5, 7, 4, 6, 8, 5];
    const cues = planSfxCues(scenes, project, durations);
    const offset = (i: number) => durations.slice(0, i).reduce((n, d) => n + d, 0);
    for (const cue of cues.filter((c) => c.kind === 'tick')) {
      const i = Number(/scene (\d+)/.exec(cue.reason)![1]) - 1;
      const spec = planOverlay(scenes[i], project, durations[i])!;
      expect(cue.at).toBeCloseTo(offset(i) + spec.start, 6);
    }
  });

  it('keeps clear of the very head and tail of the video', () => {
    const scenes = episode();
    const durations = evenly(scenes);
    const total = durations.reduce((n, d) => n + d, 0);
    for (const cue of planSfxCues(scenes, projectOf(scenes), durations)) {
      expect(cue.at).toBeGreaterThanOrEqual(0.25);
      expect(cue.at).toBeLessThan(total - 0.15);
    }
  });
});

describe('the rendered bed', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfx-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const out = () => path.join(dir, 'bed.wav');

  it('writes nothing when there is nothing to say', () => {
    expect(renderSfxBed([], 30, out())).toBe(false);
    expect(fs.existsSync(out())).toBe(false);
  });

  it('is switched off by a zero trim, without touching the firing logic', () => {
    // How the before/after comparison render is produced: settings.sfxVolume = 0.
    const cues = planSfxCues(episode(), projectOf(episode()), evenly(episode()));
    expect(cues.length).toBeGreaterThan(0);
    expect(renderSfxBed(cues, 36, out(), 0)).toBe(false);
  });

  it('is a real WAV the length of the video', () => {
    const scenes = episode();
    const cues = planSfxCues(scenes, projectOf(scenes), evenly(scenes));
    expect(renderSfxBed(cues, 36, out())).toBe(true);
    const buf = fs.readFileSync(out());
    expect(buf.subarray(0, 4).toString()).toBe('RIFF');
    expect(buf.subarray(8, 12).toString()).toBe('WAVE');
    expect(buf.readUInt32LE(24)).toBe(SFX_SAMPLE_RATE);
    const samples = buf.readUInt32LE(40) / 2;
    expect(samples / SFX_SAMPLE_RATE).toBeCloseTo(36, 1);
  });

  it('is silent everywhere except at its cues', () => {
    const scenes = episode();
    const cues = planSfxCues(scenes, projectOf(scenes), evenly(scenes));
    renderSfxBed(cues, 36, out());
    const buf = fs.readFileSync(out());
    const at = (seconds: number) => Math.abs(buf.readInt16LE(44 + Math.round(seconds * SFX_SAMPLE_RATE) * 2));
    // A second clear of every cue, in the middle of a scene: literally zero.
    const quiet = [3, 12, 27].filter((t) => cues.every((c) => Math.abs(c.at - t) > 1));
    expect(quiet.length).toBeGreaterThan(0);
    for (const t of quiet) expect(at(t)).toBe(0);
    // and at a cue, something is actually there
    const loudest = cues.find((c) => c.kind === 'whoosh')!;
    const window = Array.from({ length: 400 }, (_, i) => at(loudest.at + 0.2 + i / SFX_SAMPLE_RATE));
    expect(Math.max(...window)).toBeGreaterThan(200);
  });

  it('never renders a sample past full scale, even with several cues stacked', () => {
    const scenes = episode();
    const cues = planSfxCues(scenes, projectOf(scenes), evenly(scenes));
    renderSfxBed(cues, 36, out());
    const buf = fs.readFileSync(out());
    let peak = 0;
    for (let i = 44; i + 1 < buf.length; i += 2) peak = Math.max(peak, Math.abs(buf.readInt16LE(i)));
    expect(peak).toBeLessThan(32767);
    // and reports that peak as a level, for the render log
    expect(sfxHeadroom(cues)).toBeLessThan(-12);
    expect(sfxHeadroom([])).toBe(-Infinity);
  });
});

describe('the master pass carries the layer', () => {
  const render = fs.readFileSync(path.join(process.cwd(), 'src/services/renderService.ts'), 'utf-8');
  const master = render.slice(render.indexOf('── The sound-effects layer'));

  it('mixes the effects before loudnorm, not after', () => {
    // Otherwise the finished file is normalised to a level that never saw the effects.
    const mix = master.indexOf('amix=inputs=2:duration=first:normalize=0[mix]');
    expect(mix).toBeGreaterThan(-1);
    expect(master.indexOf('[mix]${master}[aout]')).toBeGreaterThan(mix);
  });

  it('joins the effects after the sidechain, so a whoosh is not ducked away', () => {
    expect(master).toMatch(/\[duck\]\[sfx\]amix=inputs=2:duration=first:normalize=0\[bed\]/);
  });

  it('keeps normalize=0 so adding the layer cannot attenuate the narration', () => {
    const amixes = master.match(/amix=inputs=\d+:duration=first:normalize=0/g) || [];
    expect(amixes.length).toBeGreaterThanOrEqual(2);
  });

  it('measures the cut boundaries rather than trusting duration_target', () => {
    expect(render).toMatch(/stitched\.push\(\{ scene: \(scene as any\)\.scene \?\? scene, duration: dur \}\)/);
    expect(master).toMatch(/planSfxCues\(stitched\.map/);
  });

  it('is handed the narrated scene, not just a path and a duration', () => {
    // The first render of this layer placed nothing at all. stitchScenes is called with
    // concat entries — `{ video_path, duration }` — and never with the scenes themselves,
    // so every scene the effects layer inspected had no narration, no scene_id and no
    // overlay, and both planOverlay and sceneBeats correctly answered "nothing here".
    // The two halves of that seam: the orchestrator attaches the scene, and the stitch
    // unwraps it.
    const orch = fs.readFileSync(path.join(process.cwd(), 'src/pipeline/orchestrator.ts'), 'utf-8');
    const entry = orch.slice(orch.indexOf('finalScenes.push({'));
    expect(entry.slice(0, entry.indexOf('});'))).toMatch(/\n\s+scene,/);
    expect(render).toContain('(scene as any).scene ?? scene');
  });

  it('skips the layer rather than guessing when a segment could not be probed', () => {
    expect(master).toMatch(/skipping the effects layer rather than guessing/);
  });

  it('logs every cue and the layer\'s peak level', () => {
    expect(master).toContain('sfxHeadroom(sfxCues, sfxVolume)');
    expect(master).toMatch(/c\.reason/);
  });
});
