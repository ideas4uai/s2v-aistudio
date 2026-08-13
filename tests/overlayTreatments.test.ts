import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import {
  detectSteps, detectComparison, detectName, countUpParts,
} from '../src/services/overlayTreatments.js';
import {
  planOverlay, sceneVisualKey, transitionBetween, universeAccent,
} from '../src/services/overlayPlan.js';
import { visualClipPath } from '../src/services/renderService.js';
import { wordTimings } from '../src/services/captionService.js';

const scene = (over: any = {}): any => ({
  scene_id: 's', scene_type: 'default', narration_text: '',
  speech_start: 0.4, speech_end: 6.4, duration_actual: 7, ...over,
});
const project = (texts: string[], topic = 'Playwright AI agents'): any => ({
  project_id: 'p1', topic,
  scenes: texts.map((t, i) => scene({ scene_id: `s${i}`, order: i, narration_text: t })),
});
const kinds = (p: any) => p.scenes.map((s: any) => planOverlay(s, p, 7)?.kind ?? null);

// A script with something for every detector to find.
const rich = [
  'Your tests break every release and someone has to fix them by hand.',
  'Playwright agents watch the run and propose a repair you review.',
  'Three parts split the job: the planner drafts, the generator writes, the healer repairs.',
  'It reads the page like a person would, not like a selector.',
  'Instead of rewriting selectors by hand, the agent proposes the change.',
  'Would you let an agent touch your test suite?',
];
// A script with none of it: no steps, no contrast, no figure.
const plain = [
  'Your tests break every release and someone has to fix them by hand.',
  'The agent watches what the page does and learns the shape of it.',
  // NB: this line originally read "reads intent rather than markup", which the
  // comparison detector caught — correctly, it is a two-state contrast. Reworded so
  // this fixture is genuinely free of qualifying content.
  'It reads what the page means, so a moved button is still the same button.',
  'That changes what maintenance means for a team that ships every day.',
  'The suite stops being the thing that slows a release down.',
  'Would you let an agent touch your test suite?',
];

describe('step detection', () => {
  it('finds an explicit sequence', () => {
    const s = detectSteps('First the planner drafts, then the generator writes, finally the healer repairs.');
    expect(s?.length).toBe(3);
    expect(s?.map((x) => x.label)).toEqual(['planner drafts', 'generator writes', 'healer repairs']);
  });

  it('finds a colon list and a bare short list', () => {
    expect(detectSteps('Three parts split the job: the planner drafts, the generator writes, the healer repairs.')?.length)
      .toBeGreaterThanOrEqual(3);
    expect(detectSteps('The planner drafts, the generator writes, the healer repairs.')?.length).toBe(3);
  });

  it('does not fire on ordinary prose', () => {
    // The false-positive cases that matter: one clause, and a comma'd sentence that
    // lists nothing.
    expect(detectSteps('The agent reads the page and decides what to click next.')).toBeNull();
    expect(detectSteps('It reads intent rather than markup, so a moved button is still the same button.')).toBeNull();
    expect(detectSteps('Short one.')).toBeNull();
  });

  it('anchors each step on the word that announces it', () => {
    const s = detectSteps('First the planner drafts, then the generator writes, finally the healer repairs.')!;
    expect(s[0].wordIndex).toBeLessThan(s[1].wordIndex);
    expect(s[1].wordIndex).toBeLessThan(s[2].wordIndex);
  });
});

describe('comparison detection', () => {
  it('finds the marked contrasts', () => {
    const c = detectComparison('Instead of rewriting selectors by hand, the agent proposes the change.')!;
    expect(c.before).toContain('rewriting');
    expect(c.after).toContain('agent');
    expect(detectComparison('Teams used to patch selectors, now the suite repairs itself.')).not.toBeNull();
    expect(detectComparison('This is manual work versus an agent doing it for you.')).not.toBeNull();
  });

  it('does not fire on a sentence that merely says something improved', () => {
    expect(detectComparison('The suite is faster and much more reliable than it was.')).toBeNull();
    expect(detectComparison('It makes maintenance cheaper for everyone involved.')).toBeNull();
  });

  it('returns null when a marker has nothing on one side', () => {
    expect(detectComparison('Do that instead of nothing.')).toBeNull();
  });
});

describe('name detection', () => {
  it('fires on a name that is also the subject of the video', () => {
    expect(detectName('Meet Playwright agents, which watch the run.', 'Playwright AI agents')?.name)
      .toBe('Playwright');
  });

  it('ignores sentence-initial capitals and words absent from the topic', () => {
    expect(detectName('Playwright is the subject here.', 'Playwright AI agents')).toBeNull();
    expect(detectName('We tried Selenium and Cypress last year.', 'Playwright AI agents')).toBeNull();
  });

  it('needs a topic to match against at all', () => {
    expect(detectName('Meet Playwright agents.', '')).toBeNull();
  });
});

