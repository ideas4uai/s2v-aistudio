import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { assembleSceneSegment } from '../src/services/renderService.js';

// Regression cover for the bug that made three "one TTS engine each" comparison renders
// ship byte-identical audio.
//
// Each render did synthesise its own narration — the WAVs were on disk, with the right
// durations. They never reached the MP4. Two defects stacked:
//
//   1. renderCaptions reused `${scene_id}_captioned.mp4` on existence alone, so a caption
//      burn from a week-old render of the same scene was returned in place of the freshly
//      assembled segment carrying the new voice.
//   2. Those intermediates were keyed on scene_id with no project scoping. Duplicating a
//      project copies its scenes verbatim, ids included, so the copies all pointed at the
//      original's files.
//
// Both are asserted below against the real functions — no mocks, since the bug lived
// entirely in path construction and an fs.existsSync check.

const RENDER_DIR = path.join(os.tmpdir(), 'ais-renderer');
const SCENE_ID = 'seg-reuse-test-scene';
const dirs: string[] = [];

function scopedDir(projectId: string) {
  const d = path.join(RENDER_DIR, projectId);
  dirs.push(d);
  return d;
}

/**
 * A captioned scene, whose single assembly pass writes `${scene_id}_captioned.mp4`.
 *
 * Assembly, caption burn and audio mux are now one ffmpeg call, so the staleness guard
 * that used to sit on the separate caption stage lives on this one output instead. The
 * property under test is unchanged: a burn-in older than the clip it claims to come
 * from must never be handed back.
 */
function sceneWith(visualPath: string) {
  return {
    scene_id: SCENE_ID,
    caption_text: 'hello',
    narration_text: 'hello there',
    duration_target: 1,
    visuals: [{ rendered_path: visualPath }],
  };
}

beforeEach(() => {
  dirs.length = 0;
});

afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('scene segment paths are project-scoped', () => {
  it('gives two projects sharing a scene_id separate render directories', async () => {
    const a = scopedDir('proj-aaaa');
    const b = scopedDir('proj-bbbb');

    // Returns '' (no rendered visual), but only after building its output dir — which is
    // the thing under test. Before the fix both calls landed in the same bare directory.
    const scene = { scene_id: SCENE_ID, visuals: [{}] };
    await assembleSceneSegment(scene, undefined, 'k', undefined, { project_id: 'proj-aaaa' });
    await assembleSceneSegment(scene, undefined, 'k', undefined, { project_id: 'proj-bbbb' });

    expect(fs.existsSync(a)).toBe(true);
    expect(fs.existsSync(b)).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe('captioned segment staleness guard', () => {
  it('reuses a captioned file that is newer than the clip it was burned from', async () => {
    const dir = scopedDir('proj-fresh');
    fs.mkdirSync(dir, { recursive: true });
    const visual = path.join(dir, 'visual.mp4');
    const captioned = path.join(dir, `${SCENE_ID}_captioned.mp4`);

    fs.writeFileSync(visual, 'visual clip');
    fs.writeFileSync(captioned, 'captioned');
    // Burned after the clip was rendered, so it matches the current visual and audio.
    const later = new Date(Date.now() + 10_000);
    fs.utimesSync(captioned, later, later);

    const result = await assembleSceneSegment(
      sceneWith(visual), undefined, 'k', undefined, { project_id: 'proj-fresh' });
    expect(result).toBe(captioned);
  });

  it('leaves the stored segment duration alone when it reuses', async () => {
    const dir = scopedDir('proj-nodrift');
    fs.mkdirSync(dir, { recursive: true });
    const visual = path.join(dir, 'visual.mp4');
    const captioned = path.join(dir, `${SCENE_ID}_captioned.mp4`);
    fs.writeFileSync(visual, 'visual clip');
    fs.writeFileSync(captioned, 'captioned');
    const later = new Date(Date.now() + 10_000);
    fs.utimesSync(captioned, later, later);

    // duration_actual is the length of the assembled SEGMENT, which is shorter than the
    // narration it came from — silenceremove strips the pauses. Probing the raw audio on
    // the reuse path overwrote it with the longer number and nothing ever put it back.
    const scene: any = { ...sceneWith(visual), duration_actual: 6.88 };
    await assembleSceneSegment(scene, undefined, 'k', undefined, { project_id: 'proj-nodrift' });
    expect(scene.duration_actual).toBe(6.88);
  });

  it('does NOT reuse a captioned file older than its visual clip', async () => {
    const dir = scopedDir('proj-stale');
    fs.mkdirSync(dir, { recursive: true });
    const visual = path.join(dir, 'visual.mp4');
    const captioned = path.join(dir, `${SCENE_ID}_captioned.mp4`);

    // The exact shape of the bug: a leftover burn-in predating a re-rendered clip.
    fs.writeFileSync(captioned, 'stale caption burn from an older render');
    const earlier = new Date(Date.now() - 600_000);
    fs.utimesSync(captioned, earlier, earlier);
    fs.writeFileSync(visual, 'freshly rendered clip with the new voice');

    // Not a real MP4, so the single assembly pass fails and falls back to its input.
    // That is the point: anything but the stale file means the guard fired. Returning
    // `captioned` here is precisely what shipped the wrong audio three times.
    const result = await assembleSceneSegment(
      sceneWith(visual), undefined, 'k', undefined, { project_id: 'proj-stale' });
    expect(result).not.toBe(captioned);
    expect(result).toBe(visual);
    // Generous timeout: passing the guard spawns a real ffmpeg, and process startup on a
    // machine that is busy rendering takes well over vitest's 5s default.
  }, 30_000);
});
