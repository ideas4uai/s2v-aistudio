import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Durable output: the finished video is copied to cloud storage AFTER the render is
// already complete and already playable from disk.
//
// The bug this replaces uploaded to a bucket named `videos`, which does not exist in this
// Supabase project. Every upload returned "Bucket not found", the error was console.error'd,
// and output_path quietly fell back to the local file — so a render with no off-machine
// copy was indistinguishable from one with a copy. It went unnoticed for three weeks.
//
// So the properties worth pinning are not "does upload work" (that is Supabase's job) but:
// a failure must be recorded on the project, a success must record a URL, and neither may
// be lost to the write race that eats fields patched in after the render finishes.

const uploadAsset = vi.hoisted(() => vi.fn());
const saved = vi.hoisted(() => [] as any[]);
const store = vi.hoisted(() => ({ project: null as any, staleWrites: 0, refuseNext: 0 }));

vi.mock('../src/server/db/firestore.js', () => ({
  FirestoreService: { uploadAsset },
}));

// Stand-in for the disk store's behaviour: it refuses a write built from a copy older
// than what is already persisted, which is exactly how a late-landing URL got dropped.
vi.mock('../src/pipeline/projectDiskStore.js', () => ({
  persistProjectToDisk: (p: any) => {
    if (store.refuseNext > 0) {
      store.refuseNext--;
      store.staleWrites++;
      const err: any = new Error('newer state on disk');
      err.name = 'StaleProjectWriteError';
      throw err;
    }
    store.project = { ...p, __version: (store.project?.__version ?? 0) + 1 };
    saved.push(store.project);
  },
  restoreProjectsFromDisk: () => (store.project ? [store.project] : []),
  getOutputsDir: () => path.join(process.cwd(), 'outputs'),
  markProjectSynced: () => {},
}));

const { uploadFinalVideo, patchProject, saveProjectState, loadProject } =
  await import('../src/pipeline/orchestrator.js');

const PROJECT_ID = 'cloud-backup-test';
let tmpDir: string;
let videoPath: string;