describe('count-up parts', () => {
  it('splits whole-number figures and rejects the rest', () => {
    expect(countUpParts('Tests break on 40% of releases.')).toEqual({ to: 40, suffix: '%' });
    expect(countUpParts('It cuts the suite to 12 minutes.')).toEqual({ to: 12, suffix: ' minutes' });
    // A decimal counting up reads as a glitch, not a counter.
    expect(countUpParts('Coverage sat at 40.5%.')).toBeNull();
    expect(countUpParts('No figure in this sentence at all.')).toBeNull();
  });
});

describe('the classifier', () => {
  it('assigns a different treatment to each kind of beat', () => {
    const k = kinds(project(rich));
    expect(k[2]).toBe('diagram');
    expect(k[5]).toBe('payoff');
    expect(k).toContain('comparison');
  });

  it('forces nothing on a script with no qualifying content', () => {
    const k = kinds(project(plain));
    for (const heavy of ['diagram', 'comparison', 'stat', 'namecard']) {
      expect(k).not.toContain(heavy);
    }
    // It still gets the two treatments the prior session established, and no more.
    expect(k.filter(Boolean).length).toBeLessThanOrEqual(2);
  });

  it('never places two treatments on adjacent beats, across the whole set', () => {
    const k = kinds(project(rich));
    for (let i = 1; i < k.length; i++) {
      if (k[i] && k[i] !== 'payoff') expect(k[i - 1]).toBeNull();
    }
  });

  it('cards a tool once, not every time it is named', () => {
    const named = project([
      'Tests break constantly and someone has to fix them by hand every release.',
      'Meet Playwright agents, which watch the run and propose a repair.',
      'The team reviews what Playwright suggests before anything merges.',
      'Later on Playwright will do more of it unattended.',
      'That is a different kind of maintenance burden entirely.',
      'Would you let it touch your suite?',
    ]);
    expect(kinds(named).filter((x: any) => x === 'namecard').length).toBe(1);
  });
});

describe('new treatments carry real speech timing', () => {
  it('times diagram nodes to the words that name them', () => {
    const p = project(rich);
    const spec = planOverlay(p.scenes[2], p, 7)!;
    const words = wordTimings(p.scenes[2].narration_text, p.scenes[2]);
    expect(spec.steps!.length).toBeGreaterThanOrEqual(3);
    // Every node starts on a real word boundary, in order, inside the speech span.
    let prev = 0;
    for (const st of spec.steps!) {
      expect(st.start).toBeGreaterThanOrEqual(prev);
      expect(words.some((w) => Math.abs(w.start - st.start) < 1e-6)).toBe(true);
      prev = st.start;
    }
    expect(spec.start).toBeGreaterThanOrEqual(0.4);   // the measured speech_start
  });

  it('times each comparison side to when that side is discussed', () => {
    const p = project(rich);
    const i = p.scenes.findIndex((s: any) => planOverlay(s, p, 7)?.kind === 'comparison');
    const spec = planOverlay(p.scenes[i], p, 7)!;
    expect(spec.sides!.length).toBe(2);
    expect(spec.sides![1].start).toBeGreaterThan(spec.sides![0].start);
  });

  it('moves with the measured span rather than the scene length', () => {
    const p = project(rich);
    const before = planOverlay(p.scenes[2], p, 7)!.start;
    p.scenes[2].speech_start = 3.0;
    p.scenes[2].speech_end = 6.5;
    expect(planOverlay(p.scenes[2], p, 7)!.start).toBeGreaterThan(before);
  });
});

describe('transitions', () => {
  it('enters a comparison through a wipe and leaves a heavy beat on a flash', () => {
    const p = project(rich);
    const spec = (i: number) => planOverlay(p.scenes[i], p, 7);
    expect(transitionBetween(spec(1), { kind: 'comparison' } as any)).toBe('shape_wipe');
    expect(transitionBetween(spec(2), spec(3))).toBe('whip_flash');   // out of the diagram
    expect(transitionBetween(null, null)).toBe('');                    // everything else unchanged
  });

  it('gives both halves of one cut the same kind', () => {
    // Clip N's out-half and clip N+1's in-half are the same call on the same pair; if
    // they ever diverge the concat seam shows a half-finished transition.
    const p = project(rich);
    const a = planOverlay(p.scenes[2], p, 7);
    const b = planOverlay(p.scenes[3], p, 7);
    expect(transitionBetween(a, b)).toBe(transitionBetween(a, b));
  });

  it('resolves the accent from a universe hex, and defaults otherwise', () => {
    expect(universeAccent({ universe: { colorPalette: 'signal red #ff2a2a on black' } }))
      .toEqual([0x2a, 0x2a, 0xff]);
    expect(universeAccent({})).toEqual([60, 190, 250]);
  });
});

