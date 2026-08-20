import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  applyShotFraming, framingFor, hasOwnFraming, framingDistance, FRAMING_COUNT,
} from '../src/pipeline/shotFraming.js';
import { arcPosition, arcKey, NO_ARC } from '../src/services/colourArc.js';
import { cutawayIndex, sceneVisualKey, planOverlay } from '../src/services/overlayPlan.js';
import { usableAsCutaway } from '../src/services/entityImage.js';

/**
 * Three editorial gaps the reference comparison kept finding, built together:
 * shots that do not read as separate shots, a sourced photograph that only ever got to be
 * a logo on a card, and a grade with no direction across the episode.
 */

// ── 1. Cross-shot visual contrast ────────────────────────────────────────────────────

describe('shot framing', () => {
  const PROMPT = 'A developer at a desk watching an AI assistant suggest code, office, warm light';

  it('only ever appends — every word of the original survives', () => {
    // The whole safety argument. Subject, character description, locked art style and the
    // region context earlier work fought for are all in this string, and none of them may
    // be edited, reordered or dropped to make room for a camera note.
    for (let i = 0; i < 12; i++) {
      const out = applyShotFraming(PROMPT, i);
      expect(out.startsWith(PROMPT)).toBe(true);
      expect(out.slice(PROMPT.length)).toMatch(/^, [a-z]/);
    }
  });

  it('adds framing language and nothing else', () => {
    // What it appends must be about the camera. If a subject noun ever appears here, this
    // has stopped being a framing pass and started rewriting the shot.
    const added = applyShotFraming(PROMPT, 0).slice(PROMPT.length);
    expect(added).toMatch(/shot|close-up|camera|frame|angle|depth of field/);
    expect(added).not.toMatch(/developer|desk|office|assistant|code/);
  });

  it('never gives two consecutive scenes the same framing', () => {
    // The measured failure: adjacent stills framed identically, so the cut had nothing at
    // its boundary for a detector — or an eye — to catch.
    for (let i = 0; i < 20; i++) {
      expect(framingDistance(i, i + 1)).toBeGreaterThan(0);
      expect(framingFor(PROMPT, i)).not.toBe(framingFor(PROMPT, i + 1));
    }
  });

  it('changes shot distance between neighbours, not just wording', () => {
    // Distance is the axis a scene detector measures. Two prompts that differ only in
    // adjectives come back as the same picture.
    const distanceWord = (s: string) =>
      /extreme close-up/.test(s) ? 'xcu' : /close-up/.test(s) ? 'cu'
        : /medium/.test(s) ? 'med' : 'wide';
    for (let i = 0; i < 12; i++) {
      expect(distanceWord(framingFor(PROMPT, i))).not.toBe(distanceWord(framingFor(PROMPT, i + 1)));
    }
  });

  it('leaves a prompt that already chose its own shot alone', () => {
    // A shot the script asked for outranks a positional cycle — the same restraint the
    // overlay planner and the effects layer follow.
    for (const p of [
      'Extreme close-up of a blinking cursor on a dark screen',
      'Wide establishing shot of an open-plan office at dawn',
      'Over-the-shoulder view of a laptop screen',
      'An aerial view of a data centre',
      'Low-angle shot of a server rack',
    ]) {
      expect(hasOwnFraming(p)).toBe(true);
      expect(applyShotFraming(p, 3)).toBe(p);
    }
  });

  it('is deterministic, so a re-render is the same edit', () => {
    expect(applyShotFraming(PROMPT, 7)).toBe(applyShotFraming(PROMPT, 7));
    // ...and the cycle is odd-length, or every other scene would repeat a framing
    expect(FRAMING_COUNT % 2).toBe(1);
  });

  it('does nothing to an empty prompt', () => {
    expect(applyShotFraming('', 0)).toBe('');
    expect(applyShotFraming('   ', 2)).toBe('   ');
  });

  it('is applied only where an image is actually going to be generated', () => {
    // A completed visual is an approved or adopted image. Its prompt is what the editor
    // shows for a picture that already exists, and rewriting it would be the same class of
    // bug the approved-content work exists to prevent.
    const orch = fs.readFileSync(path.join(process.cwd(), 'src/pipeline/orchestrator.ts'), 'utf-8');
    expect(orch).toMatch(/if \(framingIndex >= 0 && scene\.visuals\[0\] && \(scene\.visuals\[0\] as any\)\.status !== 'completed'\)/);
  });
});

// ── 2. B-roll cutaway ────────────────────────────────────────────────────────────────