beforeEach(async () => {
  process.env.DISABLE_FIRESTORE = 'true';
  uploadAsset.mockReset();
  saved.length = 0;
  store.project = null;
  store.staleWrites = 0;
  store.refuseNext = 0;

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudbackup-'));
  videoPath = path.join(tmpDir, 'episode.mp4');
  fs.writeFileSync(videoPath, Buffer.alloc(2048, 9));

  await saveProjectState({
    project_id: PROJECT_ID, status: 'completed', scenes: [],
    output_path: videoPath,
    cloud_backup: { status: 'pending', updatedAt: new Date().toISOString() },
  } as any);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('cloud backup — success path', () => {
  it('records the URL and size on the project', async () => {
    uploadAsset.mockResolvedValue('https://example.supabase.co/storage/v1/object/public/aivideogen/x.mp4');

    await uploadFinalVideo(PROJECT_ID, videoPath, 'episode.mp4', 'ffmpeg');

    const p: any = await loadProject(PROJECT_ID);
    expect(p.cloud_backup.status).toBe('uploaded');
    expect(p.cloud_backup.url).toContain('/aivideogen/');
    expect(p.cloud_backup.sizeBytes).toBe(2048);
    expect(p.cloud_backup.error).toBeUndefined();
  });

  it('leaves output_path pointing at the local file, not the cloud URL', async () => {
    uploadAsset.mockResolvedValue('https://example.supabase.co/x.mp4');

    await uploadFinalVideo(PROJECT_ID, videoPath, 'episode.mp4', 'ffmpeg');

    // Playback must not depend on the upload having worked.
    const p: any = await loadProject(PROJECT_ID);
    expect(p.output_path).toBe(videoPath);
  });

  it('does not compress a video that is already under the object limit', async () => {
    uploadAsset.mockResolvedValue('https://example.supabase.co/x.mp4');

    await uploadFinalVideo(PROJECT_ID, videoPath, 'episode.mp4', 'definitely-not-ffmpeg');

    // A bogus ffmpeg binary proves no compression pass was spawned: compressing every
    // render was a whole extra encode for a file that already fits.
    const p: any = await loadProject(PROJECT_ID);
    expect(p.cloud_backup.status).toBe('uploaded');
  });
});

describe('cloud backup — failure path', () => {
  it('records the failure on the project instead of only logging it', async () => {
    uploadAsset.mockRejectedValue(new Error('Bucket not found'));

    await uploadFinalVideo(PROJECT_ID, videoPath, 'episode.mp4', 'ffmpeg');

    const p: any = await loadProject(PROJECT_ID);
    // The exact shape of the three-week outage: this used to be a console line only.
    expect(p.cloud_backup.status).toBe('failed');
    expect(p.cloud_backup.error).toContain('Bucket not found');
    expect(p.cloud_backup.url).toBeUndefined();
  });

  it('never throws, so a failed upload cannot fail the render', async () => {
    uploadAsset.mockRejectedValue(new Error('network down'));
    await expect(uploadFinalVideo(PROJECT_ID, videoPath, 'episode.mp4', 'ffmpeg')).resolves.toBeUndefined();
  });

  it('leaves the local video untouched and the project completed', async () => {
    uploadAsset.mockRejectedValue(new Error('network down'));

    await uploadFinalVideo(PROJECT_ID, videoPath, 'episode.mp4', 'ffmpeg');

    const p: any = await loadProject(PROJECT_ID);
    expect(p.status).toBe('completed');
    expect(fs.existsSync(videoPath)).toBe(true);
    expect(fs.statSync(videoPath).size).toBe(2048);
  });

  it('reports a missing local file rather than uploading nothing', async () => {
    fs.unlinkSync(videoPath);

    await uploadFinalVideo(PROJECT_ID, videoPath, 'episode.mp4', 'ffmpeg');

    const p: any = await loadProject(PROJECT_ID);
    expect(p.cloud_backup.status).toBe('failed');
    expect(p.cloud_backup.error).toContain('local file is gone');
    expect(uploadAsset).not.toHaveBeenCalled();
  });
});

describe('the late-write race', () => {
  it('applies the URL to current state, not to the copy captured at upload time', async () => {
    // The real sequence: the upload starts, the render writes the project again while it
    // is in flight, and only then does the upload land.
    const captured: any = await loadProject(PROJECT_ID);
    await saveProjectState({ ...captured, status: 'completed', quality_score: 100 } as any);

    uploadAsset.mockResolvedValue('https://example.supabase.co/late.mp4');
    await uploadFinalVideo(PROJECT_ID, videoPath, 'episode.mp4', 'ffmpeg');

    const p: any = await loadProject(PROJECT_ID);
    // Both survive: saving `captured` would have rolled quality_score back, or been
    // refused as stale and thrown the URL away.
    expect(p.cloud_backup.url).toContain('late.mp4');
    expect(p.quality_score).toBe(100);
  });

  it('retries against the reloaded copy when a write is refused as stale', async () => {
    const ok = await patchProject(PROJECT_ID, (p: any) => { p.marker = 'applied'; }, 'test');
    expect(ok).toBe(true);

    // Force one refusal, then confirm the patch still lands.
    store.refuseNext = 1;   // disk holds newer state for exactly one write
    const refusalsBefore = store.staleWrites;
    const ok2 = await patchProject(PROJECT_ID, (p: any) => { p.marker = 'second'; }, 'test');
    expect(ok2).toBe(true);
    // Guard against a vacuous test: the retry only means something if a write was refused.
    expect(store.staleWrites).toBeGreaterThan(refusalsBefore);
    const p: any = await loadProject(PROJECT_ID);
    expect(p.marker).toBe('second');
  });
});
