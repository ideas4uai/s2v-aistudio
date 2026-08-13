import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { planOverlay, overlayKey } from '../src/services/overlayPlan.js';
import { visualClipPath } from '../src/services/renderService.js';
import { wordTimings } from '../src/services/captionService.js';

// The overlay is emphasis, so most scenes must get none — a plan that decorates every
// beat is the failure mode, not the feature. These assert the decision, the sync and
// the cache key; src/scripts/motion_overlay.py's own property (stateless => safe to
// render across four processes) is asserted at the bottom against the real module.

const scene = (over: any = {}): any => ({
  scene_id: 's1', scene_type: 'default', narration_text: 'The agent reads the page and decides what to click.',
  speech_start: 0.4, speech_end: 4.4, duration_actual: 5, ...over,
});

/** Six beats shaped like a real episode. scene_type stays 'default', as it is on every
 *  real rendered project — the plan reads beat position from order, not from that field. */
const project = (texts: string[]): any => ({
  project_id: 'p1',
  scenes: texts.map((t, i) => scene({ scene_id: `s${i}`, order: i, narration_text: t })),
});

const plain = [
  'Your tests break every release and someone has to fix them by hand.',
  'Playwright agents watch the run and propose a repair for review.',
  'The planner drafts the steps it thinks the page needs.',
  'The generator turns those steps into real selectors.',
  'The healer looks at what broke and suggests a change.',
  'Would you let an agent touch your test suite?',
];

const planFor = (texts: string[]) => {
  const p = project(texts);
  return p.scenes.map((s: any) => planOverlay(s, p, 6));
};

describe('which beats get an overlay', () => {
  it('gives the payload beat kinetic text and the closing beat the payoff', () => {
    const kinds = planFor(plain).map((o) => o?.kind ?? null);
    expect(kinds[0]).toBeNull();               // the hook carries itself
    expect(kinds[1]).toBe('kinetic');          // first 'build' = the front-loaded payload
    expect(kinds[kinds.length - 1]).toBe('payoff');
  });

  it('leaves most of the episode alone', () => {
    const withOverlay = planFor(plain).filter(Boolean).length;
    expect(withOverlay).toBeLessThanOrEqual(3);
    expect(withOverlay).toBeGreaterThan(0);
  });

  it('never places two overlays back to back', () => {
    // A stat-heavy script is the case that would carpet the episode.
    const statty = [
      'Tests break on 40% of releases.',
      'The suite runs 3x faster now.',
      'Teams lose 12 hours a week to it.',
      'Coverage sat at 55% before.',
      'Two agents split the work.',
      'What would you do with that week back?',
    ];
    const kinds = planFor(statty).map((o) => o?.kind ?? null);
    for (let i = 1; i < kinds.length; i++) {
      if (kinds[i] && kinds[i] !== 'payoff') expect(kinds[i - 1]).toBeNull();
    }
  });

  it('renders a figure as a call-out when the script states one', () => {
    // Scene 3, not 2: the payload beat at index 1 already has kinetic text and the
    // no-two-in-a-row rule would suppress an overlay directly after it.
    const p = project(plain.map((t, i) => (i === 3 ? 'It cuts the suite from 40 minutes to 6.' : t)));
    const spec = planOverlay(p.scenes[3], p, 6);
    expect(spec?.kind).toBe('stat');
    expect(spec?.figure).toBe('40 minutes');
  });

  it('forces no call-out on a script that states no figure', () => {
    // Graceful degradation: the non-stat episode above must not be given an awkward
    // number treatment just because the slot exists.
    expect(planFor(plain).some((o) => o?.kind === 'stat')).toBe(false);
  });

  it('gives nothing at all to a scene with no narration', () => {
    const p = project(plain);
    p.scenes[1].narration_text = '';
    expect(planOverlay(p.scenes[1], p, 6)).toBeNull();
  });
});