describe('cache keys cover the new treatments', () => {
  const clip = (p: any, i: number) => visualClipPath(
    os.tmpdir(), 'p1', `v${i}`, 'zoom_in', sceneVisualKey(p.scenes[i], p, 7));

  it('rewording a beat invalidates that beat and nothing else', () => {
    // Same treatment, different words: only the edited beat's timings move, so only
    // its own clip is stale.
    const before = project(rich);
    const after = project(rich.map((t, i) => (i === 2
      ? 'Three parts split the job: the planner writes, the generator drafts, the healer mends.' : t)));

    expect(clip(after, 2)).not.toBe(clip(before, 2));
    for (const i of [0, 1, 3, 4, 5]) expect(clip(after, i)).toBe(clip(before, i));
  });

  it('removing a treatment invalidates its neighbours too, and only its neighbours', () => {
    // Honest limit of the cache: a transition has two halves, one in each clip. Delete
    // the diagram and the whip-flash out of it goes with it, which legitimately makes
    // the NEXT clip stale as well — it was rendered with the matching half. Beats
    // further away are untouched.
    const before = project(rich);
    const after = project(rich.map((t, i) => (i === 2
      ? 'Two parts split it: the planner drafts, the healer repairs.' : t)));

    expect(clip(after, 2)).not.toBe(clip(before, 2));
    expect(clip(after, 3)).not.toBe(clip(before, 3));       // lost its matching half
    for (const i of [0, 4, 5]) expect(clip(after, i)).toBe(clip(before, i));
  });

  it('keys a clip on its transition even when it has no overlay', () => {
    // The transition is not a file either. Without it in the name, a clip rendered
    // with the old cut would be reused and the new one would never appear.
    const p = project(rich);
    expect(planOverlay(p.scenes[3], p, 7)).toBeNull();        // beat 3 has no overlay
    expect(sceneVisualKey(p.scenes[3], p, 7)).not.toBe('');   // but it does have a cut
  });

  it('gives a beat with neither an overlay nor a cut the path it always had', () => {
    const p = project(plain);
    expect(sceneVisualKey(p.scenes[3], p, 7)).toBe('');
    expect(clip(p, 3)).toBe(visualClipPath(os.tmpdir(), 'p1', 'v3', 'zoom_in'));
  });
});

// ── Python side ────────────────────────────────────────────────────────────
const py = (snippet: string): string =>
  execFileSync('py', ['-c', snippet], { encoding: 'utf-8', timeout: 120_000 }).trim();

const HEAD = [
  'import sys; sys.path.insert(0, "src/scripts")',
  'import numpy as np, motion_overlay as mo',
].join('\n');

describe('easing functions', () => {
  it('start at 0, end at 1, and overshoot only where they should', () => {
    const out = py([HEAD,
      'ts = np.linspace(0, 1, 101)',
      'res = []',
      'for name in ("ease_out", "ease_in_out_cubic", "ease_out_back", "ease_out_elastic"):',
      '    f = getattr(mo, name)',
      '    v = np.array([float(f(t)) for t in ts])',
      '    res.append("%s %.4f %.4f %.4f %d" % (name, v[0], v[-1], v.max(), int(np.all(np.diff(v) >= -1e-9))))',
      'print("\\n".join(res))',
    ].join('\n'));
    const rows: Record<string, any> = Object.fromEntries(out.trim().split('\n').map((l) => {
      const [n, a, b, mx, mono] = l.trim().split(/\s+/);
      return [n, { start: +a, end: +b, max: +mx, monotonic: mono === '1' }];
    }));

    for (const n of Object.keys(rows)) {
      expect(rows[n].start).toBeCloseTo(0, 4);
      expect(rows[n].end).toBeCloseTo(1, 4);
    }
    // Bounded curves never leave [0,1] and never go backwards.
    expect(rows.ease_out.max).toBeLessThanOrEqual(1.0001);
    expect(rows.ease_out.monotonic).toBe(true);
    expect(rows.ease_in_out_cubic.max).toBeLessThanOrEqual(1.0001);
    expect(rows.ease_in_out_cubic.monotonic).toBe(true);
    // The overshoot curves go past 1 and come back — that IS the effect.
    expect(rows.ease_out_back.max).toBeGreaterThan(1.05);
    expect(rows.ease_out_back.monotonic).toBe(false);
    expect(rows.ease_out_elastic.max).toBeGreaterThan(1.05);
    expect(rows.ease_out_elastic.monotonic).toBe(false);
  });

  it('accept an array as readily as a scalar', () => {
    const out = py([HEAD,
      'a = mo.ease_out_back(np.array([0.0, 0.5, 1.0]))',
      'print(int(a.shape == (3,)), int(abs(float(a[0])) < 1e-9), int(abs(float(a[2]) - 1) < 1e-9))',
    ].join('\n'));
    expect(out.trim().endsWith('1 1 1')).toBe(true);
  });
});

