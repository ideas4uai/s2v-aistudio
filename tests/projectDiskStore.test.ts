import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { persistProjectToDisk, restoreProjectsFromDisk, sanitizeStalePaths, deleteProjectFromDisk } from '../src/pipeline/projectDiskStore.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pds-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('persistProjectToDisk', () => {
  it('writes {project_id}.json and leaves no .tmp file behind', () => {
    persistProjectToDisk({ project_id: 'p1', status: 'generating_assets' } as any, dir);
    expect(fs.existsSync(path.join(dir, 'p1.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'p1.json.tmp'))).toBe(false);
  });

  it('persists mid-render projects (no output_path required)', () => {
    persistProjectToDisk({ project_id: 'p2', status: 'generating_assets', scenes: [{ scene_id: 's1', status: 'completed' }] } as any, dir);
    const restored = restoreProjectsFromDisk(dir);
    expect(restored).toHaveLength(1);
    expect(restored[0].project_id).toBe('p2');
    expect(restored[0].status).toBe('generating_assets');
    expect(restored[0].scenes?.[0]?.scene_id).toBe('s1');
  });

  it('is a no-op for projects without a project_id', () => {
    persistProjectToDisk({ status: 'draft' } as any, dir);
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });
});

describe('restoreProjectsFromDisk', () => {
  it('skips corrupt JSON files instead of throwing', () => {
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ not valid json');
    persistProjectToDisk({ project_id: 'ok', status: 'completed' } as any, dir);
    const restored = restoreProjectsFromDisk(dir);
    expect(restored).toHaveLength(1);
    expect(restored[0].project_id).toBe('ok');
  });

  it('returns [] when the directory does not exist', () => {
    expect(restoreProjectsFromDisk(path.join(dir, 'nope'))).toEqual([]);
  });
});

describe('sanitizeStalePaths', () => {
  it('clears local paths whose files are gone, keeps http URLs and existing files', () => {
    const realFile = path.join(dir, 'real.png');
    fs.writeFileSync(realFile, 'x');
    const project: any = {
      project_id: 'p3',
      scenes: [{
        scene_id: 's1',
        segment_path: path.join(dir, 'gone.mp4'),
        background_path: realFile,
        background_url: 'https://example.com/bg.png',
        narration_path: path.join(dir, 'gone.wav'),
        visuals: [{
          asset_path: path.join(dir, 'gone.png'),
          rendered_path: realFile,
          frames: [{ asset_path: path.join(dir, 'gone-frame.png') }],
        }],
      }],
    };
    sanitizeStalePaths(project);
    const scene = project.scenes[0];
    expect(scene.segment_path).toBeUndefined();
    expect(scene.narration_path).toBeUndefined();
    expect(scene.background_path).toBe(realFile);
    expect(scene.background_url).toBe('https://example.com/bg.png');
    expect(scene.visuals[0].asset_path).toBeUndefined();
    expect(scene.visuals[0].rendered_path).toBe(realFile);
    expect(scene.visuals[0].frames[0].asset_path).toBeUndefined();
  });

  it('sanitizes on restore so a rehydrated project regenerates missing artifacts', () => {
    persistProjectToDisk({
      project_id: 'p4',
      status: 'generating_assets',
      scenes: [{ scene_id: 's1', status: 'completed', segment_path: path.join(dir, 'wiped-temp.mp4') }],
    } as any, dir);
    const [restored] = restoreProjectsFromDisk(dir);
    expect((restored.scenes![0] as any).segment_path).toBeUndefined();
  });
});

// DELETE /:id used to go through FirestoreService.getProject, which returns null under
// DISABLE_FIRESTORE=true — so it 404'd and no local project could ever be deleted. The
// route now needs a local delete, and "deleted" has to mean gone from disk, not just a
// 200 response: a record left in outputs/ is restored at the next boot.
describe('deleteProjectFromDisk', () => {
  it('removes the project file', () => {
    persistProjectToDisk({ project_id: 'gone', status: 'completed' } as any, dir);
    expect(fs.existsSync(path.join(dir, 'gone.json'))).toBe(true);

    expect(deleteProjectFromDisk('gone', dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'gone.json'))).toBe(false);
  });

  it('does not come back at the next boot', () => {
    persistProjectToDisk({ project_id: 'keep', status: 'completed' } as any, dir);
    persistProjectToDisk({ project_id: 'gone', status: 'completed' } as any, dir);
    deleteProjectFromDisk('gone', dir);

    const restored = restoreProjectsFromDisk(dir).map((p) => p.project_id);
    expect(restored).toEqual(['keep']);
  });

  it('reports false for a project that was not on disk', () => {
    expect(deleteProjectFromDisk('never-existed', dir)).toBe(false);
  });

  it('leaves other projects alone', () => {
    for (const id of ['a', 'b', 'c']) {
      persistProjectToDisk({ project_id: id, status: 'completed' } as any, dir);
    }
    deleteProjectFromDisk('b', dir);
    expect(restoreProjectsFromDisk(dir).map((p) => p.project_id).sort()).toEqual(['a', 'c']);
  });

  it('clears the stale-write watermark, so a reused id can be written again', () => {
    // The watermark is what makes persist refuse a write when disk looks newer. If it
    // survived the delete, recreating the id would throw StaleProjectWriteError.
    persistProjectToDisk({ project_id: 'reused', status: 'completed' } as any, dir);
    deleteProjectFromDisk('reused', dir);
    fs.writeFileSync(path.join(dir, 'reused.json'), JSON.stringify({ project_id: 'reused' }));

    expect(() => persistProjectToDisk({ project_id: 'reused', status: 'draft' } as any, dir)).not.toThrow();
  });
});
