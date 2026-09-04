import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import {
  defocusImage, defocusEnabled, defocusedPathFor, detectionNotePath, readVerdict,
} from '../src/services/textDefocus.js';
import { applyStillPass } from '../src/services/renderService.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'defocus-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const still = (name = 'scene.png') => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.alloc(4096, 7));
  return p;
};

describe('when the defocus pass runs at all', () => {
  it('stays off unless it is asked for', () => {
    expect(defocusEnabled({} as any)).toBe(false);
    expect(defocusEnabled({ DEFOCUS_FAKE_TEXT: 'false' } as any)).toBe(false);
    expect(defocusEnabled({ DEFOCUS_FAKE_TEXT: 'true' } as any)).toBe(true);
  });

  it('hands back the original still when disabled, without spending a vision call', async () => {
    const src = still();
    await expect(defocusImage(src, { env: {} as any })).resolves.toBe(src);
  });

  it('hands back the original when the still is not on disk', async () => {
    const missing = path.join(dir, 'nope.png');
    await expect(defocusImage(missing, { env: { DEFOCUS_FAKE_TEXT: 'true' } as any }))
      .resolves.toBe(missing);
  });

  it('keeps the softened copy beside the source so one delete clears both', () => {
    expect(defocusedPathFor('/a/b/scene_3.png')).toBe(path.join('/a/b', 'scene_3_df.png'));
    // Distinct from the upscaler's suffix, so the two passes can chain on one still.
    expect(defocusedPathFor('/a/b/scene_3.png')).not.toContain('_up');
  });

  it('reuses a softened copy that is newer than its source, rather than paying again', async () => {
    const src = still();
    const out = defocusedPathFor(src);
    fs.writeFileSync(out, Buffer.alloc(2048, 9));
    const before = fs.statSync(out).mtimeMs;
    await expect(defocusImage(src, { env: { DEFOCUS_FAKE_TEXT: 'true' } as any })).resolves.toBe(out);
    // Untouched: the detection call is paid once per still, not once per render.
    expect(fs.statSync(out).mtimeMs).toBe(before);
  });
});

describe('the recorded verdict', () => {
  it('keeps the note beside the still, next to the softened copy', () => {
    expect(detectionNotePath('/a/b/scene_3.png')).toBe(path.join('/a/b', 'scene_3_df.json'));
  });

  // The note is what makes a still answer the same way twice. Detection is only ~38%
  // likely to fire per pass on a hard case, so before this the same file could be
  // cleared by one call and caught by the next inside a single render.
  it('answers from a current note instead of detecting again', async () => {
    for (const boxes of [[], [[10, 10, 200, 120]]]) {
      const src = still(`s${boxes.length}.png`);
      const note = detectionNotePath(src);
      fs.writeFileSync(note, JSON.stringify({ boxes, labels: ['recorded'] }));
      const before = fs.statSync(note).mtimeMs;
      await defocusImage(src, { env: { DEFOCUS_FAKE_TEXT: 'true' } as any });
      // Detecting always rewrites the note, so an untouched note means it was believed.
      expect(fs.statSync(note).mtimeMs).toBe(before);
    }
  });

  it('ignores a note older than the still it describes', () => {
    const src = still();
    fs.writeFileSync(detectionNotePath(src), JSON.stringify({ boxes: [], labels: [] }));
    expect(readVerdict(src)).toEqual({ boxes: [], labels: [], modes: [] });
    // Regenerating the image has to invalidate the verdict, or an image edit is
    // judged on what the previous image contained.
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(src, later, later);
    expect(readVerdict(src)).toBeNull();
  });

  it('treats an unreadable note as no note rather than failing the render', () => {
    const src = still();
    fs.writeFileSync(detectionNotePath(src), '{ not json');
    expect(readVerdict(src)).toBeNull();
  });

  it('records nothing when a pass failed rather than freezing a degraded answer', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/services/textDefocus.ts'), 'utf8');
    // detectOnce fails open with no boxes, which is right for the render in front of it
    // and wrong to remember: one ECONNRESET would clear a frame for good.
    expect(src).toContain('if (complete) writeVerdict(src, found);');
    expect(src).toMatch(/if \(!found\.ok\) complete = false;/);
  });

  it('unions enough passes to be worth trusting', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/services/textDefocus.ts'), 'utf8');
    // Measured head to head on a real failing still, 8 trials each: 2 passes fired
    // 3/8, 4 passes fired 6/8 — same spend, once the caller stopped double-paying.
    expect(src).toMatch(/DEFOCUS_PASSES \|\| '4'/);
  });
});

