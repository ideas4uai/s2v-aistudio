import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  synthesize, planSfxCues, renderSfxBed, sfxHeadroom, SFX_SAMPLE_RATE, WHOOSH_LEAD, TICK_LEAD,
  SFX_DURATION,
} from '../src/services/sfx.js';
import { planOverlay } from '../src/services/overlayPlan.js';
import { speechWindow } from '../src/services/captionService.js';
import { sceneBeats } from '../src/utils/beats.js';

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

  it('is kept off the narration by the duck, not by being too quiet to hear', () => {
    // This test used to require both sounds to sit 18 dB under full scale, on the theory
    // that headroom against the narration's peak is what keeps an effect from competing
    // with it. Measured on the delivered render, that theory produced two sounds nobody
    // could hear: the whoosh was masked by the music in every band below 4.5 kHz and the
    // tick was under the codec's own difference noise. Peak headroom is not what makes an
    // effect polite — a sidechain is, and the master pass now has one for the effects bus.
    const render = fs.readFileSync(path.join(process.cwd(), 'src/services/renderService.ts'), 'utf-8');
    expect(render).toMatch(/\[sfxraw\]\[sk\]sidechaincompress=threshold=0\.05:ratio=4/);
    // Gentler than the music's duck: a bed must leave a line alone, an effect only has to
    // not sit on it.
    expect(render).toMatch(/\[bg\]\[vk\]sidechaincompress=threshold=0\.03:ratio=8/);
    // The tick used to be required to peak below the whoosh. It now matches it, on
    // purpose: loudness integrates over about 200 ms, so a 55 ms tick at the same peak as
    // a 420 ms whoosh still reads several dB quieter. Two rounds of "it's a bit little"
    // came back from levels the band analysis said were clear, and that gap is why.
    // What is still required is that nothing peaks ABOVE the whoosh.
    const p = (k: 'whoosh' | 'tick' | 'riser') => Math.max(...Array.from(synthesize(k)).map(Math.abs));
    expect(p('tick')).toBeLessThanOrEqual(p('whoosh'));
    expect(p('riser')).toBeLessThan(p('whoosh'));
  });

  it('reaches the level it declares, rather than whatever survives the fades', () => {
    // The first version normalised before applying the anti-click ramps, so the tick's
    // peak — its whole character, 0.6 ms in — was multiplied by a near-zero head fade
    // and the sound landed at -33.7 dBFS against the -26 it claimed. The level a mix is
    // built around has to be the level the sound actually reaches.
    const peak = (k: 'whoosh' | 'tick') => 20 * Math.log10(Math.max(...Array.from(synthesize(k)).map(Math.abs)));
    expect(peak('whoosh')).toBeCloseTo(-10, 1);
    expect(peak('tick')).toBeCloseTo(-10, 1);
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

  it('marks the turn into the close — with the riser when one fits, else a whoosh', () => {
    // This used to require the whoosh specifically. A riser resolving on that cut is the
    // same mark made better, so when one fits it takes the moment and the whoosh stands
    // down; two transition sounds on one cut is one too many.
    const scenes = episode();
    const cues = planSfxCues(scenes, projectOf(scenes), evenly(scenes));
    expect(cues.some((c) => c.reason.includes('into the close'))).toBe(true);
    expect(cues.filter((c) => c.reason.includes('into the close'))).toHaveLength(1);
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
    // The gap is clear air BETWEEN effects now, end to start — start-to-start was fine
    // while everything was under half a second and wrong the moment the riser ran 1.2s.
    const scenes = episode();
    const cues = planSfxCues(scenes, projectOf(scenes), evenly(scenes));
    for (let i = 1; i < cues.length; i++) {
      const previousEnd = cues[i - 1].at + SFX_DURATION[cues[i - 1].kind];
      expect(cues[i].at - previousEnd).toBeGreaterThanOrEqual(1.2);
    }
  });

  it('lets nothing land inside the riser', () => {
    // The case the old start-to-start rule would have allowed: a 1.3s-later cue passes
    // "not within 1.2s" while sitting in the middle of a 1.2s sound.
    const scenes = episode();
    const cues = planSfxCues(scenes, projectOf(scenes), evenly(scenes));
    const riser = cues.find((c) => c.kind === 'riser');
    expect(riser).toBeTruthy();
    const span = [riser!.at, riser!.at + SFX_DURATION.riser];
    for (const other of cues.filter((c) => c !== riser)) {
      const overlaps = other.at < span[1] && other.at + SFX_DURATION[other.kind] > span[0];
      expect(overlaps).toBe(false);
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

describe('the riser', () => {
  /** Overrides for one scene of the standard episode. */
  const withScene = (i: number, over: Record<string, unknown>) => {
    const scenes = episode();
    Object.assign(scenes[i], over);
    return scenes;
  };
  const riserIn = (scenes: any[], durations = evenly(scenes)) =>
    planSfxCues(scenes, projectOf(scenes), durations).find((c) => c.kind === 'riser');

  it('builds out of the escalation that runs into the close', () => {
    const scenes = episode();
    const r = riserIn(scenes);
    expect(r).toBeTruthy();
    expect(r!.reason).toMatch(/building through scene 5 into the close at scene 6/);
  });

  it('resolves on the measured cut into the close, ahead of its first word', () => {
    // The boundary is the ffprobe'd concat position, not an offset from anything. The
    // first version resolved on the close's first word instead and the effects duck was
    // pulling the climax down as the voice arrived; the speech span is what shows the
    // cut leads the word, so a climax placed here always lands before the key opens.
    const scenes = episode();
    const durations = [5, 7, 4, 6, 8, 5];
    const r = riserIn(scenes, durations)!;
    const cut = durations.slice(0, 5).reduce((n, d) => n + d, 0);
    expect(r.at + SFX_DURATION.riser).toBeCloseTo(cut, 6);
    expect(speechWindow(scenes[5]).start).toBeGreaterThan(0);
  });

  it('peaks at its end, so the build resolves rather than swells', () => {
    const s = synthesize('riser');
    const peak = Math.max(...Array.from(s).map(Math.abs));
    const at = Array.from(s).findIndex((x) => Math.abs(x) === peak) / s.length;
    expect(at).toBeGreaterThan(0.9);
    // and it really climbs: the last tenth carries far more energy than the first
    const tenth = (q: number) => {
      const a = Math.floor((s.length * q) / 10);
      const b = Math.floor((s.length * (q + 1)) / 10);
      let e = 0;
      for (let i = a; i < b; i++) e += s[i] * s[i];
      return e / (b - a);
    };
    expect(10 * Math.log10(tenth(9) / tenth(0))).toBeGreaterThan(30);
  });

  it('carries a rising pitch, not just a rising level', () => {
    // Without a pitch in it a riser is a swell. Zero-crossing rate in the last tenth
    // must clearly exceed the first tenth's.
    const s = synthesize('riser');
    const crossings = (from: number, to: number) => {
      let c = 0;
      for (let i = from + 1; i < to; i++) if ((s[i - 1] < 0) !== (s[i] < 0)) c++;
      return c / (to - from);
    };
    const a = Math.floor(s.length * 0.15);
    const b = Math.floor(s.length * 0.25);
    const y = Math.floor(s.length * 0.85);
    const z = Math.floor(s.length * 0.95);
    expect(crossings(y, z)).toBeGreaterThan(crossings(a, b) * 1.5);
  });

  it('stays under the sounds it is building toward', () => {
    // A build that arrives louder than its own payoff has swallowed it.
    const peak = (k: 'whoosh' | 'tick' | 'riser') =>
      Math.max(...Array.from(synthesize(k)).map(Math.abs));
    expect(peak('riser')).toBeLessThan(peak('whoosh'));
    expect(peak('riser')).toBeLessThan(peak('tick'));
  });

  it('stands the closing whoosh down rather than stacking on it', () => {
    const scenes = episode();
    const cues = planSfxCues(scenes, projectOf(scenes), evenly(scenes));
    expect(cues.some((c) => c.kind === 'riser')).toBe(true);
    expect(cues.some((c) => c.reason.includes('turn into the close'))).toBe(false);
  });

  it('is at most one per render', () => {
    const scenes = episode();
    expect(planSfxCues(scenes, projectOf(scenes), evenly(scenes))
      .filter((c) => c.kind === 'riser')).toHaveLength(1);
  });

  it('will not fire on a beat too short to build through', () => {
    // Under twice its own length it would start on or before the cut into that beat and
    // be smeared across two shots instead of building through one. Both cases keep the
    // same 0.6s tail, so length is the only thing being varied.
    const short = withScene(4, { speech_start: 0.2, speech_end: 1.4 });
    expect(riserIn(short, [6, 6, 6, 6, 2.0, 6])).toBeUndefined();
    // a second longer and it fits
    const enough = withScene(4, { speech_start: 0.2, speech_end: 2.4 });
    expect(riserIn(enough, [6, 6, 6, 6, 3.0, 6])).toBeTruthy();
  });

  it('will not fire when the escalation talks right up to the cut', () => {
    // No air to build in. The effects bus ducks under the voice, so a riser placed here
    // would be pulled down exactly as it arrived.
    const scenes = withScene(4, { speech_start: 0.2, speech_end: 5.9 });   // 0.1s tail
    expect(riserIn(scenes)).toBeUndefined();
    expect(riserIn(withScene(4, { speech_start: 0.2, speech_end: 5.4 }))).toBeTruthy();
  });

  it('does not fire when nothing escalates into the close', () => {
    // Three spoken beats are hook, payload, payoff — sceneBeats produces no escalation,
    // so there is no build to make. Four is the first shape that has one.
    const three = [
      S(0, 'Your test suite takes forty minutes and nobody trusts it.'),
      S(1, 'One change cut that to four minutes flat.'),
      S(2, 'What will you ship with the time you get back?'),
    ];
    expect(riserIn(three, [6, 6, 6])).toBeUndefined();
    expect(sceneBeats(three)).toEqual(['hook', 'payload', 'payoff']);
    expect(riserIn(episode().slice(0, 4), [6, 6, 6, 6])).toBeTruthy();
  });

  it('is silent on a project whose close has no words', () => {
    // A wordless closing card gets no beat, so there is nothing to resolve onto.
    const scenes = withScene(5, { narration_text: '' });
    expect(riserIn(scenes)).toBeTruthy();   // the close moves to scene 5, which does speak
    expect(sceneBeats(scenes)[5]).toBeNull();
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
      expect(cue.at).toBeCloseTo(offset(i) + spec.start - TICK_LEAD, 6);
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
    // The loudest effect peaks at the narration's own peak in the finished file
    // (-10 dBFS) and no higher; the duck bus is what keeps it off a line.
    expect(sfxHeadroom(cues)).toBeCloseTo(-10, 1);
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
