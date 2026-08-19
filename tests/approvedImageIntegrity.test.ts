import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { adoptApprovedImage, repairSceneVisuals } from '../src/pipeline/orchestrator.js';

// An image the user approved in the editor must be the image that renders.
//
// Measured on a real project (e0d0c0b4): 9 images approved at 16:28:03-16:29:35,
// then 9 DIFFERENT images generated at 16:31:49-16:44:19 during the render, with
// visuals[0].asset_path rewritten to the second set. The video shipped images the
// user never saw.
//
// The approval was erased before the assets phase even started. The pre-render
// cleanup clears scene.background_path unconditionally, clears visual.rendered_path
// whenever it is a local path — which is exactly where screen 4 stores the approved
// image under STORAGE_MODE=local — and resets visual.status from 'completed' back to
// 'pending' unless the asset is a .mp4. Its comment claims "generated images
// (asset_path) are kept"; screen 4 writes rendered_path, not asset_path.
//
// scene.image_path survived all of that and was the one field nothing in the render
// ever read. These tests pin it as authoritative.
//
// NOTE: the sibling suite this was meant to extend, tests/approvedScenesIntegrity.ts,
// is not on main — the script/scene half of this work (repairSceneVisuals, commit
// 6965255) is still sitting unmerged on fix/render-integrity-and-region.

let tmp: string;
const approvedFile = () => path.join(tmp, 'approved.jpg');

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'approved-image-'));
  fs.writeFileSync(approvedFile(), Buffer.from('an approved picture'));
});
afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* non-fatal */ }
});

/** A scene as it looks after screen 4, then after the pre-render cleanup has run. */
const sceneAfterCleanup = (over: any = {}) => ({
  scene_id: 's1',
  order: 0,
  narration_text: 'Unseen movement blurs the shot.',
  image_path: approvedFile(),
  // what the cleanup leaves behind: no background, no rendered_path, status reset
  background_path: undefined,
  background_prompt: 'Wide shot of a developer at a desk',
  visuals: [{ visual_id: 'v1', prompt: 'Wide shot of a developer at a desk', status: 'pending', asset_path: undefined, rendered_path: undefined }],
  ...over,
}) as any;

describe('adoptApprovedImage', () => {
  it('makes the approved image the visual asset', () => {
    const s = sceneAfterCleanup();
    expect(adoptApprovedImage(s)).toBe('adopted');
    expect(s.visuals[0].asset_path).toBe(approvedFile());
  });

  it('marks the visual completed so nothing downstream regenerates it', () => {
    // The NARRATOR branch that overwrote asset_path with the freshly generated
    // background sits behind `if (visual.status === 'completed') return`.
    const s = sceneAfterCleanup();
    adoptApprovedImage(s);
    expect(s.visuals[0].status).toBe('completed');
  });

  it('survives the exact state the pre-render cleanup produces', () => {
    // status reset to pending, rendered_path wiped, background_path cleared —
    // the three erasures that let the bug through.
    const s = sceneAfterCleanup();
    expect(s.visuals[0].status).toBe('pending');
    expect(s.background_path).toBeUndefined();
    expect(adoptApprovedImage(s)).toBe('adopted');
    expect(s.visuals[0].asset_path).toBe(approvedFile());
  });

  it('reports "none" for a scene the user never gave an image', () => {
    // Pipeline-created projects must keep generating their own backgrounds.
    const s = sceneAfterCleanup({ image_path: undefined });
    expect(adoptApprovedImage(s)).toBe('none');
    expect(s.visuals[0].asset_path).toBeUndefined();
    expect(s.visuals[0].status).toBe('pending');
  });

  it('reports "missing" rather than silently substituting when the file is gone', () => {
    const s = sceneAfterCleanup({ image_path: path.join(tmp, 'deleted.jpg') });
    expect(adoptApprovedImage(s)).toBe('missing');
    // and it must not have half-applied
    expect(s.visuals[0].asset_path).toBeUndefined();
  });

  it('adopts a remote URL without stat-ing it', () => {
    // Supabase storage puts an http URL here; renderVisualClip downloads it.
    const s = sceneAfterCleanup({ image_path: 'https://example.test/approved.png' });
    expect(adoptApprovedImage(s)).toBe('adopted');
    expect(s.visuals[0].asset_path).toBe('https://example.test/approved.png');
  });

  it('is safe on a scene with no visuals', () => {
    expect(adoptApprovedImage(sceneAfterCleanup({ visuals: [] }))).toBe('none');
    expect(adoptApprovedImage(null)).toBe('none');
  });

  it('is idempotent — re-running a render does not change the answer', () => {
    const s = sceneAfterCleanup();
    expect(adoptApprovedImage(s)).toBe('adopted');
    const first = s.visuals[0].asset_path;
    expect(adoptApprovedImage(s)).toBe('adopted');
    expect(s.visuals[0].asset_path).toBe(first);
  });
});

describe('the render consults the approval', () => {
  const orch = fs.readFileSync(path.join(process.cwd(), 'src/pipeline/orchestrator.ts'), 'utf-8');

  it('adopts before the background gate, not after', () => {
    const adopt = orch.indexOf('const approvedImage = adoptApprovedImage(scene);');
    const gate = orch.indexOf('if (scene.background_prompt && !scene.background_path');
    expect(adopt).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(adopt);
  });

  it('will not generate a background behind an approved image', () => {
    expect(orch).toMatch(/!scene\.background_path && !\(scene as any\)\.unified && approvedImage !== 'adopted'/);
  });

  it('halts by scene name instead of substituting', () => {
    expect(orch).toMatch(/The approved image for \$\{where\} is no longer on disk/);
    expect(orch).toMatch(/stopped rather than generating a different image/);
  });

  it('lets an explicit regenerate revoke the approval', () => {
    // Otherwise adoptApprovedImage hands back the very image the user asked to replace.
    expect(orch).toMatch(/scene\.image_path = undefined;\s*\n\s*scene\.visuals\.forEach/);
    expect(orch).toMatch(/\(scene as any\)\.image_path = undefined;\s*\n\s*visual\.status = 'pending'/);
  });
});

