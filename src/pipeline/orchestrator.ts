import { Project, CloudBackup } from '../models/project.js';
import { StyleProfile } from '../models/types.js';
import { Scene, Visual, VisualFrame } from '../models/scene.js';
import { runQualityGate } from '../services/qualityService.js';
import * as fs from 'fs';
import * as path from 'path';
import os from 'os';
import { exec, execSync, spawn } from 'child_process';
import { promisify } from 'util';
import ffmpegStatic from 'ffmpeg-static';

const execAsync = promisify(exec);
const ffmpegPath = ffmpegStatic as string;
import { withRetry } from '../utils/retry.js';
import { v4 as uuidv4 } from 'uuid';
import { fallbackHook, fallbackScript, fallbackSceneGraph } from './fallbacks.js';
import { generateSceneAudio } from '../services/voiceService.js';
import { generateAsset } from '../services/assetService.js';
import { renderVisualClip, validateVisualClip, assembleSceneSegment, stitchScenes, getAudioDuration, visualClipPath } from '../services/renderService.js';
import { generateHash, generateAudioHash, generateVisualHash, generateSceneHash, generateAssetHash } from '../utils/hash.js';
import { getScenesToRender, sceneRenderHash } from '../utils/diff.js';
import { getFromCache } from '../services/cacheService.js';
import { logUserEvent } from '../services/logService.js';
import { buildSceneTimeline } from '../utils/timeline.js';
import { targetLengthSeconds, planScenePadding, MAX_PAD_FACTOR } from '../utils/targetLength.js';
import { projectVideoFileName } from '../utils/filename.js';
import { QuotaService } from '../server/services/quotaService.js';
import { AIService } from '../services/aiService.js';
import { FirestoreService } from '../server/db/firestore.js';
import { storageMode } from '../services/sceneImageStore.js';
import { DirectorAgent } from './agents/directorAgent.js';
import { ScriptwriterAgent } from './agents/scriptwriterAgent.js';
import { StoryboardAgent } from './agents/storyboardAgent.js';
import { WorldAgent } from './agents/worldAgent.js';
import { abortManager } from './abortManager.js';
import { requestContext } from '../server/utils/context.js';
import { persistProjectToDisk, restoreProjectsFromDisk } from './projectDiskStore.js';
import { seedAnchorsFromProject, recordAnchor, anchorSummary } from './anchorStore.js';


const INDIAN_AESTHETIC_SUFFIX = 'South Asian graphic novel illustration style, Hyderabad cyberpunk city 2031, warm terracotta and saffron architecture, teal neon accents, Indian street culture, autorickshaws with holographic overlays, Hindi signage, chai stall neon lights, bold flat colour illustration, Trigger Studio quality, NOT Japanese, NOT manga, NOT Tokyo aesthetic, South Asian urban environment';

function characterHasPortraitAssets(charName: string, project: any): boolean {
  const cutoutChar = charName.toLowerCase();
  const hasPngs = (dir: string) =>
    fs.existsSync(dir) && fs.readdirSync(dir).some((f: string) => f.endsWith('.png'));

  const nameDir = path.join(process.cwd(), 'assets', 'characters', cutoutChar);
  if (hasPngs(nameDir)) {
    return fs.existsSync(path.join(nameDir, 'mouth_closed.png'));
  }
  // Name-based dir exists but no PNGs — resolve UUID dir from universe
  const matchedChar = project?.universe?.characters
    ?.find((c: any) => c.name?.toLowerCase() === cutoutChar);
  if (matchedChar?.id) {
    const uuidDir = path.join(process.cwd(), 'assets', 'characters', matchedChar.id);
    if (hasPngs(uuidDir)) {
      return fs.existsSync(path.join(uuidDir, 'mouth_closed.png'));
    }
  }
  return false;
}

async function downloadFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`downloadFile failed: ${res.status} ${url}`);
  fs.writeFileSync(destPath, Buffer.from(await res.arrayBuffer()));
}

// ============================================================================
// STYLE ENGINE
// ============================================================================

function applyStyleToPrompt(prompt: string, style: StyleProfile): string {
  switch (style) {
    case 'cinematic':
      return `${prompt}, cinematic, dramatic lighting, depth of field, film look, high quality`;
    case 'minimal':
      return `${prompt}, minimal, clean, simple, low clutter, minimalist aesthetic`;
    case 'high-contrast':
      return `${prompt}, high-contrast, bold colors, strong lighting, vivid`;
    case 'documentary':
      return `${prompt}, documentary, realistic, natural tones, candid, high detail`;
    default:
      return prompt;
  }
}

// ============================================================================
// DB PERSISTENCE
// ============================================================================

// Singleton in-memory project store for DISABLE_FIRESTORE=true dev runs.
// Module-level Map persists across requests within a single server process.
const projectMemoryStore = new Map<string, Project>();

// On startup, re-hydrate ALL projects from disk (completed AND mid-render)
// so renders survive server restarts when running without Firestore
// (DISABLE_FIRESTORE=true). Stale local artifact paths are cleared so the
// pipeline regenerates exactly the missing pieces on resume.
if (process.env.DISABLE_FIRESTORE === 'true') {
  for (const _proj of restoreProjectsFromDisk()) {
    projectMemoryStore.set(_proj.project_id!, _proj);
    console.log(`[DB] Restored project ${_proj.project_id} from disk (status: ${_proj.status})`);
  }
}

/**
 * Every project held locally (DISABLE_FIRESTORE=true).
 *
 * The store is seeded from outputs/*.json at boot and rewritten on every save, so it
 * is the same set loadProject() resolves against — which is why these projects open
 * fine by direct URL. They were missing from the dashboard only because the list
 * endpoint queried Firestore and nothing else.
 */
export function listLocalProjects(): Project[] {
  return [...projectMemoryStore.values()];
}

export async function loadProject(project_id: string): Promise<Project> {
  // Check in-memory store first (written by saveProjectState when DISABLE_FIRESTORE=true)
  const memProject = projectMemoryStore.get(project_id);
  if (memProject) {
    console.log(`[DB] Loaded project ${project_id} from in-memory store (scenes: ${memProject.scenes?.length ?? 0})`);
    return memProject;
  }

  const firestoreProject: any = await FirestoreService.getProject(project_id);
  if (!firestoreProject) throw new Error(`Project ${project_id} not found in Firestore`);

  // Backwards compatibility for fields
  return {
     ...firestoreProject,
     topic: firestoreProject.topic || firestoreProject.title,
     mode: firestoreProject.mode || 'long',
     style_profile: firestoreProject.style_profile || 'cinematic',
     pacing_intensity: firestoreProject.pacing_intensity || 'moderate',
     hook_strategy: firestoreProject.hook_strategy || 'default',
  } as Project;
}

/**
 * Persist project state.
 *
 * Returns false when the write was refused because disk already holds newer state.
 * Callers that are patching a single field after the fact — a cloud upload landing
 * long after the render finished — need to know that, or their field is silently
 * dropped. See patchProject, which retries against the reloaded copy.
 */
export async function saveProjectState(project: Project): Promise<boolean> {
  const errorMsg = project.error_log ? ` ErrorLog: ${project.error_log}.` : '';
  console.log(`[DB] Saving project state for ${project.project_id}. Status: ${project.status}.${errorMsg} Scenes count: ${project.scenes?.length || 0}`);

  if (process.env.DISABLE_FIRESTORE === 'true') {
    const pid = project.project_id!;
    projectMemoryStore.set(pid, project);
    console.log(`[DB] DISABLE_FIRESTORE=true — wrote to in-memory store (key: ${pid}, scenes: ${project.scenes?.length ?? 0})`);
    // Persist on EVERY save (not just completion) so a crash or restart
    // mid-render resumes from the last stage boundary instead of losing
    // all per-scene progress held only in memory.
    try {
      persistProjectToDisk(project);
    } catch (e: any) {
      if (e?.name === 'StaleProjectWriteError') {
        // Someone else has newer state. Drop our copy rather than stamp over theirs,
        // and re-seed from disk so this process stops serving the stale version too.
        console.error(`[DB] STALE WRITE BLOCKED — ${e.message}`);
        try {
          const fresh = restoreProjectsFromDisk().find((p) => p.project_id === pid);
          if (fresh) {
            projectMemoryStore.set(pid, fresh);
            console.error(`[DB] Reloaded ${pid} from disk; in-memory copy replaced with the newer one.`);
          }
        } catch (reloadErr: any) {
          console.error(`[DB] Could not reload ${pid} after a blocked write:`, reloadErr?.message);
        }
        return false;
      }
      console.warn(`[DB] Could not persist project JSON:`, e?.message);
    }
    return true;
  }

  try {
     project.updated_at = new Date();
     await FirestoreService.saveProject(project);
     console.log(`[DB] Project state synced to Firestore. Status: ${project.status}`);
     return true;
  } catch (err) {
     console.error(`[DB] Failed to sync project ${project.project_id} to Firestore:`, err);
     return false;
  }
}

/**
 * Apply one field change to whatever the current project state is, and persist it.
 *
 * Not `mutate the object we captured earlier, then save it`. That is how an
 * asynchronous upload loses its own result: by the time it lands the render has written
 * the project several times over, the captured copy is stale, and the disk store refuses
 * the write and throws the new URL away with it. So re-read first, patch, save — and if
 * the write still loses a race, take the reloaded copy and apply the patch to that.
 */
/** Objects above this go through a compression pass first. Supabase's default per-object
 *  ceiling is 50 MB; a normal episode lands well under it, so compressing every render
 *  was a full extra encode paid for nothing. */
const CLOUD_OBJECT_LIMIT_MB = 45;

/**
 * Copy a finished video to cloud storage, in the background.
 *
 * Deliberately started without being awaited, and deliberately not able to fail the
 * render: by the time this runs the project is already complete and the video is already
 * playable from disk. What it must not do is fail quietly. The previous version uploaded
 * to a bucket named `videos`, which does not exist in this project — every upload for
 * three weeks returned "Bucket not found", was written to the console, and left
 * output_path silently pointing at the local file. Nothing in the product ever said so.
 */
