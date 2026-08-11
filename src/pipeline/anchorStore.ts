import * as fs from 'fs';

// Character anchors: the first successfully generated image of each character
// in a project. Later scenes pass the anchor as the reference image so the
// character stays visually consistent. The in-run Map resets on every
// runPipeline call, so anchors are also persisted on the project record
// (character_anchors) — that is what keeps a character consistent across
// re-renders and follow-up requests.

export function anchorKey(charName: string, projectId: string): string {
  return charName + '_' + projectId;
}

export function seedAnchorsFromProject(project: any, anchors: Map<string, string>): void {
  const saved = project?.character_anchors as Record<string, string> | undefined;
  if (!saved || !project.project_id) return;
  for (const [name, ref] of Object.entries(saved)) {
    // Supabase URLs are always usable; local temp paths only until the file is wiped
    const usable = /^https?:\/\//i.test(ref) || fs.existsSync(ref);
    if (usable) {
      anchors.set(anchorKey(name, project.project_id), ref);
      console.log('[AnchorStore] Restored anchor for:', name, ref.slice(-50));
    } else {
      delete saved[name];
      console.log('[AnchorStore] Dropped stale local anchor for:', name);
    }
  }
}

export function recordAnchor(project: any, anchors: Map<string, string>, charName: string, ref: string): void {
  anchors.set(anchorKey(charName, project.project_id), ref);
  if (!project.character_anchors) project.character_anchors = {};
  project.character_anchors[charName] = ref;
}

export function anchorSummary(anchors: Map<string, string>): string {
  if (anchors.size === 0) return 'none established';
  return [...anchors.entries()]
    .map(([key, ref]) => `${key.split('_')[0]} → ${ref.slice(-45)}`)
    .join(' | ');
}
