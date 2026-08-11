import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isFreshOutput, renderVisualClip } from '../src/services/renderService.js';

// Visual-side counterpart to segmentReuse.test.ts.
//
// renderMultiFrameVisual had the same two defects the caption burn did: it reused
// `${visual_id}_multiframe.mp4` on existence alone, and that name carried no project
// scoping, so duplicated projects (which copy visual ids verbatim) collided on one file.
//
// The staleness rule now lives in isFreshOutput and is shared by all three render caches,
// so it is asserted directly rather than three times over.

const RENDER_DIR = path.join(os.tmpdir(), 'ais-renderer');
const made: string[] = [];

function tmpFile(name: string, mtimeOffsetMs = 0): string {
  const p = path.join(RENDER_DIR, name);
  fs.mkdirSync(RENDER_DIR, { recursive: true });
  fs.writeFileSync(p, name);
  if (mtimeOffsetMs) {
    const t = new Date(Date.now() + mtimeOffsetMs);
    fs.utimesSync(p, t, t);
  }
  made.push(p);
  return p;
}

afterEach(() => {
  // Best-effort: these live in the OS temp dir, and on Windows a straggling ffmpeg can
  // still hold a handle. Failing teardown would report a passing assertion as a failure.
  for (const p of made) { try { fs.rmSync(p, { force: true }); } catch { /* leave it to the OS */ } }
  made.length = 0;
});

describe('isFreshOutput', () => {
  it('is false when the output does not exist', () => {
    expect(isFreshOutput(path.join(RENDER_DIR, 'fresh-absent.mp4'))).toBe(false);
  });

  it('is true when the output is newer than every source', () => {
    const src = tmpFile('fresh-src-a.png', -60_000);
    const out = tmpFile('fresh-out-a.mp4');
    expect(isFreshOutput(out, src)).toBe(true);
  });

  it('is false when ANY source is newer than the output', () => {
    const older = tmpFile('fresh-src-b1.png', -60_000);
    const out = tmpFile('fresh-out-b.mp4');
    const newer = tmpFile('fresh-src-b2.png', 60_000);
    // One regenerated still is enough to invalidate a clip built from several.
    expect(isFreshOutput(out, older, newer)).toBe(false);
  });

  it('ignores sources that do not exist locally (http assets, optional inputs)', () => {
    const out = tmpFile('fresh-out-c.mp4');
    expect(isFreshOutput(out, 'https://example.com/remote.png', undefined, null)).toBe(true);
  });
});

describe('multi-frame visual cache is project-scoped', () => {
  it('reuses a fresh clip under the project-scoped name', async () => {
    const a = tmpFile('mf-frame-a.png', -60_000);
    const b = tmpFile('mf-frame-b.png', -60_000);
    // The per-frame clips are the concat's real inputs; both predate the concat here.
    tmpFile('proj-mf_visual_f1.mp4', -60_000);
    tmpFile('proj-mf_visual_f2.mp4', -60_000);
    const scoped = tmpFile('proj-mf_vis-shared_multiframe.mp4');

    const visual = {
      visual_id: 'vis-shared',
      frames: [
        { frame_id: 'f1', asset_path: a, duration: 1 },
        { frame_id: 'f2', asset_path: b, duration: 1 },
      ],
    };

    // Returns immediately from cache — no frame rendering, no ffmpeg, no animator.
    // Before the fix this looked for an UNSCOPED `vis-shared_multiframe.mp4`, missed,
    // and fell through to a real render instead of returning this file.
    const result = await renderVisualClip(visual, { project_id: 'proj-mf' });
    expect(result).toBe(scoped);

    // The unscoped name is what two duplicated projects used to share.
    expect(fs.existsSync(path.join(RENDER_DIR, 'vis-shared_multiframe.mp4'))).toBe(false);
  }, 30_000);

  it('re-renders when a per-frame clip is newer than the concat', async () => {
    // The real-world trigger: one frame's still was regenerated, so its clip was rebuilt,
    // so the concat stitched from it is out of date. Frames here carry no asset_path at
    // all — the shape actually stored in this repo's projects — which is exactly the case
    // a guard on asset_path alone would miss.
    const visual = {
      visual_id: 'vis-stale',
      frames: [{ frame_id: 'g1', duration: 1 }, { frame_id: 'g2', duration: 1 }],
    };
    const concat = tmpFile('proj-st_vis-stale_multiframe.mp4', -60_000);
    tmpFile('proj-st_visual_g1.mp4', -120_000);
    tmpFile('proj-st_visual_g2.mp4');  // rebuilt after the concat

    expect(isFreshOutput(concat,
      path.join(RENDER_DIR, 'proj-st_visual_g1.mp4'),
      path.join(RENDER_DIR, 'proj-st_visual_g2.mp4'),
    )).toBe(false);
    void visual;
  });

  it('gives two projects sharing a visual_id separate cached clips', async () => {
    const a = tmpFile('mf2-frame-a.png', -60_000);
    const one = tmpFile('proj-one_vis-dup_multiframe.mp4');
    const two = tmpFile('proj-two_vis-dup_multiframe.mp4');

    const visual = {
      visual_id: 'vis-dup',
      frames: [
        { frame_id: 'f1', asset_path: a, duration: 1 },
        { frame_id: 'f2', asset_path: a, duration: 1 },
      ],
    };

    // Both are cached, so neither renders. The point is that they resolve to different
    // files: pre-fix, one unscoped name served both and whichever rendered last won.
    expect(await renderVisualClip(visual, { project_id: 'proj-one' })).toBe(one);
    expect(await renderVisualClip(visual, { project_id: 'proj-two' })).toBe(two);
    expect(one).not.toBe(two);
  }, 30_000);
});