describe('overlay timing comes from the caption clock', () => {
  it('uses the measured speech span, not the scene duration', () => {
    const p = project(plain);
    const late = planOverlay(p.scenes[1], p, 6)!;
    // speech_start 0.4 → nothing may be drawn before the speech begins.
    expect(late.start).toBeGreaterThanOrEqual(0.4);
    expect(late.start).toBeLessThan(1.0);

    // Shift the measured span and every overlay word must move with it.
    p.scenes[1].speech_start = 2.0;
    p.scenes[1].speech_end = 5.0;
    const shifted = planOverlay(p.scenes[1], p, 6)!;
    expect(shifted.start).toBeGreaterThanOrEqual(2.0);
    expect(shifted.words[0].start).toBeGreaterThanOrEqual(2.0);
  });

  it('places each overlay word on the same clock as its caption word', () => {
    const p = project(plain);
    const spec = planOverlay(p.scenes[1], p, 6)!;
    const caption = wordTimings(p.scenes[1].narration_text, p.scenes[1]);
    spec.words.forEach((w, i) => {
      expect(w.text).toBe(caption[i].word);
      expect(w.start).toBeCloseTo(caption[i].start, 6);
    });
  });

  it('holds the payoff to the end of the clip, past the last word', () => {
    const p = project(plain);
    const last = p.scenes[p.scenes.length - 1];
    const spec = planOverlay(last, p, 9)!;
    // The final scene's pad_seconds tail is silent still frames — the closing line
    // stays up over it rather than vanishing into a held image.
    expect(spec.end).toBe(9);
    expect(spec.end).toBeGreaterThan(Number(last.speech_end));
  });
});

describe('overlay participates in the clip cache', () => {
  it('changing one scene\'s narration leaves the other scenes\' clip paths untouched', () => {
    const before = project(plain);
    const after = project(plain.map((t, i) => (i === 3 ? 'Something else entirely now.' : t)));
    const clip = (p: any, i: number) => visualClipPath(
      os.tmpdir(), 'p1', `v${i}`, 'zoom_in', overlayKey(planOverlay(p.scenes[i], p, 6)));

    // The edited scene had no overlay and still has none, so its own key is stable too;
    // what matters is that no OTHER scene's cached clip is invalidated by the edit.
    for (let i = 0; i < plain.length; i++) {
      if (i === 3) continue;
      expect(clip(after, i)).toBe(clip(before, i));
    }
  });

  it('editing the payload beat invalidates only that beat\'s clip', () => {
    const before = project(plain);
    const after = project(plain.map((t, i) => (i === 1 ? 'Three agents split the job between them.' : t)));
    const clip = (p: any, i: number) => visualClipPath(
      os.tmpdir(), 'p1', `v${i}`, 'zoom_in', overlayKey(planOverlay(p.scenes[i], p, 6)));

    expect(clip(after, 1)).not.toBe(clip(before, 1));
    expect(clip(after, 5)).toBe(clip(before, 5));
    expect(clip(after, 0)).toBe(clip(before, 0));
  });

  it('leaves the path unchanged for a scene with no overlay', () => {
    // Existing projects must not all rebuild because this feature landed.
    expect(visualClipPath(os.tmpdir(), 'p1', 'v0', 'zoom_in', ''))
      .toBe(visualClipPath(os.tmpdir(), 'p1', 'v0', 'zoom_in'));
  });
});

// ── the Python side ────────────────────────────────────────────────────────
// Same approach as frameParallel.test.ts: assert the property the parallel renderer
// depends on directly against the module, rather than through a 40-second render.

const py = (snippet: string): string =>
  execFileSync('py', ['-c', snippet], { encoding: 'utf-8', timeout: 120_000 }).trim();