export async function uploadFinalVideo(
  projectId: string, localPath: string, fileName: string, ffmpegBin: string,
): Promise<void> {
  const record = (patch: Omit<CloudBackup, 'updatedAt'>) =>
    patchProject(projectId, (p) => {
      p.cloud_backup = { ...patch, updatedAt: new Date().toISOString() };
    }, 'cloud_backup');

  let uploadPath = localPath;
  let compressed = '';
  try {
    if (!fs.existsSync(localPath)) throw new Error(`local file is gone: ${localPath}`);
    const sizeMB = fs.statSync(localPath).size / 1024 / 1024;

    if (sizeMB > CLOUD_OBJECT_LIMIT_MB) {
      compressed = localPath.replace(/\.mp4$/, '_upload.mp4');
      console.log(`[CloudBackup] ${sizeMB.toFixed(1)} MB exceeds ${CLOUD_OBJECT_LIMIT_MB} MB — compressing for upload`);
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(ffmpegBin, [
          '-i', localPath,
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '28',
          '-c:a', 'aac', '-b:a', '128k', '-y', compressed,
        ]);
        proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`compress exit ${code}`))));
        proc.on('error', reject);
      });
      uploadPath = compressed;
    }

    const bytes = fs.statSync(uploadPath).size;
    const started = Date.now();
    // FirestoreService.uploadAsset, not a hand-rolled client: it is the one place that
    // knows the bucket, and the reason the old code was broken is that it guessed.
    const url = await FirestoreService.uploadAsset(
      projectId, fileName, await fs.promises.readFile(uploadPath), 'video/mp4');
    console.log(
      `[CloudBackup] ${projectId}: ${(bytes / 1e6).toFixed(1)} MB in ` +
      `${((Date.now() - started) / 1000).toFixed(1)}s -> ${url.slice(-60)}`);
    await record({ status: 'uploaded', url, sizeBytes: bytes });
  } catch (err: any) {
    const reason = err?.message || String(err);
    // Loud on purpose. The local video is fine and the project stays completed; what is
    // not fine is nobody knowing there is no off-machine copy.
    console.error(
      `[CloudBackup] FAILED for ${projectId}: ${reason}\n` +
      `[CloudBackup] The render is unaffected — the video is at ${localPath} — but there ` +
      `is no cloud copy. Fix the cause and re-run the upload.`);
    await record({ status: 'failed', error: reason });
  } finally {
    if (compressed) fs.promises.unlink(compressed).catch(() => {});
  }
}

export async function patchProject(
  projectId: string, mutate: (project: Project) => void, label = 'patch',
): Promise<boolean> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const current = await loadProject(projectId);
    mutate(current);
    if (await saveProjectState(current)) return true;
    console.warn(`[DB] ${label} for ${projectId} lost a write race (attempt ${attempt}) — retrying against the newer copy`);
  }
  console.error(`[DB] ${label} for ${projectId} could not be persisted; the change is not on disk.`);
  return false;
}

async function parseIntent(project: Project): Promise<Partial<Project>> {
  return {}; // No-op for now
}

export async function generateHook(project: Project): Promise<string> {
  const lang = project!.settings?.language || "English";
  const prompt = `Generate a very catchy hook for a short video about ${project.topic}. Strategy: ${project.hook_strategy}. Keep it under 10 words. Write the hook in ${lang}.`;
  return await AIService.generateText(prompt, { task: 'script' });
}

export async function generateHooks(project: Project): Promise<string[]> {
  const lang = project!.settings?.language || "English";
  const prompt = `Generate 3 catchy hooks for a short video about ${project.topic}. Strategy: ${project.hook_strategy}. Each under 10 words. Output as a bulleted list. Write the hooks in ${lang}.`;
  const text = await AIService.generateText(prompt, { task: 'script' });
  return text.split('\n').filter((l: string) => l.trim()).map((l: string) => l.replace(/^[*-]\s+/, '').trim());
}

async function generateScript(project: Project, hookText: string): Promise<string> {
  const prompt = `Write a short, engaging video script about: ${project.topic}. 
Starting with this hook: "${hookText}".
Format it clearly with narration. Keep it under 45 seconds of speaking time.`;
  return await AIService.generateText(prompt, { task: 'script' });
}

async function buildSceneGraph(rawScript: string, project: Project): Promise<Scene[]> {
  console.log(`[Orchestrator] Building scene graph for: ${project.topic}`);
  
  const prompt = `Break down the following video script into short scenes.
For each scene, provide:
1. Narration text
2. Visual prompt (A highly detailed and specific visual description that DIRECTLY reflects the narration for this scene. Include lighting, camera angle, and subject matter. Do not just repeat the narration, describe its visual representation.)
3. Duration in seconds (usually 3-7 seconds)
4. Order index

Script: ${rawScript}

Output ONLY valid JSON as an array of objects: [{"narration": "", "visual": "", "duration": 5, "order": 0}]`;

  try {
    const rawResult = await AIService.generateText(prompt, { task: 'scenes' });
    const jsonStr = rawResult.replace(/```json|```/g, '').trim();
    const sceneData = JSON.parse(jsonStr);

    return sceneData.map((s: any) => ({
      scene_id: uuidv4(),
      order: s.order,
      scene_type: s.order === 0 ? 'hook' : (s.order === sceneData.length - 1 ? 'cta' : 'build'),
      narration_text: s.narration,
      caption_text: s.narration,
      captions: [],
      caption_chunks: [],
      visuals: [{
        visual_id: uuidv4(),
        prompt: s.visual,
        asset_type: 'ai_image',
        duration_target: s.duration || 5,
        motion_instruction: s.order === 0 ? 'zoom_in' : 'pan_right',
        status: 'pending',
        cache_key: '',
      }],
      duration_target: s.duration || 5,
      duration_actual: null,
      asset_type: 'ai_image',
      motion_instruction: null,
      transition_type: 'hard_cut',
      retry_count: 0,
      fallback_used: false,
      cache_key: '',
      status: 'pending',
      error_log: null,
    }));
  } catch (err) {
    console.warn('[Orchestrator] Failed to generate scene graph via AI, using fallback:', err);
    return fallbackSceneGraph(rawScript, project);
  }
}

async function applyPlatformPreset(scenes: Scene[], project: Project): Promise<Scene[]> {
  return scenes;
}

/**
 * Phase 4C - Step 2A.5: Drift Correction Layer
 * Corrects desync between audio and visuals by adjusting visual durations.
 */
function applyDriftCorrection(scene: Scene): void {
  if (!scene.duration_actual) return;

  const visuals = scene.visuals.filter(v => v.status === 'completed' || v.status === 'degraded');
  if (visuals.length === 0) return;

  const actualDuration = scene.duration_actual;
  const totalTargetDuration = visuals.reduce((sum, v) => sum + v.duration_target, 0);
  const drift = totalTargetDuration - actualDuration;
  const absDrift = Math.abs(drift);

  if (absDrift < 0.2) {
    console.log(`[Drift Correction] Drift is negligible (${drift.toFixed(3)}s). No action.`);
    return;
  }

  if (absDrift <= 1.0) {
    console.log(`[Drift Correction] Stretching/Trimming visuals slightly (drift: ${drift.toFixed(3)}s)`);
    const scale = actualDuration / totalTargetDuration;
    visuals.forEach(v => {
      v.duration_target = Number((v.duration_target * scale).toFixed(3));
    });
  } else {
    if (drift > 1.0) {
      console.log(`[Drift Correction] Major positive drift (${drift.toFixed(3)}s). Trimming visuals.`);
      const scale = actualDuration / totalTargetDuration;
      visuals.forEach(v => {
        v.duration_target = Number((v.duration_target * scale).toFixed(3));
      });
    } else {
      console.log(`[Drift Correction] Major negative drift (${drift.toFixed(3)}s). Stretching visuals.`);
      // If we are significantly short, we stretch proportionally.
      // "Split" logic could be added here if we wanted to duplicate visuals.
      const scale = actualDuration / totalTargetDuration;
      visuals.forEach(v => {
        v.duration_target = Number((v.duration_target * scale).toFixed(3));
      });
    }
  }
}

// ============================================================================
// PIPELINE ORCHESTRATOR
// ============================================================================

export async function runScenePipeline(project_id: string, scene_id: string, options?: { mode?: 'test' | 'production' }): Promise<void> {
  const pipelineKey = `scene-${scene_id}`;
  if (runningPipelines.has(pipelineKey)) {
    console.log(`[Orchestrator] A pipeline is already running for scene ${scene_id}. Skipping.`);
    return;
  }
  runningPipelines.add(pipelineKey);

  try {
    console.log(`[Orchestrator] --- Starting Scene Pipeline for Scene: ${scene_id} ---`);

    // 2. Load Project
    const project = await loadProject(project_id);
    const scene = project.scenes.find(s => s.scene_id === scene_id);
    if (!scene) throw new Error(`Scene ${scene_id} not found in project ${project_id}`);

    // 3. Process Scene
    const voicePreset = 'default_preset'; // Placeholder
    await processSingleScene(scene, project, voicePreset, project.preview_mode || false, options?.mode === 'test');

    // 4. Save State
    await saveProjectState(project);
    console.log(`[Orchestrator] --- Scene Pipeline Finished for Scene: ${scene_id}. Status: ${scene.status} ---`);
  } finally {
    runningPipelines.delete(pipelineKey);
  }
}

async function updateProgress(project: Project, action: string, percent?: number, signal?: AbortSignal) {
  await guardedSaveProjectState(project, signal);

  if (!project.logs) project.logs = [];
  const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  project.logs.push(`[${timestamp}] ${action}`);
  project.current_action = action;
  if (percent !== undefined) project.progress_percent = percent;
  
  // Keep logs at a reasonable size
  if (project.logs.length > 50) project.logs.shift();
  
  console.log(`[Orchestrator Progress] ${project.project_id}: ${action} (${percent || 0}%)`);
  await saveProjectState(project);
}

