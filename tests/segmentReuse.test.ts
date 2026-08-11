import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { assembleSceneSegment, renderCaptions } from '../src/services/renderService.js';

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

/** A scene the caption stage will act on: it needs a segment and at least one chunk. */
function sceneWith(segmentPath: string) {
  return {
    scene_id: SCENE_ID,
    segment_path: segmentPath,
    caption_text: 'hello',
    caption_chunks: [{ text: 'hello', start: 0, end: 1 }],
    duration_actual: 1,
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

describe('renderCaptions staleness guard', () => {
  it('reuses a captioned file that is newer than its segment', async () => {
    const dir = scopedDir('proj-fresh');
    fs.mkdirSync(dir, { recursive: true });
    const segment = path.join(dir, `${SCENE_ID}_segment.mp4`);
    const captioned = path.join(dir, `${SCENE_ID}_captioned.mp4`);

    fs.writeFileSync(segment, 'segment');
    fs.writeFileSync(captioned, 'captioned');
    // Burned after the segment was assembled, so it matches the current audio.
    const later = new Date(Date.now() + 10_000);
    fs.utimesSync(captioned, later, later);

    expect(await renderCaptions(sceneWith(segment))).toBe(captioned);
  });

  it('does NOT reuse a captioned file older than its segment', async () => {
    const dir = scopedDir('proj-stale');
    fs.mkdirSync(dir, { recursive: true });
    const segment = path.join(dir, `${SCENE_ID}_segment.mp4`);
    const captioned = path.join(dir, `${SCENE_ID}_captioned.mp4`);

    // The exact shape of the bug: a leftover burn-in predating a re-assembled segment.
    fs.writeFileSync(captioned, 'stale caption burn from an older render');
    const earlier = new Date(Date.now() - 600_000);
    fs.utimesSync(captioned, earlier, earlier);
    fs.writeFileSync(segment, 'freshly assembled segment with the new voice');

    // These are not real MP4s, so the re-burn ffmpeg fails and renderCaptions falls back
    // to its input. That is the point: anything but the stale file means the guard fired.
    // Returning `captioned` here is precisely what shipped the wrong audio three times.
    const result = await renderCaptions(sceneWith(segment));
    expect(result).not.toBe(captioned);
    expect(result).toBe(segment);
    // Generous timeout: passing the guard spawns a real ffmpeg, and process startup on a
    // machine that is busy rendering takes well over vitest's 5s default.
  }, 30_000);
});
