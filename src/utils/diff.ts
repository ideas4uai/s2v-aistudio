import { generateSceneHash } from './hash.js';

/**
 * Which scenes actually need re-rendering.
 *
 * getScenesToRender used to return every scene id unconditionally, so editing one
 * line of narration in an eight-scene project re-rendered all eight. It was also
 * imported but never called — the pipeline cleared every scene's paths on every run
 * regardless, which is what actually forced the full re-render.
 *
 * A scene is re-rendered when its content hash changes. The hash deliberately spans
 * both the scene AND the project settings that change how every scene is drawn: a
 * change to aspect ratio or visual style genuinely invalidates all of them, and
 * scoping that down to "only the edited scene" would ship a video whose scenes do not
 * match each other. Under-invalidating is the far more expensive mistake — it is the
 * silent-stale-output class of bug — so anything not clearly scene-local is treated
 * as global.
 */

/** Project settings that change how EVERY scene is rendered. */
const GLOBAL_RENDER_KEYS = [
  'aspectRatio',
  'exportResolution',
  'exportPreset',
  'visualStyle',
  'motionEffect',
  'targetLength',
  'language',
  'voiceStyle',
  'clonedVoiceId',
] as const;

export function globalRenderSignature(project: any): string {
  const s = project?.settings || {};
  return generateSceneHash(
    GLOBAL_RENDER_KEYS.map((k) => `${k}=${s[k] ?? ''}`).join('|'),
    // A universe's locked art style is global in the same way.
    project?.universe?.artStyle ?? '',
    project?.style_profile ?? '',
    // Draft renders are 720p with no parallax. Without this, a final render after a
    // draft would see every scene as unchanged and ship the draft's cheap segments.
    `draft=${project?.preview_mode ? 1 : 0}`,
  );
}

/**
 * Everything about a scene that changes its rendered output, plus the global
 * signature. Paths and statuses are excluded on purpose — they are results of a
 * render, not inputs to one, and including them would make every scene differ
 * from itself after each run.
 */
export function sceneRenderHash(scene: any, project: any): string {
  const visuals = (scene?.visuals || []).map((v: any) => ({
    prompt: v.prompt ?? '',
    motion: v.motion_instruction ?? '',
    asset: v.asset_path ?? '',
    frames: (v.frames || []).map((f: any) => ({ p: f.prompt ?? '', m: f.motion ?? '', d: f.duration ?? 0 })),
  }));

  return generateSceneHash(
    scene?.narration_text ?? '',
    scene?.caption_text ?? '',
    scene?.character ?? '',
    scene?.emotion ?? '',
    scene?.scene_type ?? '',
    scene?.background_prompt ?? '',
    scene?.duration_target ?? 0,
    scene?.order ?? 0,
    visuals,
    globalRenderSignature(project),
  );
}

/**
 * Scene ids whose rendered output is out of date.
 *
 * `oldScenes` carries the hash recorded when each scene last rendered
 * (scene.render_hash). A scene with no recorded hash has never completed a render
 * and is always included.
 */
export function getScenesToRender(oldScenes: any[], newScenes: any[], project?: any): string[] {
  const previous = new Map<string, string>();
  for (const s of oldScenes || []) {
    if (s?.scene_id && s.render_hash) previous.set(s.scene_id, s.render_hash);
  }

  const proj = project ?? { scenes: newScenes };
  return (newScenes || [])
    .filter((s) => previous.get(s.scene_id) !== sceneRenderHash(s, proj))
    .map((s) => s.scene_id);
}

/** Scene ids present in the previous render but gone from the current project. */
export function getRemovedSceneIds(oldScenes: any[], newScenes: any[]): string[] {
  const live = new Set((newScenes || []).map((s) => s?.scene_id));
  return (oldScenes || []).map((s) => s?.scene_id).filter((id) => id && !live.has(id));
}

export function getDiff(oldObj: any, newObj: any) {
  return {};
}