async function guardedSaveProjectState(project: Project, signal?: AbortSignal) {
  if (signal?.aborted) {
    project.is_cancelled = true;
    project.status = 'cancelled';
    throw new Error('PIPELINE_CANCELLED');
  }
  await saveProjectState(project);
}

// Global map to track running pipelines per project
const runningPipelines = new Set<string>();

export async function runPipeline(project_id: string, options?: { preview?: boolean, mode?: 'test' | 'production' }): Promise<void> {
  const characterAnchors = new Map<string, string>();
  console.log('[Orchestrator] runPipeline called for:', project_id);
  if (runningPipelines.has(project_id)) {
    console.log(`[Orchestrator] A pipeline is already running for project ${project_id}. Skipping.`);
    return;
  }

  // Kill orphaned Python subprocesses from a previous run that crashed or was restarted.
  // Without this, old py.exe workers consume CPU and starve new rembg/metro processes.
  try {
    execSync('taskkill /F /IM py.exe /T', { stdio: 'ignore' });
    console.log('[Orchestrator] Killed orphaned py.exe processes');
  } catch {
    // No Python processes were running — normal case
  }

  runningPipelines.add(project_id);
  let project: Project | undefined;
  const signal = abortManager.getOrCreate(project_id);

  try {
    const isPreview = options?.preview === true;
    const isTestMode = options?.mode === 'test';
    
    // 1. Load Project
    const loadedProject = await loadProject(project_id);
    if (!loadedProject) throw new Error(`Project ${project_id} not found`);
    // renderService decides draft behaviour from project.preview_mode (720p instead of
    // 1080p, ultrafast x264, and now no depth parallax) — but nothing ever set that
    // field, so every one of those branches was unreachable and a "preview" render
    // cost exactly as much as a final one. Carry the option onto the project.
    (loadedProject as any).preview_mode = isPreview;
    project = loadedProject;

    // If project has a universeId but not the embedded universe object, load it now
    if ((project as any).universeId && !(project as any).universe) {
      try {
        const universe = await FirestoreService.getDocument('universes', (project as any).universeId);
        if (universe) {
          (project as any).universe = universe;
          console.log('[Orchestrator] Loaded universe by ID:', (project as any).universeId);
        }
      } catch (e: any) {
        console.warn('[Orchestrator] Failed to load universe by ID:', e?.message);
      }
    }

    // Restore character anchors persisted by a previous run so characters
    // stay visually consistent across re-renders and follow-up requests
    // (the Map above is per-run and starts empty on every call).
    seedAnchorsFromProject(project, characterAnchors);

    // Allow re-runs from any terminal state — reset to draft so path-clearing runs
    if (project.status === 'completed' || project.status === 'cancelled' || project.status === 'failed') {
      console.log(`[Orchestrator] Resetting project ${project.project_id} from '${project.status}' to 'draft' for re-run.`);
      project.status = 'draft';
      project.error_log = null;
    }

    // Which scenes actually changed since their last successful render. Everything
    // below clears a scene's rendered output so it is rebuilt; doing that to every
    // scene meant a one-line narration edit re-rendered the whole project. Scenes
    // whose content and the project's global render settings are both unchanged keep
    // their existing output and are skipped.
    //
    // Fail safe, not fast: a scene is re-rendered unless it is provably unchanged.
    const staleSceneIds = new Set(
      getScenesToRender(project.scenes || [], project.scenes || [], project),
    );
    const unchangedCount = (project.scenes || []).length - staleSceneIds.size;
    if (unchangedCount > 0) {
      console.log(
        `[Orchestrator] Incremental re-render: ${staleSceneIds.size} scene(s) changed, ` +
        `${unchangedCount} unchanged and will reuse their existing output.`,
      );
    }

    // Clear stale paths from previous runs — HTTP URLs and local files that no longer exist
    for (const scene of project.scenes || []) {
      // Unchanged scene with its rendered segment still on disk: leave it alone.
      if (!staleSceneIds.has(scene.scene_id)
          && (scene as any).segment_path
          && !String((scene as any).segment_path).startsWith('http')
          && fs.existsSync((scene as any).segment_path)) {
        scene.status = 'completed';
        continue;
      }
      if ((scene as any).rendered_path?.startsWith('http')) (scene as any).rendered_path = undefined;
      if ((scene as any).segment_path?.startsWith('http')) (scene as any).segment_path = undefined;
      if ((scene as any).captioned_path?.startsWith('http')) (scene as any).captioned_path = undefined;
      if ((scene as any).narration_path?.startsWith('http')) (scene as any).narration_path = undefined;
      // Always clear local render paths so animator reruns with correct audio duration.
      // Cached TTS audio (narration_path) and generated images (asset_path) are kept.
      if ((scene as any).segment_path && !(scene as any).segment_path.startsWith('http')) {
        (scene as any).segment_path = undefined;
      }
      if ((scene as any).rendered_path && !(scene as any).rendered_path.startsWith('http')) {
        (scene as any).rendered_path = undefined;
      }
      if ((scene as any).captioned_path && !(scene as any).captioned_path.startsWith('http')) {
        (scene as any).captioned_path = undefined;
      }
      // Clear local Stage 2 paths — they won't survive a server restart.
      // Keep background_url (Supabase) so the pipeline re-downloads instead of regenerating.
      scene.background_path = undefined;
      scene.transparent_path = undefined;
      // Reset status so batch filter includes this scene in processing.
      if (scene.status === 'completed') {
        scene.status = 'pending';
      }
      // Reset image visuals to pending so LoRA generates a fresh character.
      if (scene.visuals) {
        for (const v of scene.visuals) {
          // Clear local .mp4 intermediate (rendered by compositor last run — not an asset to preserve).
          if ((v as any).rendered_path && !(v as any).rendered_path.startsWith('http')) {
            (v as any).rendered_path = undefined;
          }
          // Clear HTTP URLs from both fields (promoted Supabase image, stale generateSceneImage result).
          if ((v as any).rendered_path?.startsWith('http')) (v as any).rendered_path = undefined;
          if ((v as any).asset_path?.startsWith('http')) (v as any).asset_path = undefined;
          // Now reset status. Only preserve visuals whose asset_path is a local video file
          // (e.g. stock footage downloaded in a prior run — those are worth keeping).
          const keepAsVideo = v.asset_path?.endsWith('.mp4') && !v.asset_path.startsWith('http');
          if (v.status === 'completed' && !keepAsVideo) {
            v.status = 'pending';
            // Delete the cached compositor output so renderVisualClip re-runs with the new character
            const cachedMp4 = path.join(os.tmpdir(), 'ais-renderer', `${project_id}_visual_${(v as any).visual_id}.mp4`);
            if (fs.existsSync(cachedMp4)) {
              try { fs.unlinkSync(cachedMp4); } catch { /* non-fatal */ }
              console.log('[Orchestrator] Deleted cached compositor output:', path.basename(cachedMp4));
            }
            console.log('[Orchestrator] Reset visual to pending for re-generation:', (v as any).visual_id || (v as any).id);
          }
        }
      }
    }
    console.log('[Orchestrator] Cleared local render paths and Stage 2 paths — will re-render all visual clips');

    // Reset cancellation if starting fresh
    project.is_cancelled = false;
    project.logs = [];
    await updateProgress(project, 'Initializing pipeline...', 5, signal);

    // --- PHASE 0: Storage Connectivity Probe ---
    if (!isTestMode && storageMode() === 'local') {
      console.log('[Orchestrator] STORAGE_MODE=local — skipping cloud storage probe');
    } else if (!isTestMode) {
      try {
        await updateProgress(project, 'Testing cloud connectivity...', 7, signal);
        const probeData = Buffer.from(`probe-${Date.now()}`);
        await FirestoreService.uploadAsset(project_id, '.probe.txt', probeData, 'text/plain');
        console.log(`[Orchestrator] Storage probe successful for ${project_id}`);
        console.log(`[Orchestrator] Starting scene processing pipeline...`);
        console.log('[Orchestrator] Scene count:', project.scenes?.length);
        console.log('[Orchestrator] First scene:', JSON.stringify(project.scenes?.[0]?.scene_id));
      } catch (probeErr: any) {
        console.error(`[Orchestrator] Storage connectivity probe failed for ${project_id}:`, probeErr);
        project.status = 'failed';
        project.error_log = `Storage Connectivity Error: ${probeErr.message}. Please ensure SUPABASE_URL and SUPABASE_SERVICE_KEY are set and the "aivideogen" bucket exists in your Supabase project.`;
        await saveProjectState(project);
        throw new Error(`STORAGE_PROBE_FAILED: ${probeErr.message}`);
      }
    }

    console.log('[Orchestrator] Signal aborted?', signal.aborted);
    console.log('[Orchestrator] Project status from DB:', project.status);
    if (signal.aborted) throw new Error('PIPELINE_CANCELLED');

    // If the project already has scenes with narration + visual prompts, skip AI scripting entirely
    const hasExistingScenes = (project.scenes || []).length > 0
      && project.scenes.every((s: any) => s.narration_text && s.visuals?.[0]?.prompt);

    if (
      hasExistingScenes &&
      (project.status === 'draft' || project.status === 'pending' ||
       project.status === 'scripting' || project.status === 'scene_parsing')
    ) {
      console.log(`[Orchestrator] ${project.scenes.length} existing scenes with visual prompts — skipping scripting and scene_parsing, jumping to generating_assets`);
      project.status = 'generating_assets';
      await guardedSaveProjectState(project, signal);
    }

    // Status Transitions (only reached when no existing scenes)
    if (project.status === 'draft' || project.status === 'pending') {
      project.status = 'scripting';
      await guardedSaveProjectState(project, signal);
    }
    
    if (project.status === 'scripting') {
      console.log(`[Orchestrator] Phase: scripting — calling DirectorAgent.planVideo`);
      await updateProgress(project, 'AI is drafting the script and visual direction...', 10, signal);
      const directorPlan = await withRetry(() => DirectorAgent.planVideo(project!), { retries: 2 });
      console.log(`[Orchestrator] DirectorAgent.planVideo complete`);
      console.log(`[Orchestrator] Phase: scripting — calling ScriptwriterAgent.writeScript`);
      await updateProgress(project, 'Refining narrative structure...', 15, signal);
      const { rawScript, scenes: drafts } = await withRetry(() => ScriptwriterAgent.writeScript(project!, directorPlan), { retries: 2 });
      console.log(`[Orchestrator] ScriptwriterAgent.writeScript complete, ${drafts.length} draft scenes`);
      project.script = rawScript;
      
      console.log(`[Orchestrator] Phase: scripting — calling WorldAgent.analyzeWorld`);
      await updateProgress(project, 'Identifying world entities for consistency...', 20, signal);
      project.world_entities = await WorldAgent.analyzeWorld(project, rawScript);
      console.log(`[Orchestrator] WorldAgent.analyzeWorld complete`);
      
      // Store drafts temporally in scenes with pending status
      project.scenes = drafts.map((d: any, idx: number) => ({
         scene_id: `temp-${idx}`,
         order: d.order || idx,
         narration_text: d.narration,
         visuals: [{ prompt: d.visual, asset_type: 'ai_image' }]
      } as any));

      project.status = 'scene_parsing';
      await guardedSaveProjectState(project, signal);
    }

    if (project.status === 'scene_parsing') {
      console.log(`[Orchestrator] Phase: scene_parsing — calling StoryboardAgent.expandVisuals`);
      await updateProgress(project, 'Breaking script into visual scenes...', 30, signal);
      const directorPlan = { character_consistency: project.character_description || 'N/A', pacing: project.pacing_intensity, scene_count: project.scenes?.length || 5 };
      
      // Re-map from the temporary scenes we saved
      const drafts = (project.scenes || []).map((s: any) => ({
         order: s.order,
         narration: s.narration_text,
         visual: s.visuals?.[0]?.prompt || ''
      }));

      await updateProgress(project, 'Expanding visual prompts for image generation...', 35, signal);
      const scenes = await withRetry(() => StoryboardAgent.expandVisuals(project!, directorPlan as any, drafts), { retries: 2 });
      console.log(`[Orchestrator] StoryboardAgent.expandVisuals complete, ${scenes.length} scenes`);
      project.scenes = scenes;
      project.status = 'generating_assets';
      await guardedSaveProjectState(project, signal);
    }

    if (project.status === 'generating_assets') {
      await updateProgress(project, 'Generating AI assets (Images & Audio)...', 40, signal);
      
      const scenesToProcess = project.scenes.filter(s => {
        if (s.status === 'degraded') return false;
        if (s.status !== 'completed') return true;
        // Completed but segment missing or file gone — must re-process
        const seg = (s as any).segment_path;
        return !seg || !fs.existsSync(seg);
      });
      
      // Process in small batches to preserve CPU and respect rate limits
      const batchSize = 3; 
      for (let i = 0; i < scenesToProcess.length; i += batchSize) {
        if (signal.aborted) throw new Error('PIPELINE_CANCELLED');
        const batch = scenesToProcess.slice(i, i + batchSize);
        const progress = 40 + Math.floor((i / scenesToProcess.length) * 40);
        await updateProgress(project, `Processing scene batch ${Math.floor(i/batchSize) + 1} of ${Math.ceil(scenesToProcess.length/batchSize)}...`, progress, signal);
        
        const processScene = async (scene: Scene) => {
          if (signal.aborted) throw new Error('PIPELINE_CANCELLED');
          const sceneIndex = project!.scenes.indexOf(scene) + 1;
          const totalScenes = project!.scenes.length;
          console.log(`[Orchestrator] Processing scene ${sceneIndex} of ${totalScenes} (${scene.scene_id})`);
          scene.status = 'processing';
          await guardedSaveProjectState(project!, signal);
          try {
            await processSingleScene(scene, project!, 'default_preset', isPreview, isTestMode, signal, characterAnchors);
            console.log(`[Orchestrator] Scene ${sceneIndex} of ${totalScenes} complete`);
          } catch (e) {
            if (e instanceof Error && e.message === 'PIPELINE_CANCELLED') throw e;
            console.error(`Scene ${scene.scene_id} failed:`, e);
            scene.status = 'failed';
            // Keep the real reason on the scene — without it the only thing the API
            // and UI ever see is the generic "asset generation failed", which tells
            // the user nothing they can act on (e.g. "voice model not installed").
            scene.error_log = e instanceof Error ? e.message : String(e);
          }
          // Explicitly sync mutated fields back to project.scenes to guard against
          // reference drift (e.g. assembleSceneSegment returning undefined overwrites segment_path).
          const idx = project!.scenes.findIndex(s => s.scene_id === scene.scene_id);
          if (idx !== -1) {
            (project!.scenes[idx] as any).segment_path = (scene as any).segment_path;
            project!.scenes[idx].status = scene.status;
            (project!.scenes[idx] as any).rendered_path = (scene as any).rendered_path;
            // Carry the reason too, or the failure that runPipeline reports back to the
            // UI is always the generic phase message with no cause attached.
            (project!.scenes[idx] as any).error_log = (scene as any).error_log;
          }
        };

        // Stage 2 scenes (have a background — prompt or pre-supplied URL) spawn rembg + Metro engine —
        // running those concurrently starves CPU. Force sequential for any batch
        // that contains at least one Stage 2 scene.
        const hasStage2 = batch.some(s => (s as any).background_prompt || (s as any).background_url);
        if (hasStage2) {
          console.log('[Orchestrator] Stage 2 batch — processing sequentially to avoid CPU starvation');
          for (const scene of batch) {
            await processScene(scene);
          }
        } else {
          await Promise.all(batch.map(processScene));
        }

        // Persist per-scene progress after each batch so a crash or restart
        // resumes from here instead of re-running every scene.
        await guardedSaveProjectState(project, signal);

        // Small delay between batches
        if (i + batchSize < scenesToProcess.length) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      console.log('[Orchestrator] Character anchor summary:', anchorSummary(characterAnchors));

      const allAssetsSuccess = project.scenes.every(s => s.status === 'completed' || s.status === 'degraded');

      if (!allAssetsSuccess) {
         await validateProjectAssets(project, signal, characterAnchors);
      }
      
      const finalCheckSuccess = project.scenes.every(s => s.status === 'completed' || s.status === 'degraded');

      if (finalCheckSuccess) {
         project.status = 'stitching_video';
         await guardedSaveProjectState(project, signal);
      } else {
         project.status = 'failed';
         await guardedSaveProjectState(project, signal);
         // Surface the first real scene error rather than only the generic phase
         // message — this string is what lands in project.error_log and the UI.
         const firstReason = project.scenes.find(s => s.status === 'failed' && s.error_log)?.error_log;
         throw new Error(
           firstReason
             ? `Asset generation phase failed for some scenes. First error: ${firstReason}`
             : "Asset generation phase failed for some scenes."
         );
      }
    }

    if (project.status === 'stitching_video') {
       await updateProgress(project, 'Stitching scenes together into final video...', 85, signal);
       console.log('[DEBUG] project object id check:',
         project.scenes[0]?.scene_id,
         'segment_path:', (project.scenes[0] as any)?.segment_path,
         'status:', project.scenes[0]?.status
       );
       await concatFinalVideo(project_id, isPreview, signal, project);

       if (signal.aborted) throw new Error('PIPELINE_CANCELLED');

       // Reload from Firestore — concatFinalVideo saves status='completed' and output_path
       // on its own local copy; without this reload the stale local project would overwrite both.
       const finalState = await loadProject(project_id);
       project.status = finalState.status;
       project.output_path = finalState.output_path;
       project.quality_score = finalState.quality_score;

       await updateProgress(project, 'Video generation complete!', 100, signal);
    }

  } catch (error) {
    if (project) {
      if (error instanceof Error && (error.message === 'PIPELINE_CANCELLED' || error.name === 'AbortError')) {
        console.log(`[Orchestrator] Pipeline cancelled for project ${project_id}`);
        project.status = 'cancelled';
        project.is_cancelled = true;
        project.current_action = 'Pipeline cancelled by user.';
        project.progress_percent = 0;
      } else {
        console.error(`[Orchestrator] Pipeline failed for project ${project_id}:`, error);
        project.status = 'failed';
        project.error_log = String(error);
        project.current_action = `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
      // Unconditional save to reflect the failure/cancellation status
      await saveProjectState(project);
    }
  } finally {
    runningPipelines.delete(project_id);
    abortManager.remove(project_id);
  }
}


export async function processSingleScene(scene: Scene, project: Project, voicePreset: string, isPreview: boolean, isTestMode: boolean, signal?: AbortSignal, characterAnchors: Map<string, string> = new Map()) {
  // Check for cancellation at start of scene
  if (signal?.aborted) throw new Error('PIPELINE_CANCELLED');

  // Stamp neighbour scene types so Metro V4 can render its half of each
  // cross-scene transition (clips are stitched with concat -c copy, so each
  // clip must self-contain its side of the boundary).
  {
    const ordered = [...project.scenes].sort((a, b) => a.order - b.order);
    const sIdx = ordered.findIndex(s => s.scene_id === scene.scene_id);
    (scene as any).prev_scene_type = sIdx > 0 ? ((ordered[sIdx - 1] as any).scene_type || '') : '';
    (scene as any).next_scene_type = (sIdx >= 0 && sIdx < ordered.length - 1) ? ((ordered[sIdx + 1] as any).scene_type || '') : '';
  }

  scene.stage = 'audio_and_visuals';
  // Recomputed every run, never "only if absent". Caching the hash on first write and
  // then skipping TTS on file existence alone meant an edited script kept the narration
  // recorded from the text it replaced: the scene was correctly marked stale, the video
  // was re-encoded, and the words never changed — measured, the WAV came back
  // byte-identical after the script was replaced wholesale. The hash covers text, voice
  // preset and character, which is exactly "is the audio on disk the audio this wants".
  const audioHash = generateAudioHash(scene.narration_text, voicePreset, (scene as any).character);
  // Reuse only audio we can prove came from THIS text. A different hash, no hash at all,
  // or a missing file all mean re-synthesise. That is not expensive: the synthesisers are
  // content-addressed too (cachePathFor), so unchanged text is a cache hit rather than a
  // second run of the model. Re-synthesising is also what keeps generateSceneAudio — which
  // stamps duration_actual with the RAW narration length — off the reuse path, where
  // assembleSceneSegment returns early and would leave that wrong number in place.
  const audioFresh = scene.audio_hash === audioHash
     && !!scene.narration_path
     && !scene.narration_path.startsWith('http')
     && fs.existsSync(scene.narration_path);
  if (!audioFresh && scene.audio_hash !== undefined && scene.audio_hash !== audioHash) {
     console.log(`[Orchestrator] Narration changed for scene ${scene.scene_id} — re-synthesising`);
  }
  scene.audio_hash = audioHash;

  const audioPromise = (async () => {
     if (!audioFresh) {
        console.log(`[Orchestrator] Generating audio for scene ${scene.scene_id}`);
        // ownerUid rides along with the settings so the TTS layer can check that a
        // cloned voice belongs to whoever owns this project. Cloned voices are
        // owner-only, and the render is the last place that can be enforced.
        const voiceSettings = { ...project.settings, ownerUid: (project as any).userId };
        const audioLocal = await withRetry(() => generateSceneAudio(scene, voicePreset, scene.audio_hash!, voiceSettings), { retries: 2 });
        console.log(`[Orchestrator] Audio complete for scene ${scene.scene_id}: ${audioLocal ? 'ok' : 'null'}`);
        if (audioLocal) {
           scene.narration_path = audioLocal;
        }
     }
  })();
  // Started here, awaited ~200 lines below after the visuals run. A rejection in
  // that gap has no handler attached yet, so Node treats it as unhandled and kills
  // the server process. This no-op catch marks it handled the moment it exists; the
  // real error still reaches the Promise.all below and fails the project, not the box.
  audioPromise.catch(() => {});

  console.log('[Orchestrator] Scene character:', (scene as any).character, 'visual referenceUrl:', scene.visuals?.[0]?.referenceImageUrl ? 'SET' : 'NOT SET');

  // Character scene: replace visuals array entirely so the completed status
  // is on the exact object the Promise.all will iterate — no mutation ambiguity
  const charName = (scene as any).character as string | undefined;
  if (charName && charName !== 'NARRATOR') {
    const matchedChar = project.universe?.characters
      ?.find((c: any) => c.name.toUpperCase() === charName.toUpperCase());
    if (matchedChar) {
      const emotion = (scene as any).emotion || 'idle';
      const poseUrl =
        (project.universe as any)?.characterPoses?.[charName]?.[emotion] ||
        (project.universe as any)?.characterPoses?.[charName]?.['idle'];
      const imageUrl = poseUrl || matchedChar.referenceImageUrl;

      if (matchedChar.useLoRA && matchedChar.loraModelUrl) {
        // LoRA takes priority over reference image — generate scene-specific image with trained model
        const triggerWord = matchedChar.loraTriggerWord || 'VEER_CHARACTER';
        const v = scene.visuals[0] as any;
        v.loraModelUrl = matchedChar.loraModelUrl;
        v.loraTriggerWord = triggerWord;
        if (!(v.prompt || '').includes(triggerWord)) {
          v.prompt = `${triggerWord} ` + (v.prompt || '');
        }
        v.cache_key = '';
        // Unified full-scene generation (Metro V4 path): one LoRA image that
        // contains character AND background — no separate BG gen, no rembg.
        if (process.env.UNIFIED_SCENES === 'true' && charName === 'VEER' && scene.background_prompt) {
          const sceneDesc = (v.prompt || '')
            .split(triggerWord).join('')
            .replace(/^[,\s]+/, '')
            .trim();
          v.prompt = `${triggerWord} ${sceneDesc}, ${scene.background_prompt}, South Asian graphic novel illustration style, Trigger Studio quality, flat colour, NOT photorealistic`;
          (scene as any).unified = true;
          console.log('[Orchestrator] Unified scene generation enabled for:', charName);
        }
        console.log('[Orchestrator] LoRA generation for:', charName, 'model:', matchedChar.loraModelUrl.slice(-40));
        // Additive: anchor feeds LoRA fallback path (Imagen 4) if Replicate fails
        const loraAnchorKey = charName + '_' + project.project_id!;
        const loraAnchorUrl = characterAnchors.get(loraAnchorKey);
        if (loraAnchorUrl) {
          v.referenceImageUrl = loraAnchorUrl;
          console.log('[Orchestrator] Anchor set as LoRA fallback reference for:', charName);
        }
      } else {
        // No LoRA — use anchor from a previous scene, or fall back to the static reference image.
        // Anchor = first successfully generated image for this character this run (local path).
        // Reference = character's uploaded reference photo (Supabase URL).
        const charKey = charName + '_' + project.project_id!;
        const anchorUrl = characterAnchors.get(charKey);
        const refUrl = anchorUrl || matchedChar.referenceImageUrl || (matchedChar as any).imageUrl;
        if (refUrl) {
          (scene.visuals[0] as any).referenceImageUrl = refUrl;
          console.log('[Orchestrator]', anchorUrl ? 'Using anchor for:' : 'Reference image set for:', charName, refUrl.slice(-40));
        } else {
          console.log('[Orchestrator] No LoRA, no reference for:', charName, '— text prompt only');
        }
      }
    }
  }

  // Stage 2: generate or re-download background image
  console.log('[Orchestrator] Background prompt for scene:', scene.scene_id, '→', scene.background_prompt || 'NO PROMPT SET');
  const bgTmpDir = path.join(os.tmpdir(), 'ais-renderer', project.project_id!);
  if (!fs.existsSync(bgTmpDir)) fs.mkdirSync(bgTmpDir, { recursive: true });
  const bgLocalPath = path.join(bgTmpDir, `${scene.scene_id}_background.png`);

  if (!scene.background_path && scene.background_url && !(scene as any).unified) {
    // Background URL available (pre-generated or cached from prior run) — download instead of regenerating
    try {
      console.log('[Orchestrator] Background cached in Supabase — re-downloading');
      await downloadFile(scene.background_url, bgLocalPath);
      scene.background_path = bgLocalPath;
      console.log('[Orchestrator] Background re-downloaded:', path.basename(bgLocalPath));
    } catch (dlErr: any) {
      console.warn('[Orchestrator] Background re-download failed, will regenerate:', dlErr?.message);
      scene.background_url = undefined;
    }
  }

  if (scene.background_prompt && !scene.background_path && !(scene as any).unified) {
    try {
      const bgArtStyle = (project.universe as any)?.backgroundArtStyle || '';
      const aestheticSuffix = (project as any).universeId
        ? INDIAN_AESTHETIC_SUFFIX
        : 'cinematic lighting, clean professional style, suitable for educational content, main subject centered with generous margins on all sides (frame edges will be cropped to 9:16 vertical), absolutely no text, no words, no numbers, no lettering, no typography anywhere in the image';
      const fullBgPrompt = [scene.background_prompt, aestheticSuffix, bgArtStyle].filter(Boolean).join(', ');
      console.log('[Orchestrator] Background full prompt:', fullBgPrompt.slice(0, 120));
      const bgBase64 = await AIService.generateImageBase64(fullBgPrompt, { isStoryEpisode: !!(project as any).universeId });
      if (bgBase64) {
        const bgBuffer = Buffer.from(bgBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        fs.writeFileSync(bgLocalPath, bgBuffer);
        scene.background_path = bgLocalPath;
        // Upload to Supabase so the path survives server restarts.
        // Fire-and-forget: render continues on bgLocalPath; background_url lands
        // in a later saveProjectState via the shared scene reference.
        FirestoreService.uploadAsset(
          project.project_id!,
          `backgrounds/${scene.scene_id}_background.png`,
          bgBuffer,
          'image/png'
        ).then(bgUrl => {
          scene.background_url = bgUrl;
          console.log('[Orchestrator] Background uploaded:', bgUrl.slice(-60));
        }).catch((uploadErr: any) => {
          console.warn('[Storage] Background upload failed (non-blocking, local path kept):', uploadErr?.message);
        });
        console.log('[Orchestrator] Background generated for scene:', scene.scene_id);
      }
    } catch (bgErr: any) {
      console.warn('[Orchestrator] Background generation failed for scene:', scene.scene_id, bgErr?.message);
    }
  }

  // Art style injection for NARRATOR/background scenes only
  const universeStyle = (project.universe as any)?.artStyle || '';
  if (universeStyle && scene.visuals[0] && (scene.visuals[0] as any).status !== 'completed') {
    const currentPrompt = scene.visuals[0].prompt || '';
    if (!currentPrompt.includes(universeStyle.slice(0, 15))) {
      scene.visuals[0].prompt = currentPrompt + ', ' + universeStyle + ', 9:16 vertical portrait';
    }
    console.log('[Orchestrator] Art style injected:', universeStyle?.slice(0, 50));
    console.log('[Orchestrator] Final prompt:', scene.visuals[0]?.prompt?.slice(0, 100));
  }

  const visualsPromise = Promise.all(scene.visuals.map(async (visual, i) => {
     if (visual.status === 'completed') {
       console.log('[Orchestrator] Visual already resolved, skipping generation');
       return; // rendering happens after Promise.all with known audio duration
     }
     visual.status = 'processing';

     // NARRATOR scenes never generate a character image. If a background is
     // already available (uploaded or freshly generated above) we hand it
     // directly to the animator as the full scene image and mark the scene
     // unified so rembg and the Stage-2 composite are both skipped.
     if (!charName || charName === 'NARRATOR') {
       if (scene.background_path && fs.existsSync(scene.background_path)) {
         visual.asset_path = scene.background_path;
         (scene as any).unified = true;
         visual.status = 'completed';
         console.log('[Orchestrator] NARRATOR scene — using background as full scene, skipping character generation');
         return;
       }
       // No background: fall through and generate the image from the visual prompt.
       // Returning here instead left the visual with no asset at all, and the render
       // stage then failed the scene with no reason attached. Only scenes created
       // through the editor get a background_prompt (projectController sets one);
       // StoryboardAgent never does, so every pipeline-created project — i.e. every
       // standard NARRATOR project — produced a video with no visuals.
       console.log('[Orchestrator] NARRATOR scene — no background, generating image from the visual prompt');
     }

     // Cutout scenes with portrait assets: skip LoRA/Gemini generation —
     // the Doraemon engine reads character parts (mouth_closed.png etc.) from
     // the assets directory directly and doesn't use the generated image at all.
     // Set asset_path to background so renderVisualClip reaches the Doraemon block.
     if (process.env.USE_DORAEMON === 'true' &&
         (scene as any).render_mode === 'cutout' &&
         charName && characterHasPortraitAssets(charName, project)) {
       visual.asset_path = scene.background_path || undefined;
       visual.status = 'completed';
       console.log(`[Orchestrator] Cutout scene with portrait assets — skipping image generation, Doraemon engine will render ${charName} directly`);
       return;
     }

     if (!visual.cache_key) {
        visual.cache_key = generateVisualHash(visual.prompt, visual.asset_type, visual.duration_target, visual.motion_instruction || 'none', project.mode, project.style_profile, (visual as any).referenceImageUrl || '');
     }

     if (visual.frames && visual.frames.length > 1) {
       // Multi-frame: generate each frame's asset in parallel
       console.log(`[Orchestrator] Generating ${visual.frames.length} frames for scene ${scene.scene_id}, visual ${i}`);
       await Promise.all(visual.frames.map(async (frame: VisualFrame) => {
         const frameVisual: Visual = {
           visual_id: frame.frame_id,
           prompt: frame.prompt,
           asset_type: visual.asset_type,
           duration_target: frame.duration,
           motion_instruction: frame.motion,
           status: 'pending',
           cache_key: generateAssetHash(frame.prompt, visual.asset_type, project.style_profile, (visual as any).referenceImageUrl || ''),
           ...(visual.referenceImageUrl ? { referenceImageUrl: visual.referenceImageUrl } : {}),
         };
         const localAsset = await withRetry(() => generateAsset(frameVisual, frameVisual.cache_key, project.mode, project), { retries: 2 });
         if (localAsset) {
           frame.asset_path = localAsset;
         }
       }));
       if (i === 0 && visual.frames[0]?.asset_path) scene.image_path = visual.frames[0].asset_path;
     } else {
       // Single-frame path (standard behavior)
       console.log(`[Orchestrator] Generating image for scene ${scene.scene_id}, visual ${i} (${visual.asset_type})`);
       let localAsset = await withRetry(() => generateAsset(visual, visual.cache_key, project.mode, project), { retries: 2 });
       console.log(`[Orchestrator] Image complete for scene ${scene.scene_id}, visual ${i}: ${localAsset ? 'ok' : 'null'}`);
       if (localAsset) {
          visual.asset_path = localAsset;
          if (i === 0 && !localAsset.endsWith('.mp4')) scene.image_path = localAsset;
          // Store as anchor for subsequent scenes of the same character.
          // Prefer the Supabase URL (survives restarts); fall back to the
          // local file — aiService loads either form via imageRef.
          const sceneCharName = (scene as any).character as string | undefined;
          if (sceneCharName && sceneCharName !== 'NARRATOR' && i === 0 && !localAsset.endsWith('.mp4')) {
            const charKey = sceneCharName + '_' + project.project_id!;
            if (!characterAnchors.has(charKey)) {
              try {
                const anchorUrl = await FirestoreService.uploadAsset(
                  project.project_id!,
                  `anchors/${sceneCharName}_anchor.png`,
                  fs.readFileSync(localAsset),
                  'image/png'
                );
                recordAnchor(project, characterAnchors, sceneCharName, anchorUrl);
                console.log('[Orchestrator] Anchor uploaded for:', sceneCharName, anchorUrl.slice(-50));
              } catch (anchorErr: any) {
                // Upload failed — fall back to the local file. aiService loads
                // references via imageRef (fs for local paths), so a dead
                // Supabase link no longer drops the anchor entirely.
                recordAnchor(project, characterAnchors, sceneCharName, localAsset);
                console.warn('[Orchestrator] Anchor upload failed for:', sceneCharName, '— using local file fallback:', anchorErr?.message);
              }
            }
          }
       }
     }
     visual.status = 'completed'; // image ready; clip rendered after audio finishes
  }));
  visualsPromise.catch(() => {}); // same unhandled-rejection guard as audioPromise

  // Wait for both Audio and Visuals to finish concurrently
  await Promise.all([audioPromise, visualsPromise]);

  // Render visual clips now that audio duration is known
  const audioDur = (scene.narration_path && fs.existsSync(scene.narration_path))
    ? await getAudioDuration(scene.narration_path) : 0;
  console.log('[Orchestrator] Rendering visuals with audio duration:', audioDur > 0 ? audioDur.toFixed(3) + 's' : 'unknown (using duration_target)');

  // Target-length seam. This is the first point where the scene's real narration
  // length is known and the last point before the still is encoded — pad here and
  // the hold costs nothing extra; pad at assembly or stitch and every segment
  // needs a second re-encode to grow. Scenes render in batches so the other
  // scenes' audio doesn't exist yet: this scene claims its word-count share of
  // the project target, which at a uniform speaking rate is identical to padding
  // every scene by one shared factor.
  let holdDuration = audioDur;
  if (audioDur > 0) {
    const words = (t?: string) => (t || '').trim().split(/\s+/).filter(Boolean).length;
    const totalWords = project.scenes.reduce((n, s) => n + words(s.narration_text), 0);
    const target = targetLengthSeconds(project.settings?.targetLength);
    const share = totalWords > 0 ? target * words(scene.narration_text) / totalWords : 0;
    const plan = planScenePadding([audioDur], share);
    holdDuration = plan.durations[0];
    (scene as any).pad_seconds = Number((holdDuration - audioDur).toFixed(3));
    if (!plan.reachedTarget) {
      console.warn(`[TargetLength] Scene ${scene.scene_id} needs ${share.toFixed(1)}s of the requested ${target}s but its narration is only ${audioDur.toFixed(1)}s — capped at ${plan.total.toFixed(1)}s (${MAX_PAD_FACTOR}x narration). Not padding with silence: the script is too short for ${target}s.`);
    } else if (holdDuration > audioDur) {
      console.log(`[TargetLength] Scene ${scene.scene_id}: holding still ${(holdDuration - audioDur).toFixed(2)}s past narration (${audioDur.toFixed(2)}s → ${holdDuration.toFixed(2)}s) toward the ${target}s target`);
    }
  }

  for (const visual of scene.visuals) {
    let existingRendered = (visual as any).rendered_path as string | undefined;
    // A clip rendered with a different Cinematic Effect is not this scene's clip.
    // The motion is part of the clip's path, so a mismatch means the stored one was
    // built with the old movement — drop it rather than skip the render and ship it.
    if (existingRendered?.endsWith('.mp4')) {
      const expected = visualClipPath(
        path.join(os.tmpdir(), 'ais-renderer'),
        String(project.project_id),
        visual.visual_id,
        (visual as any).motion_instruction,
      );
      if (path.resolve(existingRendered) !== path.resolve(expected)) {
        console.log(
          `[Orchestrator] Visual clip was rendered with a different motion — regenerating`,
          `(have ${path.basename(existingRendered)}, want ${path.basename(expected)})`,
        );
        (visual as any).rendered_path = undefined;
        existingRendered = undefined;
      }
    }
    const isLocalMp4 = !!(existingRendered && existingRendered.endsWith('.mp4') && fs.existsSync(existingRendered));
    // Promote a Supabase image URL from rendered_path to asset_path so renderVisualClip can use it
    // (generateSceneImage sets rendered_path but not asset_path; pipeline requires asset_path)
    if (!isLocalMp4 && !(visual as any).asset_path && existingRendered?.startsWith('http')) {
      console.log('[Orchestrator] Promoting rendered_path image URL to asset_path for rendering');
      (visual as any).asset_path = existingRendered;
      (visual as any).rendered_path = undefined;
    }
    if (!isLocalMp4 && (visual as any).asset_path) {
      if (signal?.aborted) throw new Error('PIPELINE_CANCELLED');
      // Ken Burns reads duration_target, the engines read the passed duration —
      // both must cover the hold or assembleSceneSegment would loop the clip.
      if (holdDuration > 0) visual.duration_target = holdDuration;
      const renderedLocal = await renderVisualClip(visual, project, signal, scene, holdDuration > 0 ? holdDuration : undefined);
      if (renderedLocal) (visual as any).rendered_path = renderedLocal;
    } else if (isLocalMp4) {
      console.log('[Orchestrator] Visual already rendered, skipping:', path.basename(existingRendered!));
    }
  }

  // 3. Assembly
  scene.stage = 'render';
  if (scene.narration_path) {
     const localAudio = scene.narration_path; // always local — pipeline no longer uploads intermediates

     const visual = scene.visuals?.[0] as any;
     const visualRenderedPath = visual?.rendered_path;
     if (!visualRenderedPath || !fs.existsSync(visualRenderedPath)) {
       console.error('[Orchestrator] Visual not rendered for scene:', scene.scene_id, 'rendered_path:', visualRenderedPath);
       scene.status = 'failed';
       // Without a reason here, project.error_log falls back to the generic "Asset
       // generation phase failed for some scenes" and the UI shows nothing actionable.
       scene.error_log = visual?.asset_path
         ? `Scene visual was never rendered to video (image exists at ${path.basename(String(visual.asset_path))}). The clip render step did not produce a file.`
         : `No image was generated for this scene, so there was nothing to render. Check the image provider logs — the Visual Style and prompt are set, but no asset was produced.`;
       return;
     }

     if (scene.segment_path && fs.existsSync(scene.segment_path)) {
       console.log('[Orchestrator] Reusing segment:', scene.segment_path.slice(-40));
     } else {
       // One call, one video encode: assembleSceneSegment scales, burns the captions and
       // muxes the audio in a single pass, so there is no separate caption stage to run.
       const sceneRenderedPath = await withRetry(() => assembleSceneSegment(scene, localAudio, scene.cache_key, signal, project), { retries: 2 });
       if (sceneRenderedPath) {
          scene.segment_path = sceneRenderedPath;
          scene.rendered_path = sceneRenderedPath;
          if (scene.caption_text) scene.captioned_path = sceneRenderedPath;
       }
     }
  }

  scene.status = scene.fallback_used ? 'degraded' : 'completed';
  scene.stage = 'done';
  // Stamp what this scene was rendered FROM. The next run compares against it to
  // decide whether the scene needs rebuilding, so it is only recorded on success —
  // a failed scene must never look up to date.
  if (scene.status === 'completed') {
    (scene as any).render_hash = sceneRenderHash(scene, project);
  }
}

  // --------------------------------------------------------------------------
  // Finalize Pipeline (Phase 4C Step 3D)
  // --------------------------------------------------------------------------
export async function cleanupAssets(project: Project) {
  if (project.status !== 'completed') return;
  // All intermediate assets are local — no Supabase cleanup needed.
  // Local temp files under os.tmpdir() will be cleared by the OS.
  console.log(`[Orchestrator] Pipeline complete — local temp assets will be garbage-collected by OS for project ${project.project_id}`);
}

export async function validateProjectAssets(project: Project, signal?: AbortSignal, characterAnchors: Map<string, string> = new Map()) {
  console.log(`[Orchestrator] Validating project assets...`);
  let missing = false;
  for (const scene of project.scenes) {
     if (!scene.narration_path || !scene.visuals[0]?.asset_path) {
        missing = true;
        scene.status = 'pending';
     }
  }
  
  if (missing) {
      console.log(`[Orchestrator] Missing assets detected. Running recovery generation...`);
      const failedScenes = project.scenes.filter(s => s.status === 'pending');
      for (const scene of failedScenes) {
         if (signal?.aborted) throw new Error('PIPELINE_CANCELLED');
         try {
            await processSingleScene(scene, project, 'default_preset', project.preview_mode || false, false, signal, characterAnchors);
         } catch (e) {
            console.error(`Recovery generation failed for scene ${scene.scene_id}:`, e);
            scene.status = 'failed';
         }
      }
  }
}

export async function concatFinalVideo(project_id: string, isPreview: boolean = false, signal?: AbortSignal, inMemoryProject?: Project): Promise<void> {
  const activeProject = inMemoryProject ?? await loadProject(project_id);
  console.log('[DEBUG] activeProject scenes[0]:',
    activeProject.scenes[0]?.scene_id,
    'segment_path:', (activeProject.scenes[0] as any)?.segment_path,
    'status:', activeProject.scenes[0]?.status
  );
  try {
    // 1. Get ordered scenes and 2. Collect scene.segment_path
    const sortedScenes = [...activeProject.scenes].sort((a, b) => a.order - b.order);
    const finalScenes = [];
    const downloadedPaths: string[] = [];

    // Must match assembleSceneSegment's project-scoped dir. Unscoped, this "recovery"
    // adopts another project's segments whenever scene ids collide (i.e. after a copy).
    const aisRendererDir = path.join(os.tmpdir(), 'ais-renderer', project_id);

    console.log('[Stitch] Total scenes:', sortedScenes.length);
    for (const scene of sortedScenes) {
      // Resolve disk path as fallback when in-memory path is stale
      const diskCaptioned = path.join(aisRendererDir, `${scene.scene_id}_captioned.mp4`);
      const diskSegment = path.join(aisRendererDir, `${scene.scene_id}_segment.mp4`);
      const diskPath = fs.existsSync(diskCaptioned) ? diskCaptioned : (fs.existsSync(diskSegment) ? diskSegment : undefined);
      if (!scene.segment_path && diskPath) {
        console.log('[Stitch] Recovering segment from disk for scene:', scene.scene_id, path.basename(diskPath));
        (scene as any).segment_path = diskPath;
        (scene as any).rendered_path = diskPath;
      }
      if (scene.status !== 'completed' && scene.status !== 'degraded' && diskPath) {
        console.log('[Stitch] Recovering status to completed for scene:', scene.scene_id, '(was:', scene.status + ')');
        scene.status = 'completed';
      }
      console.log('[Stitch] Scene:', scene.scene_id,
        'status:', scene.status,
        'rendered_path:', scene.rendered_path?.substring(0, 60),
        'captioned_path:', scene.captioned_path?.substring(0, 60),
        'segment_path:', scene.segment_path?.substring(0, 60));
    }

    for (const scene of sortedScenes) {
      if (scene.status !== 'completed' && scene.status !== 'degraded') continue;

      // scene.preview_path is never assigned by anything, so a preview stitch found
      // no segments and produced an empty video. A draft writes its segments to
      // segment_path like any other render, so fall back to it.
      const segPath: string | undefined = isPreview
        ? (scene.preview_path || (scene as any).segment_path)
        : (scene as any).segment_path;

      if (!segPath) {
        console.log(`[Stitch] Skipping scene ${scene.scene_id} — no segment_path`);
        continue;
      }

      if (segPath.startsWith('http')) {
        console.log(`[Stitch] Skipping scene ${scene.scene_id} — stale http URL`);
        continue;
      }

      if (!fs.existsSync(segPath) || fs.statSync(segPath).size === 0) {
        console.log(`[Stitch] Segment file missing or empty: ${segPath}`);
        continue;
      }

      if (segPath.endsWith('.wav') || segPath.endsWith('.mp3') || segPath.endsWith('.aac')) {
        console.error('[Stitch] Rejecting audio file as segment:', segPath);
        continue;
      }

      console.log('[Stitch] Adding segment:', segPath.slice(-50));
      finalScenes.push({
        video_path: segPath,
        duration: scene.duration_actual || 0
      });
    }

    if (finalScenes.length > 0) {
  // 3. Run FFmpeg concat (no re-encode)
      let stitchedVideoPath = await stitchScenes(finalScenes, activeProject, signal);

      // Optional RIFE frame interpolation (USE_RIFE=true doubles fps: 24→48)
      if (process.env.USE_RIFE === 'true') {
        const rifeScript = path.join(process.cwd(), 'scripts', 'rife_interpolate.py');
        const rifePath = stitchedVideoPath.replace('.mp4', '_48fps.mp4');
        try {
          await new Promise<void>((resolve, reject) => {
            console.log('[RIFE] Interpolating frames: 24fps → 48fps');
            const proc = spawn('py', [rifeScript, '--input', stitchedVideoPath, '--output', rifePath], {
              env: { ...process.env },
            });
            proc.stdout?.on('data', (d: Buffer) => process.stdout.write(d));
            proc.stderr?.on('data', (d: Buffer) => process.stderr.write(d));
            proc.on('close', code => (code === 0 ? resolve() : reject(new Error(`RIFE exit ${code}`))));
            proc.on('error', reject);
          });
          if (fs.existsSync(rifePath) && fs.statSync(rifePath).size > 10000) {
            stitchedVideoPath = rifePath;
          } else {
            console.warn('[RIFE] Output missing or empty — using original');
          }
        } catch (rifeErr: any) {
          console.warn('[RIFE] Interpolation failed (non-fatal) — using original:', rifeErr?.message);
        }
      }

      // Readable filename: `what-is-a-rest-api-04fa8d80.mp4`, not a bare uuid. Existing
      // files are never renamed — old projects keep their uuid-named file because their
      // stored output_path still points at it; only new renders get the new name.
      const fileName = projectVideoFileName(
        activeProject.title || activeProject.topic,
        activeProject.project_id!,
        isPreview ? '_preview' : '',
      );

      // Save local backup first — survives Supabase failures and server restarts
      const outputsDir = path.join(process.cwd(), 'outputs');
      fs.mkdirSync(outputsDir, { recursive: true });
      const backupPath = path.join(outputsDir, fileName);
      try {
        fs.copyFileSync(stitchedVideoPath, backupPath);
        console.log('[Orchestrator] Local backup saved:', backupPath);
      } catch (backupErr: any) {
        console.warn('[Orchestrator] Backup copy failed (non-fatal):', backupErr?.message);
      }

      // The cloud copy is redundancy, not the deliverable. It is started below, after the
      // project has been marked complete, and it never gates that: the render is finished
      // when the file is on disk. Marked pending here so a copy that never lands is
      // visibly unfinished rather than indistinguishable from one never attempted.
      const localOnly = !fs.existsSync(backupPath);
      activeProject.cloud_backup = {
        status: localOnly ? 'skipped' : 'pending',
        error: localOnly ? 'No local file to upload — the backup copy was not written.' : undefined,
        updatedAt: new Date().toISOString(),
      };

      // Extract thumbnail from final video (best frame at 1.5s hook moment)
      if (!isPreview && stitchedVideoPath && fs.existsSync(stitchedVideoPath)) {
        const thumbnailLocal = path.join(os.tmpdir(), 'ais-renderer', `${project_id}_thumbnail.jpg`);
        try {
          const thumbCmd = `"${ffmpegPath}" -i "${stitchedVideoPath}" -ss 1.5 -vframes 1 -q:v 2 -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2" -y "${thumbnailLocal}"`;
          await execAsync(thumbCmd, { timeout: 30000 });
          if (fs.existsSync(thumbnailLocal)) {
            const thumbBuffer = await fs.promises.readFile(thumbnailLocal);
            // Fire-and-forget: don't hold up output_path / finalization on the upload
            FirestoreService.uploadAsset(activeProject.project_id!, `${project_id}_thumbnail.jpg`, thumbBuffer, 'image/jpeg')
              .then(thumbUrl => {
                console.log('[Orchestrator] Thumbnail saved:', thumbUrl);
                // Patch the CURRENT project rather than saving the copy captured when this
                // upload started. The final saveProjectState normally lands first, so
                // saving the captured object was a stale write — refused by the disk store,
                // taking thumbnail_path down with it.
                return patchProject(activeProject.project_id!,
                  (p) => { p.thumbnail_path = thumbUrl; }, 'thumbnail_path');
              })
              .catch((thumbUpErr: any) => console.warn('[Storage] Thumbnail upload failed (non-blocking):', thumbUpErr?.message));
            fs.promises.unlink(thumbnailLocal).catch(() => {});
          }
        } catch (thumbErr) {
          console.warn('[Orchestrator] Thumbnail extraction failed (non-fatal):', thumbErr);
        }
      }

      // Cleanup temp files created during stitching
      const tmpRendererDir = path.join(os.tmpdir(), 'ais-renderer');
      // 1. Downloaded scene segments (_dl.mp4)
      for (const p of downloadedPaths) fs.promises.unlink(p).catch(() => {});
      // 2. SRT caption files for each scene
      for (const scene of sortedScenes) {
        fs.promises.unlink(path.join(tmpRendererDir, `${scene.scene_id}.srt`)).catch(() => {});
      }
      // 3. Concat list files (list_*.txt) in the project's tmp subdirectory
      const projectTmpDir = path.join(tmpRendererDir, project_id);
      if (fs.existsSync(projectTmpDir)) {
        for (const f of fs.readdirSync(projectTmpDir)) {
          if (f.startsWith('list_') && f.endsWith('.txt')) {
            fs.promises.unlink(path.join(projectTmpDir, f)).catch(() => {});
          }
        }
      }

      // Always the local file. It exists now, it plays instantly over /outputs, and it
      // cannot be taken away by a network failure. The cloud URL lives on cloud_backup;
      // pointing output_path at it made playback depend on an upload succeeding, and made
      // a failed upload look exactly like a successful local render.
      if (isPreview) {
        activeProject.preview_video_path = backupPath;
      } else {
        activeProject.output_path = backupPath;
      }
      activeProject.completed_at = new Date();
      
      // Pre-publish quality gate. Runs on the finished video, so its verdict is about
      // what was actually produced rather than what was intended.
      const gate = await runQualityGate(activeProject);
      activeProject.quality_gate = gate;
      activeProject.quality_score = gate.score;

      for (const check of gate.checks) {
        console.log(`[QualityGate] ${check.status.toUpperCase().padEnd(7)} ${check.label} — ${check.detail}`);
      }

      const anyFailed = activeProject.scenes.some((s: Scene) => s.status === 'failed');
      const anyDegraded = activeProject.scenes.some((s: Scene) => s.status === 'degraded');
      // A gate failure marks the project degraded rather than completed: the video
      // exists and is downloadable, but it is not cleared to publish unattended.
      activeProject.status = (anyFailed || anyDegraded || !gate.passed) ? 'degraded' : 'completed';
      if (!gate.passed) {
        console.error(`[QualityGate] BLOCKED for ${project_id}: ${gate.failures.join(' | ')}`);
      }
      
      // Track video generation
      await logUserEvent('video_generated', project_id, { status: activeProject.status, qualityScore: activeProject.quality_score });

      console.log(`[Orchestrator] Final video saved to: ${activeProject.output_path}`);

      // Started here and not awaited: the project is already complete and already
      // playable. A 34 MB episode takes ~20s to push at the measured 1.76 MB/s, and no
      // one should wait on that to see their video.
      if (activeProject.cloud_backup?.status === 'pending') {
        void uploadFinalVideo(activeProject.project_id!, backupPath, fileName, ffmpegPath);
      }
      
      // Cleanup intermediate assets
      if (activeProject.status === 'completed') {
         // Run asynchronously so we don't block
         cleanupAssets(activeProject).catch(e => console.error("Cleanup failed", e));
      }
    } else {
      throw new Error('No valid scenes found for stitching');
    }
  } catch (stitchErr) {
    console.error(`[Orchestrator] Final stitching failed for activeProject ${project_id}: ${stitchErr}`);
    activeProject.status = 'failed';
    activeProject.error_log = String(stitchErr);
  }

  activeProject.updated_at = new Date();
  
  console.log(`[Orchestrator] Finalizing activeProject ${project_id}. Status: ${activeProject.status}, ErrorLog: ${activeProject.error_log}`);
  await saveProjectState(activeProject);
  console.log(`[Orchestrator] --- Pipeline Finished. Status: ${activeProject.status} ---`);
}


