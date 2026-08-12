import * as fs from 'fs';
import * as path from 'path';
import type { Project } from '../models/project.js';

// Local-mode disk persistence for project state (DISABLE_FIRESTORE=true).
// Every save writes outputs/{project_id}.json atomically so a crash or server
// restart mid-render resumes from the last stage boundary instead of
// re-running the whole pipeline (each scene re-costs image + TTS API calls).

export function getOutputsDir(): string {
  return process.env.OUTPUTS_DIR || path.join(process.cwd(), 'outputs');
}

/**
 * Disk mtime of the copy this process last wrote or read, per project.
 *
 * Anything newer on disk was put there by a different writer, so our copy is behind.
 */
const lastSeenMtimeMs = new Map<string, number>();

/** Record that `pid`'s on-disk copy is the one this process is in step with. */
export function markProjectSynced(pid: string, dir: string = getOutputsDir()): void {
  try {
    lastSeenMtimeMs.set(pid, fs.statSync(path.join(dir, `${pid}.json`)).mtimeMs);
  } catch { /* not on disk yet — the first write establishes it */ }
}

export class StaleProjectWriteError extends Error {
  constructor(pid: string, public readonly diskMtimeMs: number, ourMtimeMs: number) {
    super(
      `Refusing to overwrite ${pid}.json: it changed on disk at ${new Date(diskMtimeMs).toISOString()}, ` +
      `after this process last synced it at ${new Date(ourMtimeMs).toISOString()}. Another writer ` +
      `(a second server, or a script run outside it) has newer state, and this copy is behind.`
    );
    this.name = 'StaleProjectWriteError';
  }
}

/**
 * Writes the project unless disk already holds a newer copy.
 *
 * The local store is last-writer-wins, and a writer that loaded a project at boot and
 * then sat idle will happily stamp that hours-old copy over newer work. That is not
 * hypothetical: a remediated video's output_path was reverted ~40 minutes later by an
 * orphaned server process still holding its boot-time copy, which silently pointed the
 * project back at a week-old file.
 *
 * A port check cannot catch this — the other writer may be a plain script that binds
 * nothing. Comparing mtimes does, and it costs one stat per save. A process that keeps
 * writing its own project always passes: each write updates its own watermark.
 */
export function persistProjectToDisk(project: Project, dir: string = getOutputsDir()): void {
  const pid = project.project_id;
  if (!pid) return;
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = path.join(dir, `${pid}.json`);

  let diskMtimeMs = 0;
  try { diskMtimeMs = fs.statSync(finalPath).mtimeMs; } catch { /* first write */ }
  const ourMtimeMs = lastSeenMtimeMs.get(pid) ?? 0;
  // Only a *newer* disk copy blocks the write. Equal mtimes are our own last write.
  if (diskMtimeMs > 0 && ourMtimeMs > 0 && diskMtimeMs > ourMtimeMs) {
    throw new StaleProjectWriteError(pid, diskMtimeMs, ourMtimeMs);
  }

  const tmpPath = `${finalPath}.tmp`;
  // Write-then-rename: a crash mid-write must not corrupt the previous good copy.
  fs.writeFileSync(tmpPath, JSON.stringify(project, null, 2));
  fs.renameSync(tmpPath, finalPath);
  lastSeenMtimeMs.set(pid, fs.statSync(finalPath).mtimeMs);
}

/**
 * Removes a project's on-disk state. Returns whether a file was actually there.
 *
 * The watermark has to go with it: if the id were ever reused, a leftover entry would
 * make the next write look like it was overwriting something newer and refuse.
 *
 * Only {pid}.json is removed. Rendered videos, scene images and cached audio are left
 * alone — they live outside this file, several are content-addressed and shared between
 * projects, and deleting a project record is not a request to garbage-collect the disk.
 */
export function deleteProjectFromDisk(pid: string, dir: string = getOutputsDir()): boolean {
  lastSeenMtimeMs.delete(pid);
  try {
    fs.unlinkSync(path.join(dir, `${pid}.json`));
    return true;
  } catch {
    return false;
  }
}

export function restoreProjectsFromDisk(dir: string = getOutputsDir()): Project[] {
  if (!fs.existsSync(dir)) return [];
  const projects: Project[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const proj = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      if (!proj.project_id) continue;
      sanitizeStalePaths(proj);
      // This copy is what disk held at boot; anything newer later is someone else's.
      markProjectSynced(proj.project_id, dir);
      projects.push(proj);
    } catch {
      // Unreadable/partial JSON — skip rather than block startup
    }
  }
  return projects;
}

const SCENE_PATH_FIELDS = [
  'image_path', 'background_path', 'transparent_path', 'narration_path',
  'segment_path', 'captioned_path', 'rendered_path', 'preview_path',
] as const;
const VISUAL_PATH_FIELDS = ['asset_path', 'rendered_path'] as const;

// Clear artifact paths whose files no longer exist (temp dirs are wiped
// between boots). The pipeline regenerates any step whose path field is
// empty; a stale path would instead make it skip the step and fail later.
export function sanitizeStalePaths(project: Project): void {
  const stale = (p?: string) => !!p && !/^https?:\/\//i.test(p) && !fs.existsSync(p);
  for (const scene of project.scenes || []) {
    for (const field of SCENE_PATH_FIELDS) {
      if (stale((scene as any)[field])) (scene as any)[field] = undefined;
    }
    for (const visual of scene.visuals || []) {
      for (const field of VISUAL_PATH_FIELDS) {
        if (stale((visual as any)[field])) (visual as any)[field] = undefined;
      }
      for (const frame of visual.frames || []) {
        if (stale(frame.asset_path)) frame.asset_path = undefined;
      }
    }
  }
}