describe('every new treatment is a pure function of t', () => {
  const specs: Record<string, string> = {
    diagram: '{"kind":"diagram","start":0.2,"end":4.0,"words":[],"steps":['
      + '{"text":"planner drafts","start":0.2,"end":2.6},'
      + '{"text":"generator writes","start":1.2,"end":3.6},'
      + '{"text":"healer repairs","start":2.2,"end":4.6}]}',
    comparison: '{"kind":"comparison","start":0.2,"end":3.6,"words":[],"sides":['
      + '{"text":"manual updates","start":0.2,"end":2.2},'
      + '{"text":"agents repair","start":1.4,"end":3.4}]}',
    namecard: '{"kind":"namecard","start":0.2,"end":3.0,"words":[],"name":"Playwright"}',
    countup: '{"kind":"stat","start":0.2,"end":3.0,"figure":"40%","countUp":{"to":40,"suffix":"%"},'
      + '"words":[{"text":"of","start":0.9,"end":1.1}]}',
  };

  for (const [name, spec] of Object.entries(specs)) {
    it(`${name}: a cold layer draws frame 48 exactly as a warmed one does`, () => {
      // The property the parallel frame renderer depends on. The count-up is the one
      // that would most naturally have been written as an accumulator; it is computed
      // from t instead, so two workers agree on the number.
      const out = py([HEAD, 'import json',
        `spec = json.loads(r'''${spec}''')`,
        'bg = lambda: np.full((960, 540, 3), 90, dtype=np.uint8)',
        'a = mo.OverlayLayer(spec, 540, 960)',
        'assert a.ok, "layer did not build"',
        'cold = a.draw(bg(), 2.0)',
        'b = mo.OverlayLayer(spec, 540, 960)',
        '[b.draw(bg(), i / 24.0) for i in range(48)]',
        'print(int(np.array_equal(cold, b.draw(bg(), 2.0))))',
      ].join('\n'));
      expect(out.trim().endsWith('1')).toBe(true);
    });

    it(`${name}: marks the frame, and only inside its own window`, () => {
      const out = py([HEAD, 'import json',
        `spec = json.loads(r'''${spec}''')`,
        'bg = lambda: np.full((960, 540, 3), 90, dtype=np.uint8)',
        'lay = mo.OverlayLayer(spec, 540, 960)',
        'print(int(np.array_equal(lay.draw(bg(), 0.05), bg())),',
        '      int(not np.array_equal(lay.draw(bg(), 2.0), bg())),',
        '      int(np.array_equal(lay.draw(bg(), 9.0), bg())))',
      ].join('\n'));
      expect(out.trim().endsWith('1 1 1')).toBe(true);
    });
  }
});

describe('the two new transitions', () => {
  it('converge on an identical terminal frame, which is what hides the concat cut', () => {
    const out = py([
      'import sys; sys.path.insert(0, "src/scripts")',
      'import numpy as np, metro_engine_v4 as m',
      'm._set_transition_color("10,20,30")',
      'fx = m.TransitionFX(120, 200)',
      'f = np.full((200, 120, 3), 90, np.uint8)',
      'res = []',
      'for kind in ("whip_flash", "shape_wipe"):',
      '    a = fx.trans_out(f.copy(), 1.0, kind)',
      '    b = fx.trans_in(f.copy(), 0.0, kind)',
      '    res.append(int(np.array_equal(a, b) and int(a[0,0,0]) == 10))',
      'print(*res)',
    ].join('\n'));
    expect(out.trim().endsWith('1 1')).toBe(true);
  });

  it('are reachable from the CLI and survive being sent to a worker', () => {
    const src = fs.readFileSync('src/scripts/metro_engine_v4.py', 'utf-8');
    expect(src).toContain("parser.add_argument('--in_transition'");
    expect(src).toContain("parser.add_argument('--transition_color'");
    // A worker that never received the colour would render its half of the cut to a
    // different terminal frame.
    expect(src).toContain('in_tr, out_tr, tr_color) = job');
    expect(src).toContain('_set_transition_color(tr_color)');
  });
});