describe('motion_overlay.py', () => {
  it('draws the same frame whether or not earlier frames were drawn first', () => {
    // This is what lets frame synthesis stay split across processes with no warm_to()
    // equivalent: worker 3 starting at frame 600 must draw what a sequential render
    // draws at frame 600. If the overlay ever accumulates state, this goes to 0.
    const specPath = path.join(os.tmpdir(), 'ais-overlay-spec.json');
    fs.writeFileSync(specPath, JSON.stringify({
      kind: 'kinetic', start: 0.5, end: 3.5,
      words: [0, 1, 2, 3].map((i) => ({ text: `word${i}`, start: 0.5 + i * 0.3, end: 0.8 + i * 0.3 })),
    }));
    const out = py([
      'import sys; sys.path.insert(0, "src/scripts")',
      'import numpy as np, motion_overlay as mo, json',
      `spec = json.load(open(r"${specPath.replace(/\\/g, '/')}"))`,
      'a = mo.OverlayLayer(spec, 540, 960)',
      'assert a.ok, "overlay did not build — no usable font?"',
      'bg = lambda: np.full((960, 540, 3), 90, dtype=np.uint8)',
      'cold = a.draw(bg(), 2.0)',
      'b = mo.OverlayLayer(spec, 540, 960)',
      '[b.draw(bg(), i / 24.0) for i in range(48)]',
      'warm = b.draw(bg(), 2.0)',
      'print(int(np.array_equal(cold, warm)))',
    ].join('\n'));
    expect(out.trim().endsWith('1')).toBe(true);
  });

  it('actually marks the frame, and only inside its own window', () => {
    const out = py([
      'import sys; sys.path.insert(0, "src/scripts")',
      'import numpy as np, motion_overlay as mo',
      'spec = {"kind": "payoff", "start": 1.0, "end": 4.0,',
      '        "words": [{"text": "would", "start": 1.0, "end": 1.4},',
      '                  {"text": "you", "start": 1.4, "end": 1.8}]}',
      'lay = mo.OverlayLayer(spec, 540, 960)',
      'bg = lambda: np.full((960, 540, 3), 90, dtype=np.uint8)',
      'before = lay.draw(bg(), 0.2)',
      'during = lay.draw(bg(), 2.5)',
      'after = lay.draw(bg(), 5.0)',
      'print(int(np.array_equal(before, bg())), int(not np.array_equal(during, bg())), int(np.array_equal(after, bg())))',
    ].join('\n'));
    expect(out.trim().endsWith('1 1 1')).toBe(true);
  });

  it('renders nothing rather than failing when the spec is unusable', () => {
    // A bad spec must never take a finished render down with it.
    const out = py([
      'import sys; sys.path.insert(0, "src/scripts")',
      'import motion_overlay as mo',
      'print(mo.load_overlay("nope.json", 540, 960) is None,',
      '      mo.OverlayLayer({"kind": "wat"}, 540, 960).ok)',
    ].join('\n'));
    expect(out.trim().endsWith('True False')).toBe(true);
  });

  it('is wired into the engine on the path the workers take', () => {
    const src = fs.readFileSync('src/scripts/metro_engine_v4.py', 'utf-8');
    expect(src).toContain("parser.add_argument('--overlay'");
    // The job tuple is what reaches a worker process; an overlay missing from it would
    // render the first range with kinetic text and the rest without.
    expect(src).toContain('args.fps, args.overlay)');
    expect(src).toContain('overlay_path=overlay_path');
  });
});

describe('beats are positional, not taken from scene_type', () => {
  it('plans the same overlays whatever scene_type says', () => {
    // scene_type is the render vocabulary (storyboardAgent.ts:277). A project whose
    // scenes are all 'street' must get the same plan as one that is all 'default',
    // or the overlay would move when someone changes a particle preset.
    const a = project(plain);
    const b = project(plain);
    b.scenes.forEach((s: any) => { s.scene_type = 'street'; });
    expect(b.scenes.map((s: any) => planOverlay(s, b, 6)?.kind ?? null))
      .toEqual(a.scenes.map((s: any) => planOverlay(s, a, 6)?.kind ?? null));
  });

  it('puts the payoff on the last beat that speaks, not a trailing silent one', () => {
    // The serialized-universe tease appends a wordless scene; the closing line belongs
    // on the last spoken beat, and the silent one gets nothing.
    const p = project(plain);
    p.scenes.push(scene({ scene_id: 'tease', order: 6, narration_text: '' }));
    expect(planOverlay(p.scenes[6], p, 6)).toBeNull();
    expect(planOverlay(p.scenes[5], p, 6)?.kind).toBe('payoff');
  });
});