describe('the B-roll cutaway', () => {
  const scene = (i: number, text: string, over: Record<string, unknown> = {}) => ({
    scene_id: `s${i}`, order: i, narration_text: text,
    duration_target: 5, duration_actual: 5, speech_start: 0.2, speech_end: 4.4,
    visuals: [{ visual_id: `v${i}`, prompt: `shot ${i}` }],
    ...over,
  });

  /** Five beats; only scene 3 names the entity, so only it can card. */
  const project = (over: Record<string, unknown> = {}, sceneOver: Record<string, unknown> = {}) => ({
    project_id: 'p',
    topic: 'Playwright test automation',
    entity_image: {
      image: {
        entity: 'Playwright',
        title: 'File:Playwright team at work.jpg',
        localPath: '/tmp/playwright.svg.png',
        licenseShortName: 'Apache-2.0',
        attributionRequired: true,
        credit: '"Playwright team at work" by Microsoft, Apache-2.0, via Wikimedia Commons',
      },
      rejected: [],
    },
    scenes: [
      scene(0, 'Your test suite takes forty minutes and nobody trusts it.'),
      scene(1, 'One change cut that to four minutes flat.'),
      scene(2, 'The team still writes the same checks by hand each week.'),
      scene(3, 'The team moved everything onto Playwright last spring.', sceneOver),
      scene(4, 'What will you ship with the time you get back?'),
    ],
    ...over,
  });

  it('promotes the one scene the name-card had already licence-checked', () => {
    const p = project();
    expect(planOverlay(p.scenes[3], p, 5)?.kind).toBe('namecard');
    expect(planOverlay(p.scenes[3], p, 5)?.logoPath).toBeTruthy();
    expect(cutawayIndex(p)).toBe(3);
  });

  it('sources nothing itself — there is one licensing path and this is not a second', () => {
    // The rejection rules, the licence table and the credit line all live in entityImage.
    // If this file ever grows its own fetch, that is a second route to the same legal
    // question and the review that caught it should fail here first.
    const plan = fs.readFileSync(path.join(process.cwd(), 'src/services/overlayPlan.ts'), 'utf-8');
    expect(plan).not.toMatch(/fetch\(|https?:\/\/commons|api\.php/);
    const body = plan.slice(plan.indexOf('export function cutawayIndex'));
    expect(body.slice(0, body.indexOf('\n}'))).toMatch(/spec\.logoPath/);
  });

  it('falls back to generated imagery when no safe licensed image exists', () => {
    // The graceful-degradation case: entityImage rejected everything, so no logo, so no
    // card asset, so no cutaway and the scene draws its own picture as before.
    const p = project({ entity_image: { image: null, rejected: [{ title: 'x', license: 'CC BY-SA 4.0', reason: 'ShareAlike' }] } });
    expect(planOverlay(p.scenes[3], p, 5)?.logoPath).toBeFalsy();
    expect(cutawayIndex(p)).toBe(-1);
    expect(cutawayIndex(project({ entity_image: undefined }))).toBe(-1);
  });

  it('will not put a logo on the whole frame', () => {
    // Found on a real render, not reasoned about: the Playwright logo was sourced,
    // licensed and credited correctly, and filled 1920x1080 with a near-black mark on a
    // black field. A brand asset is what the name-card wants and the wrong thing for a
    // cutaway, so the cutaway asks what kind of file it got.
    expect(usableAsCutaway({ title: 'File:Playwright Logo.svg' })).toBe(false);
    for (const t of ['File:Acme wordmark.png', 'File:Foo icon.png', 'File:Bar emblem.jpg',
      'File:Baz favicon.png', 'File:Thing symbol.svg']) {
      expect(usableAsCutaway({ title: t })).toBe(false);
    }
    // ...and a photograph still passes
    expect(usableAsCutaway({ title: 'File:Selenium conference 2019 keynote.jpg' })).toBe(true);
    expect(usableAsCutaway(null)).toBe(false);

    // end to end: the same scene fires on a photograph and degrades on a mark
    expect(cutawayIndex(project())).toBe(3);
    const mark = project();
    (mark.entity_image as any).image.title = 'File:Playwright Logo.svg';
    expect(cutawayIndex(mark)).toBe(-1);
  });

  it('never replaces an image the user approved', () => {
    expect(cutawayIndex(project({}, { image_path: 'C:/approved/scene4.jpg' }))).toBe(-1);
  });

  it('never takes the opening or the closing beat', () => {
    // The hook decides whether anyone stays; the close carries the line the episode is for,
    // and already has the riser resolving into it and the payoff overlay running to its end.
    const opening = project();
    opening.scenes[0].narration_text = 'Playwright rewrote how this team ships software.';
    opening.scenes[3].narration_text = 'The team still writes checks by hand.';
    expect(cutawayIndex(opening)).toBe(-1);

    const closing = project();
    closing.scenes[3].narration_text = 'The team still writes checks by hand.';
    closing.scenes[4].narration_text = 'Would you trust Playwright with your release?';
    expect(cutawayIndex(closing)).toBe(-1);
  });

  it('is at most one per episode', () => {
    const p = project();
    p.scenes[2].narration_text = 'They had already tried Playwright once before.';
    const hits = p.scenes.map((_, i) => cutawayIndex(p) === i).filter(Boolean);
    expect(hits.length).toBeLessThanOrEqual(1);
  });

  it('says nothing on an episode too short to spare a shot', () => {
    const p = project();
    p.scenes = p.scenes.slice(0, 2);
    expect(cutawayIndex(p)).toBe(-1);
  });

  it('is part of the clip cache key, so turning it on invalidates the old clip', () => {
    const p = project();
    expect(sceneVisualKey(p.scenes[3], p, 5)).toMatch(/c$/);
    expect(sceneVisualKey(p.scenes[2], p, 5)).not.toMatch(/c$/);
    // and the same scene without a licensed image keys differently
    const bare = project({ entity_image: { image: null, rejected: [] } });
    expect(sceneVisualKey(bare.scenes[3], bare, 5)).not.toBe(sceneVisualKey(p.scenes[3], p, 5));
  });

  it('is adopted the same way an approved image is, and marks the scene unified', () => {
    // Without `unified` the render drops to the legacy compositor and loses the grade —
    // the exact bug the approved-image merge found.
    const orch = fs.readFileSync(path.join(process.cwd(), 'src/pipeline/orchestrator.ts'), 'utf-8');
    const block = orch.slice(orch.indexOf('const cutaway = cutawayIndex(project);'));
    const body = block.slice(0, block.indexOf('\n  }\n'));
    expect(body).toMatch(/scene\.visuals\[0\]\.status = 'completed';/);
    expect(body).toMatch(/\(scene as any\)\.unified = true;/);
  });
});

// ── 3. Colour arc ────────────────────────────────────────────────────────────────────

describe('the colour arc', () => {
  it('runs 0 to 1 across the episode, in scene order', () => {
    expect(arcPosition(0, 9)).toBe(0);
    expect(arcPosition(8, 9)).toBe(1);
    expect(arcPosition(4, 9)).toBeCloseTo(0.5, 6);
  });

  it('is monotonic, so two scenes never land on the same point', () => {
    const seen = Array.from({ length: 9 }, (_, i) => arcPosition(i, 9));
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
  });

  it('switches itself off where an arc means nothing', () => {
    expect(arcPosition(0, 1)).toBe(NO_ARC);
    expect(arcPosition(-1, 9)).toBe(NO_ARC);
    expect(arcPosition(0, NaN)).toBe(NO_ARC);
    expect(arcKey(NO_ARC)).toBe('');
  });

  it('reaches the engine as an argument and the cache key as a suffix', () => {
    const render = fs.readFileSync(path.join(process.cwd(), 'src/services/renderService.ts'), 'utf-8');
    expect(render).toMatch(/'--arc',\s+String\(opts\.arcPos \?\? NO_ARC\)/);
    expect(render).toMatch(/const arcPos = arcPosition\(sceneIdx, sceneList\.length\)/);
    expect(arcKey(arcPosition(3, 9))).toBe('a38');
  });

  it('is applied AFTER the per-scene emotion grade, not instead of it', () => {
    // Reversed, the emotion grade would re-normalise the drift away and the arc would be
    // a no-op that still cost a pass over every frame.
    const py = fs.readFileSync(path.join(process.cwd(), 'src/scripts/metro_engine_v4.py'), 'utf-8');
    const grade = py.indexOf('frame = apply_emotion_grade(frame, self.emotion, blend)');
    const arc = py.indexOf('frame = apply_colour_arc(frame, self.arc_pos)');
    expect(grade).toBeGreaterThan(-1);
    expect(arc).toBeGreaterThan(grade);
  });

  it('warms and opens the picture across the episode, and is identity when off', () => {
    // The curve itself, exercised in the engine. A mid-grey frame is enough: what matters
    // is the direction of the drift and that it is a drift rather than a normalisation.
    const script = `
import sys, json
sys.path.insert(0, r'${path.join(process.cwd(), 'src/scripts').replace(/\\/g, '\\\\')}')
import numpy as np, metro_engine_v4 as m
f = np.full((8, 8, 3), 128, dtype=np.uint8)
f[0:4, :, 2] = 200   # some red, so saturation has something to act on
f[4:8, :, 0] = 200   # and some blue
o = m.apply_colour_arc(f, 0.0)
c = m.apply_colour_arc(f, 1.0)
n = m.apply_colour_arc(f, -1.0)
print(json.dumps({
  "open_red": float(o[0,0,2]), "close_red": float(c[0,0,2]),
  "open_blue": float(o[7,0,0]), "close_blue": float(c[7,0,0]),
  "off_identical": bool(np.array_equal(n, f)),
  "open_spread": float(np.std(o.astype(float))), "close_spread": float(np.std(c.astype(float))),
}))
`;
    const out = JSON.parse(execFileSync('py', ['-c', script], { encoding: 'utf-8' }).trim());
    expect(out.off_identical).toBe(true);
    // reds warm as the episode runs, blues cool
    expect(out.close_red).toBeGreaterThan(out.open_red);
    expect(out.close_blue).toBeLessThan(out.open_blue);
    // and it opens up rather than flattening — "consistency without contrast is monotony"
    expect(out.close_spread).toBeGreaterThan(out.open_spread);
  }, 130_000);
});