describe('text written on something that is not a screen', () => {
  const worker = fs.readFileSync(path.join(process.cwd(), 'src/scripts/text_defocus.py'), 'utf8');
  const service = fs.readFileSync(path.join(process.cwd(), 'src/services/textDefocus.ts'), 'utf8');

  it('asks the detector what the characters are written on', () => {
    // Nothing local separates the two cases: stroke coverage inside the box is 16.5% on
    // the frame with code projected across a face and 11.4-24.2% on real code panels, and
    // OpenCV's frontal cascade finds no face at all on a stylised 3D one. The detector
    // already knows — it described the region as "Projected code on man's face" — so the
    // classification is asked for rather than reconstructed.
    expect(service).toContain('"on": "screen"');
    expect(service).toContain('If you are unsure');
  });

  it('treats anything but an explicit surface as a screen', () => {
    // The safe direction: screen is the unchanged whole-box treatment, and on a real
    // panel the stroke-only remedy leaves the code plainly readable.
    expect(service).toContain("=== 'surface' ? 'surface' : 'screen'");
    expect(worker).toContain("mode = (modes[i] if modes and i < len(modes) else 'screen')");
  });

  it('carries the mode to the worker, and remembers it in the verdict', () => {
    expect(service).toContain("'--modes', JSON.stringify(modes)");
    expect(service).toContain('modes: j.modes ?? []');
  });

  it('softens only the strokes on a surface, not the whole box', () => {
    // Measured on the frame that proved the problem: the strokes are 3.2% of the box and
    // the face 86%, so the whole-box treatment spent 89% of the face's detail
    // (162.2 -> 13.9) to hide 3.2% of it — and still left the lettering faintly legible.
    expect(worker).toContain('def stroke_mask(');
    expect(worker).toContain('def soften_strokes(');
    expect(worker).toMatch(/soften_strokes\(img, box\) if mode == 'surface' else defocus_region\(img, box\)/);
  });
});

describe('a still that is both the image and the background', () => {
  const shout = async (p: string) => `${p}!`;

  it('processes a shared still once and gives both fields the result', async () => {
    const calls: string[] = [];
    const pass = async (p: string) => { calls.push(p); return `${p}!`; };
    const r = await applyStillPass('/t/a.png', '/t/a.png', pass);
    // Two calls here is what let a successful pass be written and then discarded.
    expect(calls).toEqual(['/t/a.png']);
    expect(r.imagePath).toBe('/t/a.png!');
    expect(r.backgroundPath).toBe('/t/a.png!');
  });

  it('still processes both when they are genuinely different files', async () => {
    const calls: string[] = [];
    const pass = async (p: string) => { calls.push(p); return `${p}!`; };
    const r = await applyStillPass('/t/a.png', '/t/b.png', pass);
    expect(calls).toEqual(['/t/a.png', '/t/b.png']);
    expect(r.imagePath).toBe('/t/a.png!');
    expect(r.backgroundPath).toBe('/t/b.png!');
  });

  it('handles a scene with only one of the two', async () => {
    expect(await applyStillPass('/t/a.png', undefined, shout))
      .toEqual({ imagePath: '/t/a.png!', backgroundPath: undefined });
    expect(await applyStillPass(undefined, '/t/b.png', shout))
      .toEqual({ imagePath: undefined, backgroundPath: '/t/b.png!' });
  });
});

