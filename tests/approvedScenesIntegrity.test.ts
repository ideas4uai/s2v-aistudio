import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { repairSceneVisuals, runPipeline, loadProject, saveProjectState } from '../src/pipeline/orchestrator.js';

/**
 * A project with scenes has an approved script, and the render must never rewrite it.
 *
 * The bug this guards: the skip-scripting check required EVERY scene to carry both
 * narration and visuals[0].prompt, and a single scene missing that one field sent the
 * whole project through the scripting phase — which overwrites project.script and
 * project.scenes. A real fifteen-scene script with fifteen generated images came back
 * as eight scenes of the model's own writing, and the original script was overwritten
 * in the same pass, so there was nothing left to compare against.
 */

const APPROVED_SCRIPT = 'Independence came at dawn. The crowds filled the streets. The radio carried the news.';

const scene = (order: number, over: Record<string, unknown> = {}) => ({
  scene_id: `s${order}`,
  order,
  narration_text: `Line ${order}.`,
  status: 'pending',
  stage: 'audio',
  duration_target: 5,
  visuals: [{ visual_id: `v${order}`, prompt: `A wide shot for line ${order}`, asset_type: 'image', status: 'pending' }],
  ...over,
});

describe('repairSceneVisuals', () => {
  it('leaves a scene that already knows its shot alone', () => {
    const scenes = [scene(0), scene(1)];
    expect(repairSceneVisuals(scenes)).toBe(0);
    expect(scenes[0].visuals[0].prompt).toBe('A wide shot for line 0');
  });

  it('backfills an empty prompt from the scene\'s own background prompt', () => {
    // The reachable shape: generateScenes maps `prompt: s.visuals?.[0]?.prompt || ''`
    // with no fallback, while background_prompt beside it has a four-way one.
    const scenes = [scene(0, {
      background_prompt: 'Delhi street at dawn, crowds, 1947',
      visuals: [{ visual_id: 'v0', prompt: '', asset_type: 'image', status: 'pending' }],
    })];
    expect(repairSceneVisuals(scenes)).toBe(1);
    expect(scenes[0].visuals[0].prompt).toBe('Delhi street at dawn, crowds, 1947');
  });

  it('backfills from the legacy flat field the API DTO exposes', () => {
    const scenes = [scene(0, { visual_prompt: 'A flag over the Red Fort', visuals: [] })];
    expect(repairSceneVisuals(scenes)).toBe(1);
    expect(scenes[0].visuals[0].prompt).toBe('A flag over the Red Fort');
  });

  it('invents nothing when the scene knows no shot at all', () => {
    const scenes = [scene(0, { visuals: [{ visual_id: 'v0', prompt: '  ', asset_type: 'image' }] })];
    expect(repairSceneVisuals(scenes)).toBe(0);
    expect(scenes[0].visuals[0].prompt).toBe('  ');
  });
});

describe('the render never rewrites an approved script', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approved-'));
    process.env.OUTPUTS_DIR = dir;
    process.env.DISABLE_FIRESTORE = 'true';
    // Local disk, so the pipeline's cloud-storage probe does not fail the run before
    // it reaches the check under test.
    process.env.STORAGE_MODE = 'local';
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.OUTPUTS_DIR;
    delete process.env.DISABLE_FIRESTORE;
    delete process.env.STORAGE_MODE;
  });

  const projectWith = async (scenes: unknown[], id: string) => {
    const project: any = {
      project_id: id, userId: 'u1', title: 'Independence 1947', topic: 'Independence 1947',
      script: APPROVED_SCRIPT, status: 'draft', projectType: 'educational', mode: 'long',
      settings: { aspectRatio: '16:9', targetLength: '60s' }, scenes,
      created_at: new Date(), updated_at: new Date(), error_log: null,
    };
    await saveProjectState(project);
    return project;
  };

  it('halts, keeping the script and every scene, when a scene cannot be rendered', async () => {
    // One scene of fifteen with no prompt and nothing to salvage it from. The old
    // code took that as licence to rewrite all fifteen.
    const scenes = Array.from({ length: 15 }, (_, i) => scene(i));
    (scenes[7] as any).visuals = [{ visual_id: 'v7', prompt: '', asset_type: 'image', status: 'pending' }];
    const id = 'integrity-halt';
    await projectWith(scenes, id);

    await runPipeline(id);

    const after = await loadProject(id);
    expect(after.status).toBe('failed');
    // The halt names the stage and the scene, in the quality gate's specific-reasons style.
    expect(String(after.error_log)).toMatch(/8 of them cannot be rendered|scene 8 is missing a visual prompt/);
    expect(String(after.error_log)).toMatch(/stopped instead of rewriting your script/);
    // Nothing was rewritten: same script, same scene count, same narration.
    expect(after.script).toBe(APPROVED_SCRIPT);
    expect(after.scenes).toHaveLength(15);
    expect(after.scenes[0].narration_text).toBe('Line 0.');
  }, 120_000);

  it('repairs what it can and only names what it cannot', async () => {
    const scenes = Array.from({ length: 15 }, (_, i) => scene(i));
    // Salvageable: no prompt stored, but the scene states its own background.
    (scenes[3] as any).visuals = [{ visual_id: 'v3', prompt: '', asset_type: 'image', status: 'pending' }];
    (scenes[3] as any).background_prompt = 'A train arriving at Amritsar, 1947';
    // Not salvageable — this is what stops the run, and it stops it here rather than
    // after fifteen scenes of generation.
    (scenes[9] as any).visuals = [{ visual_id: 'v9', prompt: '', asset_type: 'image', status: 'pending' }];
    const id = 'integrity-repair';
    await projectWith(scenes, id);

    await runPipeline(id);

    const after = await loadProject(id);
    expect(after.script).toBe(APPROVED_SCRIPT);
    expect(after.scenes).toHaveLength(15);
    // Repaired in place, from its own text.
    expect(after.scenes[3].visuals[0].prompt).toBe('A train arriving at Amritsar, 1947');
    // Only the genuinely broken one is reported, and only one of them.
    expect(String(after.error_log)).toMatch(/1 of them cannot be rendered/);
    expect(String(after.error_log)).toMatch(/scene 10 is missing a visual prompt/);
    // It never re-entered scripting: that phase replaces scene_ids with `temp-N`.
    expect(after.scenes.every((s: any) => !String(s.scene_id).startsWith('temp-'))).toBe(true);
  }, 120_000);
});
