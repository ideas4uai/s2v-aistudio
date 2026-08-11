import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  persistProjectToDisk,
  restoreProjectsFromDisk,
  markProjectSynced,
  StaleProjectWriteError,
} from '../src/pipeline/projectDiskStore.js';

// Reproduces the 04fa8d80 incident: a remediation script wrote a corrected
// output_path, and ~40 minutes later an orphaned server process — still holding the
// copy it loaded at boot — saved that stale copy over it, silently pointing the project
// back at a week-old video. The local store is last-writer-wins and the second writer
// bound no port, so nothing existed to catch it.

let dir: string;
let PID: string;
// The watermark map is module-level and keyed by project id, so each case needs its
// own id — otherwise a later case inherits an earlier one's sync state.
let seq = 0;

const project = (outputPath: string) => ({
  project_id: PID,
  title: 'Race Test',
  status: 'completed',
  output_path: outputPath,
  scenes: [],
}) as any;

const onDisk = () => JSON.parse(fs.readFileSync(path.join(dir, `${PID}.json`), 'utf-8'));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'race-'));
  PID = `race-test-project-${++seq}`;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('project disk store write race', () => {
  it('blocks a writer whose copy predates what is on disk', () => {
    // Writer A (the orphan) syncs at boot.
    persistProjectToDisk(project('OLD.mp4'), dir);
    markProjectSynced(PID, dir);

    // Writer B (the remediation script) writes the corrected path afterwards.
    const later = new Date(Date.now() + 60_000);
    fs.writeFileSync(path.join(dir, `${PID}.json`), JSON.stringify(project('CORRECTED.mp4')));
    fs.utimesSync(path.join(dir, `${PID}.json`), later, later);

    // Writer A now saves its boot-time copy. This is the exact clobber.
    expect(() => persistProjectToDisk(project('OLD.mp4'), dir)).toThrow(StaleProjectWriteError);
    expect(onDisk().output_path).toBe('CORRECTED.mp4');
  });

  it('lets a process keep writing its own project', () => {
    persistProjectToDisk(project('a.mp4'), dir);
    for (const v of ['b.mp4', 'c.mp4', 'd.mp4']) {
      expect(() => persistProjectToDisk(project(v), dir)).not.toThrow();
    }
    expect(onDisk().output_path).toBe('d.mp4');
  });

  it('allows the first write when nothing is on disk', () => {
    expect(() => persistProjectToDisk(project('first.mp4'), dir)).not.toThrow();
    expect(onDisk().output_path).toBe('first.mp4');
  });

  it('does not block a writer that has never synced (fresh script run)', () => {
    // A script that starts up, reads nothing, and writes should not be locked out —
    // only a writer that demonstrably fell behind is.
    fs.writeFileSync(path.join(dir, `${PID}.json`), JSON.stringify(project('existing.mp4')));
    expect(() => persistProjectToDisk(project('new.mp4'), dir)).not.toThrow();
  });

  it('restoring from disk establishes the watermark', () => {
    persistProjectToDisk(project('v1.mp4'), dir);
    const restored = restoreProjectsFromDisk(dir);
    expect(restored.map((p) => p.project_id)).toContain(PID);

    // Another writer moves ahead...
    const later = new Date(Date.now() + 60_000);
    fs.writeFileSync(path.join(dir, `${PID}.json`), JSON.stringify(project('v2.mp4')));
    fs.utimesSync(path.join(dir, `${PID}.json`), later, later);

    // ...so the restored (now behind) copy must not be written back.
    expect(() => persistProjectToDisk(project('v1.mp4'), dir)).toThrow(StaleProjectWriteError);
  });
});