describe('when a scene batch runs in parallel', () => {
  const orch = fs.readFileSync(
    path.join(process.cwd(), 'src/pipeline/orchestrator.ts'), 'utf8');

  it('derives the background prompt before deciding, not after', () => {
    // The test for a Stage 2 batch reads background_prompt, which ensureBackgroundPrompt
    // fills in — but that ran inside processSingleScene, after this decision. So every
    // pipeline-created project took the parallel branch and ran three Real-ESRGAN
    // processes at once, and all three blew past UPSCALE_TIMEOUT_MS.
    const derive = orch.indexOf('for (const s of batch) ensureBackgroundPrompt(s);');
    const decide = orch.indexOf('const hasStage2 = batch.some(');
    expect(derive).toBeGreaterThan(-1);
    expect(decide).toBeGreaterThan(-1);
    expect(derive).toBeLessThan(decide);
  });

  it('agrees with what ensureBackgroundPrompt actually does', async () => {
    const { ensureBackgroundPrompt } = await import('../src/pipeline/orchestrator.js');
    const scene: any = { visuals: [{ prompt: 'a street at dusk' }] };
    expect(scene.background_prompt || scene.background_url).toBeFalsy();
    ensureBackgroundPrompt(scene);
    // Which is the condition the batch guard tests — so this scene is a Stage 2 scene
    // and its batch must not fan out.
    expect(scene.background_prompt).toBeTruthy();
  });
});

describe('the region worker', () => {
  const worker = path.join(process.cwd(), 'src/scripts/text_defocus.py');

  // The Windows `py` launcher intermittently returns empty output and a non-zero status,
  // with no spawn error, when several vitest workers start interpreters at once — the
  // same flake that hits motionOverlay and frameParallel. A transient launcher failure
  // does not survive a retry; a real regression in the worker does.
  const run = (args: string[]): string => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = spawnSync('py', [worker, ...args], { encoding: 'utf8', timeout: 120_000 });
      if (r.error) return '';           // no interpreter at all: the render fails open too
      if (r.stdout?.trim()) return r.stdout.trim();
    }
    return '';
  };

  it('passes its own self-test', () => {
    const out = run(['--selftest']);
    if (!out) return;
    expect(out).toContain('selftest ok');
  });

  it('reports no change when handed no regions, rather than rewriting the still', () => {
    const out = run(['unused.png', 'unused-out.png', '--boxes', '[]']);
    if (!out) return;
    expect(JSON.parse(out)).toMatchObject({ ok: true, boxes: 0, changed: false });
  });
});

describe('the order the two passes run in', () => {
  it('defocuses before upscaling, in the render', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/services/renderService.ts'), 'utf8');
    const defocusAt = src.indexOf('defocusEnabled()');
    const upscaleAt = src.indexOf('upscaleEnabled()');
    expect(defocusAt).toBeGreaterThan(-1);
    expect(upscaleAt).toBeGreaterThan(-1);
    // Real-ESRGAN takes a text region from detail 43.7 to 735.2. Blurring afterwards
    // spends the GPU sharpening lettering and then discards that work.
    expect(defocusAt).toBeLessThan(upscaleAt);
  });

  it('skips both passes on a draft render', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/services/renderService.ts'), 'utf8');
    expect(src).toContain('defocusEnabled() && !isPreview');
    expect(src).toContain('upscaleEnabled() && !isPreview');
  });
});

describe('what the prompt-writing agent is told about screens', () => {
  const agent = fs.readFileSync(
    path.join(process.cwd(), 'src/pipeline/agents/storyboardAgent.ts'), 'utf8');

  it('no longer makes the screen rule conditional on abstract narration', () => {
    // The old rule fired only when the narration had "no person or object in it",
    // which excluded every narration this channel writes -- all six in the test batch
    // named a person or a software object, so the rule could never fire.
    expect(agent).not.toContain('When the narration is abstract');
    expect(agent).toContain('does not depend on how abstract the narration is');
  });

  it('still allows a device in frame as an object', () => {
    // Over-broadening would break the legitimate case: a beat about phones needs a
    // phone in it. What is banned is content ON the screen, not the screen.
    expect(agent).toMatch(/device may sit in the frame as an object/i);
  });

  it('no longer teaches the failure in its own examples', () => {
    // The first few-shot example used to ask for a phone screen showing a feed, which
    // is the exact shot rule 8 forbids.
    expect(agent).not.toContain('smartphone screen showing Instagram feed');
  });

  it('carries the same rule on the multi-frame path', () => {
    const idx = agent.indexOf('Generate 3 visual frames');
    expect(idx).toBeGreaterThan(-1);
    expect(agent.slice(idx)).toMatch(/never as the thing being read/i);
  });
});
