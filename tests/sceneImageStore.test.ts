import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { storageMode, storeSceneImage } from '../src/services/sceneImageStore.js';
import { FirestoreService } from '../src/server/db/firestore.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('storageMode', () => {
  it('is local only when STORAGE_MODE=local', () => {
    expect(storageMode({ STORAGE_MODE: 'local' } as NodeJS.ProcessEnv)).toBe('local');
  });

  it('defaults to supabase when unset or unrecognized', () => {
    expect(storageMode({} as NodeJS.ProcessEnv)).toBe('supabase');
    expect(storageMode({ STORAGE_MODE: 'LOCAL' } as NodeJS.ProcessEnv)).toBe('supabase');
    expect(storageMode({ STORAGE_MODE: 'disk' } as NodeJS.ProcessEnv)).toBe('supabase');
  });
});

describe('storeSceneImage', () => {
  it('local mode writes under outputs/scene-images and never touches Supabase', async () => {
    vi.stubEnv('STORAGE_MODE', 'local');
    const uploadSpy = vi.spyOn(FirestoreService, 'uploadAsset');
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-img-'));
    const buffer = Buffer.from('fake-jpeg-bytes');

    const result = await storeSceneImage('proj-1', 'scene-1_abc.jpg', buffer, 'image/jpeg', baseDir);

    expect(result).toBe(path.join(baseDir, 'outputs', 'scene-images', 'proj-1', 'scene-1_abc.jpg'));
    expect(fs.readFileSync(result)).toEqual(buffer);
    expect(uploadSpy).not.toHaveBeenCalled();

    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('supabase mode delegates to FirestoreService.uploadAsset', async () => {
    vi.stubEnv('STORAGE_MODE', 'supabase');
    const uploadSpy = vi.spyOn(FirestoreService, 'uploadAsset')
      .mockResolvedValue('https://fake.supabase.co/storage/x.jpg');
    const buffer = Buffer.from('fake-jpeg-bytes');

    const result = await storeSceneImage('proj-1', 'scene-1_abc.jpg', buffer);

    expect(result).toBe('https://fake.supabase.co/storage/x.jpg');
    expect(uploadSpy).toHaveBeenCalledWith('proj-1', 'scene-1_abc.jpg', buffer, 'image/jpeg');
  });
});
