import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { persistProjectToDisk, restoreProjectsFromDisk, sanitizeStalePaths } from '../src/pipeline/projectDiskStore.js';

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