// ── The second mechanism: the whole scene set being discarded ──────────────────
//
// The image guard above only helps if the scene survives to be rendered. On a real
// verification run six scenes with six approved images went into a render and came
// out with scripting AND scene_parsing both re-run, all six scenes replaced, and
// image_path gone from every one — because hasExistingScenes is all-or-nothing on
// `narration_text && visuals[0].prompt`, and generateScenes writes that prompt with
// no alias fallback while background_prompt right above it has three.

describe('repairSceneVisuals', () => {
  const scene = (over: any = {}) => ({
    scene_id: 's1', order: 0, narration_text: 'Movement blurs the shot.',
    visuals: [{ visual_id: 'v1', prompt: '' }], ...over,
  }) as any;

  it('recovers the visual prompt from background_prompt', () => {
    const s = scene({ background_prompt: 'Wide shot of a tripod at dusk' });
    expect(repairSceneVisuals([s])).toBe(1);
    expect(s.visuals[0].prompt).toBe('Wide shot of a tripod at dusk');
  });

  it('recovers it from the camelCase and visual_prompt aliases too', () => {
    const a = scene({ backgroundPrompt: 'A' });
    const b = scene({ visual_prompt: 'B' });
    expect(repairSceneVisuals([a, b])).toBe(2);
    expect(a.visuals[0].prompt).toBe('A');
    expect(b.visuals[0].prompt).toBe('B');
  });

  it('leaves a scene that already has a prompt untouched', () => {
    const s = scene({ visuals: [{ visual_id: 'v1', prompt: 'Already here' }], background_prompt: 'Other' });
    expect(repairSceneVisuals([s])).toBe(0);
    expect(s.visuals[0].prompt).toBe('Already here');
  });

  it('creates the visual when the scene has none but does carry a prompt', () => {
    const s = scene({ visuals: [], background_prompt: 'A quiet room' });
    expect(repairSceneVisuals([s])).toBe(1);
    expect(s.visuals[0].prompt).toBe('A quiet room');
  });

  it('reports nothing repaired when there is genuinely nothing to recover', () => {
    const s = scene();
    expect(repairSceneVisuals([s])).toBe(0);
    expect(s.visuals[0].prompt).toBe('');
  });

  it('turns an all-or-nothing failure into a pass', () => {
    // One empty prompt used to discard the whole set. After repair the test the
    // pipeline runs is satisfied and the approved scenes survive.
    const scenes = [
      scene({ scene_id: 'a', visuals: [{ visual_id: 'v1', prompt: 'has one' }] }),
      scene({ scene_id: 'b', background_prompt: 'recoverable' }),
    ];
    const ok = () => scenes.every((s: any) => s.narration_text && s.visuals?.[0]?.prompt);
    expect(ok()).toBe(false);
    repairSceneVisuals(scenes);
    expect(ok()).toBe(true);
  });

  it('is safe on empty and nullish input', () => {
    expect(repairSceneVisuals([])).toBe(0);
    expect(repairSceneVisuals([null as any])).toBe(0);
    expect(repairSceneVisuals(undefined as any)).toBe(0);
  });
});

describe('the pipeline halts rather than discarding approved work', () => {
  const orch = fs.readFileSync(path.join(process.cwd(), 'src/pipeline/orchestrator.ts'), 'utf-8');

  // These three used to pin a narrower guard — a halt gated on `!hasExistingScenes &&
  // scenes.some(s => s.image_path)` — written when main carried no approved-script fix
  // at all. Merging fix/render-integrity-and-region replaced it with a strictly stronger
  // rule: a project that has scenes is never sent back through scripting, whether or not
  // an image has been approved against it. That covers every case the narrow gate did,
  // so these now assert the merged rule rather than the one it superseded.

  it('repairs before it judges', () => {
    expect(orch.indexOf('const repaired = repairSceneVisuals(project.scenes)'))
      .toBeLessThan(orch.indexOf('if (broken.length) {'));
  });

  it('halts, naming the scenes, when a project with approved work cannot be repaired', () => {
    expect(orch).toMatch(/of them cannot be rendered as they stand/);
    // The sentence spans several template literals, so assert the halves separately.
    expect(orch).toContain('The render stopped instead of rewriting your script');
    // ...and names the approved images, which is the consequence the user cares about.
    expect(orch).toContain('approved image(s).');
  });

  it('guards every project with scenes, not only those carrying approved images', () => {
    // The narrow gate is gone. The halt sits inside the scenes-exist branch, so a
    // project whose script was approved without images is protected too, and the
    // scripting phase below is reachable only for a project with no scenes at all.
    expect(orch).not.toMatch(/!hasExistingScenes && \(project\.scenes \|\| \[\]\)\.some/);
    const branch = orch.indexOf('if ((project.scenes || []).length > 0) {');
    expect(branch).toBeGreaterThan(-1);
    expect(orch.indexOf('if (broken.length) {')).toBeGreaterThan(branch);
  });
});

describe('generateScenes writes a prompt it can actually keep', () => {
  const ctrl = fs.readFileSync(path.join(process.cwd(), 'src/controllers/projectController.ts'), 'utf-8');
  it('falls back through the same aliases background_prompt does', () => {
    expect(ctrl).toMatch(/prompt: s\.visuals\?\.\[0\]\?\.prompt \|\| s\.visual_prompt \|\| s\.background_prompt \|\| s\.backgroundPrompt \|\| ''/);
  });
});