export async function regenerateScene(project_id: string, scene_id: string, resetVisuals: boolean, options?: { mode?: 'test' | 'production' }): Promise<void> {
  console.log(`[Orchestrator] --- Regenerating Scene ${scene_id} for Project: ${project_id} ---`);
  
  // 1. Reset Scene State in DB
  let project = await loadProject(project_id);
  const scene = project.scenes.find(s => s.scene_id === scene_id);
  if (!scene) throw new Error(`Scene ${scene_id} not found in project ${project_id}`);

  scene.status = 'pending';
  scene.cache_key = ''; // Force regeneration
  scene.rendered_path = undefined;
  scene.segment_path = undefined;
  scene.captioned_path = undefined;
  scene.audio_hash = undefined;
  
  if (resetVisuals) {
    scene.visuals.forEach(v => {
      v.status = 'pending';
      v.cache_key = '';
      v.asset_path = undefined;
      v.rendered_path = undefined;
    });
  }

  await saveProjectState(project);

  // 2. Run Scene Pipeline
  await runScenePipeline(project_id, scene_id, options);

  // 3. Concat Final Video
  await concatFinalVideo(project_id);
  
  // Track scene regeneration
  await logUserEvent('scene_regenerated', project_id, { sceneId: scene_id, resetVisuals });

  console.log(`[Orchestrator] --- Regenerating Scene ${scene_id} Finished. ---`);
}

