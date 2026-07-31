import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StudioStore } from '../src/content-studio/store.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-store-'));
  process.env.OUTPUTS_DIR = dir;
  process.env.DISABLE_FIRESTORE = 'true';
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.OUTPUTS_DIR;
  delete process.env.DISABLE_FIRESTORE;
});

describe('StudioStore local mode', () => {
  it('round-trips a document through disk', async () => {
    await StudioStore.save('contentStudioEpisodes', 'e1', { id: 'e1', userId: 'u1', title: 'Pilot' });
    const loaded = await StudioStore.get('contentStudioEpisodes', 'e1');
    expect(loaded.title).toBe('Pilot');
    // The write must actually land on disk — a silent no-op that still returns
    // is exactly the Firestore bug this store exists to avoid.
    expect(fs.existsSync(path.join(dir, 'content-studio', 'contentStudioEpisodes', 'e1.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'content-studio', 'contentStudioEpisodes', 'e1.json.tmp'))).toBe(false);
  });

  it('mirrors ownerId into userId so packages are listable', async () => {
    await StudioStore.save('contentStudioProductionPackages', 'p1', { id: 'p1', ownerId: 'u1' });
    const listed = await StudioStore.list('contentStudioProductionPackages', 'u1');
    expect(listed).toHaveLength(1);
    expect(listed[0].userId).toBe('u1');
  });

  it('lists only the requesting user and survives corrupt files', async () => {
    await StudioStore.save('contentStudioEpisodes', 'mine', { id: 'mine', userId: 'u1' });
    await StudioStore.save('contentStudioEpisodes', 'theirs', { id: 'theirs', userId: 'u2' });
    fs.writeFileSync(path.join(dir, 'content-studio', 'contentStudioEpisodes', 'broken.json'), '{ nope');
    const listed = await StudioStore.list('contentStudioEpisodes', 'u1');
    expect(listed.map((d: any) => d.id)).toEqual(['mine']);
  });

  it('returns null for a missing document and [] for a missing collection', async () => {
    expect(await StudioStore.get('contentStudioEpisodes', 'ghost')).toBeNull();
    expect(await StudioStore.list('contentStudioNothing', 'u1')).toEqual([]);
  });

  it('removes a document', async () => {
    await StudioStore.save('contentStudioKnowledge', 'k1', { id: 'k1', userId: 'u1' });
    await StudioStore.remove('contentStudioKnowledge', 'k1');
    expect(await StudioStore.get('contentStudioKnowledge', 'k1')).toBeNull();
  });

  it('rejects ids that would escape the collection directory', async () => {
    // Ids arrive straight from req.params and become path segments here.
    await expect(StudioStore.get('contentStudioEpisodes', '../../secret')).rejects.toThrow(/Unsafe/);
    await expect(StudioStore.save('contentStudioEpisodes', '..', { id: '..' })).rejects.toThrow(/Unsafe/);
  });
});
