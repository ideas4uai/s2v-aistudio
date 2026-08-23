import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { persistProjectToDisk, restoreProjectsFromDisk, deleteProjectFromDisk } from '../src/pipeline/projectDiskStore.js';
import { isTrashed, pruneSelection, filterProjects, statusOptions, ALL_STATUSES } from '../src/utils/projectFilter';

/**
 * Soft delete is a field, and everything else follows from that: the list route splits
 * on isTrashed(), the dashboard prunes its selection with the same predicate, and only
 * DELETE /:id removes anything.
 *
 * The disk half runs against a real temp directory rather than a mock, because the
 * property that matters — a restored project is what was trashed, unchanged — is a
 * property of the round trip through JSON, which a mock would not have.
 */

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soft-del-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/**
 * A project carrying everything a render produces, so the round trip has something to
 * lose.
 *
 * The artifact files are really written. restoreProjectsFromDisk runs
 * sanitizeStalePaths, which clears any artifact path whose file is gone — correct and
 * long-standing behaviour, since a stale path makes the pipeline skip a step it should
 * redo. Pointing the fixture at files that do not exist would test the sanitizer and
 * quietly prove nothing about trash and restore.
 */
const artifact = (name: string) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, name);
  return f;
};

const richProject = (over: any = {}) => ({
  project_id: 'p-rich',
  title: 'Nexus City ep 4',
  topic: 'Nexus City',
  status: 'completed',
  output_path: artifact('p-rich.mp4'),
  script: 'A REST API is how two programs talk.',
  quality_gate: { passed: true, score: 100, checks: [], failures: [], checkedAt: '2026-08-01T00:00:00Z' },
  scenes: [
    { scene_id: 's1', status: 'completed', narration_text: 'one', narration_path: artifact('a.wav'),
      visuals: [{ prompt: 'a street', asset_path: artifact('a.png'), approved: true }] },
    { scene_id: 's2', status: 'completed', narration_text: 'two', narration_path: artifact('b.wav'),
      visuals: [{ prompt: 'a room', asset_path: artifact('b.png'), approved: true }] },
  ],
  ...over,
});

const WHEN = '2026-08-23T10:00:00.000Z';

describe('isTrashed', () => {
  it('reads a timestamp as trashed and anything empty as live', () => {
    expect(isTrashed({ deleted_at: WHEN })).toBe(true);
    expect(isTrashed({ deleted_at: null })).toBe(false);   // what restore writes
    expect(isTrashed({ deleted_at: '' })).toBe(false);
    expect(isTrashed({})).toBe(false);                     // never trashed
    expect(isTrashed(undefined)).toBe(false);
  });
});

describe('trash and restore round trip', () => {
  it('survives the disk round trip with every field intact', () => {
    const live = richProject();
    persistProjectToDisk(live as any, dir);

    persistProjectToDisk({ ...richProject(), deleted_at: WHEN } as any, dir);
    let back = restoreProjectsFromDisk(dir)[0] as any;
    expect(isTrashed(back)).toBe(true);

    persistProjectToDisk({ ...back, deleted_at: null } as any, dir);
    back = restoreProjectsFromDisk(dir)[0] as any;

    expect(isTrashed(back)).toBe(false);
    // The point of soft delete: nothing about the render was touched on the way.
    expect(back.status).toBe('completed');
    expect(back.title).toBe('Nexus City ep 4');
    expect(back.output_path).toBe(live.output_path);
    expect(back.script).toBe(live.script);
    expect(back.quality_gate.score).toBe(100);
    expect(back.scenes).toHaveLength(2);
    expect(back.scenes[1].narration_path).toBe(live.scenes[1].narration_path);
    expect(fs.existsSync(back.scenes[1].narration_path)).toBe(true);
    expect(back.scenes[0].visuals[0].approved).toBe(true);
  });

  it('keeps the status it had rather than inventing one', () => {
    // A failed project that is trashed and restored is still failed. Restore must not
    // quietly promote it, which is why deleted_at is its own field and not a status.
    for (const status of ['failed', 'degraded', 'draft', 'generating_assets']) {
      persistProjectToDisk({ project_id: 'p-' + status, status, deleted_at: WHEN } as any, dir);
    }
    const restored = restoreProjectsFromDisk(dir).map((p: any) => ({ ...p, deleted_at: null }));
    expect(restored.map((p: any) => p.status).sort())
      .toEqual(['degraded', 'draft', 'failed', 'generating_assets']);
  });

  it('trashing is not deleting — the record is still on disk', () => {
    persistProjectToDisk({ project_id: 'p1', status: 'completed', deleted_at: WHEN } as any, dir);
    expect(fs.existsSync(path.join(dir, 'p1.json'))).toBe(true);
    expect(restoreProjectsFromDisk(dir)).toHaveLength(1);
  });

  it('permanent delete does remove the record', () => {
    persistProjectToDisk({ project_id: 'p1', status: 'completed', deleted_at: WHEN } as any, dir);
    expect(deleteProjectFromDisk('p1', dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'p1.json'))).toBe(false);
    expect(restoreProjectsFromDisk(dir)).toHaveLength(0);
  });
});