/**
 * Regenerates a single visual within a scene.
 * 
 * @param project_id The project ID.
 * @param scene_id The scene ID.
 * @param visual_id The visual ID to regenerate.
 */
export async function regenerateVisual(project_id: string, scene_id: string, visual_id: string): Promise<void> {
  console.log(`[Orchestrator] --- Regenerating Visual ${visual_id} for Scene ${scene_id}, Project ${project_id} ---`);
  
  // 1. Load project
  let project = await loadProject(project_id);
  const scene = project.scenes.find(s => s.scene_id === scene_id);
  if (!scene) throw new Error(`Scene ${scene_id} not found in project ${project_id}`);
  const visual = scene.visuals.find(v => v.visual_id === visual_id);
  if (!visual) throw new Error(`Visual ${visual_id} not found in scene ${scene_id}`);

  // 2. Reset visual
  visual.status = 'pending';
  visual.cache_key = '';
  visual.asset_path = undefined;
  visual.rendered_path = undefined;
  
  // 3. Regenerate visual
  visual.cache_key = generateVisualHash(visual.prompt, visual.asset_type, visual.duration_target, visual.motion_instruction, project.mode, project.style_profile);
  visual.asset_hash = generateAssetHash(visual.prompt, visual.asset_type, project.style_profile);
  
  try {
    visual.asset_path = await withRetry(() => generateAsset(visual, visual.asset_hash || visual.cache_key, project.mode, project), { retries: 1 });
    const renderedPath = await renderVisualClip(visual, project);
    if (!renderedPath) throw new Error('Rendering failed');
    visual.rendered_path = renderedPath;
    await validateVisualClip(visual);
    visual.status = 'completed';
    
    if (visual.asset_type === 'ai_image') {
      await QuotaService.incrementAiImage().catch(err => console.error('[Orchestrator] Quota increment failed:', err));
    }
  } catch (vErr) {
    console.error(`[Orchestrator] Visual ${visual_id} failed: ${vErr}`);
    visual.status = 'failed';
    await saveProjectState(project);
    return;
  }

  // 4. Update scene.segment_path (re-assemble scene)
  const finalAudioPath = await getFromCache(scene.audio_hash!);
  if (finalAudioPath) {
    const assemblyCacheKey = generateSceneHash(
      scene.narration_text,
      scene.duration_actual || 0,
      scene.visuals.map(v => v.cache_key),
      scene.motion_instruction,
      project.mode,
      scene.transition_type,
      project.preview_mode
    );
    const sceneRenderedPath = await withRetry(() => assembleSceneSegment(scene, finalAudioPath, assemblyCacheKey, undefined, project), { retries: 2 });
    if (sceneRenderedPath) {
      scene.segment_path = sceneRenderedPath;
      scene.rendered_path = sceneRenderedPath;
    } else {
      throw new Error(`Scene ${scene.scene_id} assembly failed.`);
    }
  } else {
    throw new Error(`Audio missing for scene ${scene.scene_id} assembly.`);
  }

  // 5. Save project state
  await saveProjectState(project);

  // 6. Re-concat final video
  await concatFinalVideo(project_id);
  console.log(`[Orchestrator] --- Regenerating Visual Finished. ---`);
}
