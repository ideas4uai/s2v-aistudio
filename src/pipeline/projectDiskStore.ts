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

export function persistProjectToDisk(project: Project, dir: string = getOutputsDir()): void {
  const pid = project.project_id;
  if (!pid) return;
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = path.join(dir, `${pid}.json`);
  const tmpPath = `${finalPath}.tmp`;
  // Write-then-rename: a crash mid-write must not corrupt the previous good copy.
  fs.writeFileSync(tmpPath, JSON.stringify(project, null, 2));
  fs.renameSync(tmpPath, finalPath);
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