/**
 * The list route splits one merged array on isTrashed(). Both sources arrive in that
 * array identically, so a split written against it cannot treat them differently — the
 * `source` field exists only so these tests can prove that.
 */
describe('splitting the dual-source list', () => {
  const mixed = [
    { id: 'a', status: 'completed', source: 'local' },
    { id: 'b', status: 'completed', source: 'firestore', deleted_at: WHEN },
    { id: 'c', status: 'failed', source: 'local', deleted_at: '2026-08-23T11:00:00.000Z' },
    { id: 'd', status: 'draft', source: 'firestore' },
    { id: 'e', status: 'completed', source: 'local', deleted_at: null },
  ];
  const live = mixed.filter(p => !isTrashed(p));
  const trash = mixed.filter(p => isTrashed(p));

  it('hides trashed projects from the live list', () => {
    expect(live.map(p => p.id)).toEqual(['a', 'd', 'e']);
  });

  it('trashes local and Firestore records alike', () => {
    expect(trash.map(p => p.id)).toEqual(['b', 'c']);
    expect(new Set(trash.map(p => p.source))).toEqual(new Set(['firestore', 'local']));
    expect(new Set(live.map(p => p.source))).toEqual(new Set(['local', 'firestore']));
  });

  it('every status filter, and "All statuses", is blind to trashed projects', () => {
    expect(filterProjects(live, { status: ALL_STATUSES })).toHaveLength(3);
    expect(filterProjects(live, { status: 'failed' })).toEqual([]);   // c is trashed
    expect(filterProjects(live, { status: 'completed' }).map(p => p.id)).toEqual(['a', 'e']);
    expect(statusOptions(live).map(o => o.value).sort()).toEqual(['completed', 'draft']);
  });

  it('search cannot reach a trashed project either', () => {
    expect(filterProjects(live, { query: 'failed' })).toEqual([]);
  });
});

describe('pruneSelection', () => {
  const visible = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('keeps only what is on screen', () => {
    expect([...pruneSelection(new Set(['a', 'c']), visible)].sort()).toEqual(['a', 'c']);
  });

  it('drops a selection the filter has since hidden', () => {
    // The bug it exists for: tick a completed project, narrow to Failed, hit Delete.
    // Without this the hidden project goes too, off-screen and unannounced.
    expect([...pruneSelection(new Set(['a', 'zzz']), visible)]).toEqual(['a']);
    expect([...pruneSelection(new Set(['x', 'y']), visible)]).toEqual([]);
  });

  it('is empty for an empty view, whatever was selected', () => {
    expect([...pruneSelection(new Set(['a', 'b']), [])]).toEqual([]);
  });

  it('composes with the real filter, so selecting across views never leaks', () => {
    const all = [
      { id: 'a', status: 'completed', title: 'one' },
      { id: 'b', status: 'failed', title: 'two' },
    ];
    const nowShowing = filterProjects(all, { status: 'failed' });
    expect([...pruneSelection(new Set(['a', 'b']), nowShowing)]).toEqual(['b']);
  });

  it('bulk delete acts on the pruned set, never the raw selection', () => {
    const all = [
      { id: 'a', status: 'completed', title: 'keep me' },
      { id: 'b', status: 'failed', title: 'bin me' },
      { id: 'c', status: 'failed', title: 'bin me too' },
    ];
    const stale = new Set(['a', 'b', 'c']);
    const shown = filterProjects(all, { status: 'failed' });
    const willDelete = [...pruneSelection(stale, shown)].sort();
    expect(willDelete).toEqual(['b', 'c']);
    expect(willDelete).not.toContain('a');
  });
});
