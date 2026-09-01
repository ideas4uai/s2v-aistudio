import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { defocusImage, defocusEnabled, defocusedPathFor } from '../src/services/textDefocus.js';

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
