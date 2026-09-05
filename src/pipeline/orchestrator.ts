import { Project, CloudBackup } from '../models/project.js';
import { progressBus, ProgressStage } from '../server/progressBus.js';
import { StyleProfile } from '../models/types.js';
import { Scene, Visual, VisualFrame } from '../models/scene.js';
import { runQualityGate } from '../services/qualityService.js';
import { withProjectScope } from '../services/logService.js';
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
import { renderVisualClip, validateVisualClip, assembleSceneSegment, stitchScenes, getAudioDuration, visualClipPath, isShortsProject, prepareSceneAudio } from '../services/renderService.js';
import { sceneVisualKey, cutawayIndex } from '../services/overlayPlan.js';
import { resolveEntityImage } from '../services/entityImage.js';
import { generateHash, generateAudioHash, generateVisualHash, generateSceneHash, generateAssetHash } from '../utils/hash.js';
import { getScenesToRender, sceneRenderHash } from '../utils/diff.js';
import { getFromCache } from '../services/cacheService.js';
import { logUserEvent, logEvent, estimateCostUsd } from '../services/logService.js';
import { buildSceneTimeline } from '../utils/timeline.js';
import { targetLengthSeconds, planScenePadding, MAX_PAD_FACTOR, secondsForWords, countWords } from '../utils/targetLength.js';
import { beatShares } from '../utils/beats.js';
import { stripSpeakerPrefix } from '../utils/narration.js';
import { projectVideoFileName } from '../utils/filename.js';
import { QuotaService } from '../server/services/quotaService.js';
import { AIService } from '../services/aiService.js';
import { FirestoreService } from '../server/db/firestore.js';
import { storageMode } from '../services/sceneImageStore.js';
import { DirectorAgent } from './agents/directorAgent.js';
import { ScriptwriterAgent } from './agents/scriptwriterAgent.js';
import { loadKnowledgeDocuments } from '../content-studio/store.js';
import { generateSeoMetadata } from './agents/seoAgent.js';
import { StoryboardAgent } from './agents/storyboardAgent.js';
import { WorldAgent } from './agents/worldAgent.js';
import { applyVisualContext, inferVisualContext, needsVisualContext } from './visualContext.js';
import { applyShotFraming } from './shotFraming.js';
import { abortManager } from './abortManager.js';
import { requestContext } from '../server/utils/context.js';
import { persistProjectToDisk, restoreProjectsFromDisk, deleteProjectFromDisk } from './projectDiskStore.js';
import { seedAnchorsFromProject, recordAnchor, anchorSummary } from './anchorStore.js';
import { stripLetterbox } from '../services/letterbox.js';


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

/**
 * Forgets a project held locally, in memory and on disk.
 *
 * Both halves matter: dropping only the in-memory copy leaves outputs/{id}.json to be
 * restored at the next boot, and deleting only the file leaves this process still
 * serving — and re-persisting — the record it already holds.
 */
export function deleteLocalProject(project_id: string): boolean {
  const inMemory = projectMemoryStore.delete(project_id);
  const onDisk = deleteProjectFromDisk(project_id);
  return inMemory || onDisk;
}

/**
 * Returns a scene to the state the pipeline treats as "not done yet".
 *
 * Clearing status is not enough on its own. Every stage skips work whose artifact path
 * is already set, so a scene that failed *after* writing a bad artifact came back
 * "pending" and was then skipped on the very next render — the retry reported success
 * and changed nothing. Dropping the paths is what makes it an actual retry.
 *
 * Narration and background are deliberately kept: they are the expensive half, they are
 * content-hash guarded elsewhere, and a failed image is not a reason to re-synthesise
 * audio that was fine.
 */
/**
 * Scenes holding a generated image right now.
 *
 * Sampled before and after a run and differenced, so what gets recorded is images this
 * render actually paid for. Counting all of them would bill every incremental re-render
 * for work it reused, which would make the cost figure worse than useless — it would be
 * confidently wrong in the expensive direction.
 */
export function countGeneratedImages(project?: Project | null): number {
  let n = 0;
  for (const scene of project?.scenes || []) {
    for (const visual of (scene as any).visuals || []) {
      if (visual.asset_path) n++;
    }
    if ((scene as any).background_path) n++;
  }
  return n;
}

/**
 * Fills in a missing `visuals[0].prompt` from the other places a scene's visual
 * direction is known to live, and returns how many scenes were repaired.
 *
 * Every source here is the scene's OWN text — nothing is invented and nothing is
 * asked of a model. It exists because a scene can reach the renderer looking
 * complete to the user while that one field is empty: `generateScenes` maps
 * `prompt: s.visuals?.[0]?.prompt || ''` with no fallback (the `background_prompt`
 * on the line above it has a four-way one), and `generateSceneImage` generates from
 * the prompt in the request body without ever writing it back. A scene can
 * therefore own a real, correct image and still store no prompt.
 */
export function repairSceneVisuals(scenes: any[]): number {
  let repaired = 0;
  for (const scene of scenes || []) {
    if (!scene) continue;
    if (String(scene.visuals?.[0]?.prompt || '').trim()) continue;
    // Union of the aliases both halves of this fix met in the wild: the script/scene
    // half hit visualPrompt and caption_text, the image half hit backgroundPrompt.
    // Every one is the scene's own text — nothing here is invented or asked of a model.
    const salvaged = [scene.background_prompt, scene.backgroundPrompt, scene.visual_prompt, scene.visualPrompt, scene.caption_text]
      .map((value) => String(value || '').trim())
      .find(Boolean);
    if (!salvaged) continue;
    if (!Array.isArray(scene.visuals) || !scene.visuals.length) {
      scene.visuals = [{
        visual_id: uuidv4(), prompt: salvaged, asset_type: 'image', status: 'pending',
        motion_instruction: 'zoom_in', cache_key: '', duration_target: scene.duration_target || 5,
      }];
    } else {
      scene.visuals[0].prompt = salvaged;
    }
    repaired++;
  }
  return repaired;
}

export function resetSceneForRetry(scene: any): void {
  scene.status = 'pending';
  scene.error_log = null;
  scene.errorLog = null;
  scene.rendered_path = undefined;
  scene.segment_path = undefined;
  scene.captioned_path = undefined;
  scene.render_hash = undefined;
  for (const visual of scene.visuals || []) {
    visual.status = 'pending';
    visual.asset_path = undefined;
    visual.rendered_path = undefined;
  }
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
    logEvent('cloud_backup_uploaded', projectId, {
      sizeBytes: bytes, durationSec: Number(((Date.now() - started) / 1000).toFixed(1)), compressed: !!compressed,
    });
    progressBus.emit({ projectId, stage: 'cloud_backup', message: 'Cloud backup complete' });
  } catch (err: any) {
    const reason = err?.message || String(err);
    // Loud on purpose. The local video is fine and the project stays completed; what is
    // not fine is nobody knowing there is no off-machine copy.
    console.error(
      `[CloudBackup] FAILED for ${projectId}: ${reason}\n` +
      `[CloudBackup] The render is unaffected — the video is at ${localPath} — but there ` +
      `is no cloud copy. Fix the cause and re-run the upload.`);
    await record({ status: 'failed', error: reason });
    logEvent('cloud_backup_failed', projectId, { error: reason });
    progressBus.emit({ projectId, stage: 'cloud_backup',
      message: `Cloud backup failed: ${reason}`, error: reason });
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

    // Same fix as StoryboardAgent: `s.duration || 5` made every scene ask for
    // 5s regardless of what was written in it, so every scene overran by the
    // same amount and the cut rhythm went metronomic.
    return sceneData.map((s: any) => {
      const sceneSeconds = s.duration || secondsForWords(countWords(s.narration));
      return {
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
        duration_target: sceneSeconds,
        motion_instruction: s.order === 0 ? 'zoom_in' : 'pan_right',
        status: 'pending',
        cache_key: '',
      }],
      duration_target: sceneSeconds,
      duration_actual: null,
      asset_type: 'ai_image',
      motion_instruction: null,
      transition_type: 'hard_cut',
      retry_count: 0,
      fallback_used: false,
      cache_key: '',
      status: 'pending',
      error_log: null,
      };
    });
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

export function runScenePipeline(project_id: string, scene_id: string, options?: { mode?: 'test' | 'production' }): Promise<void> {
  return withProjectScope(project_id, () => runScenePipelineScoped(project_id, scene_id, options));
}

async function runScenePipelineScoped(project_id: string, scene_id: string, options?: { mode?: 'test' | 'production' }): Promise<void> {
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

/**
 * Map the coarse phase messages onto stages the UI can style. Derived from the message
 * the pipeline already emits rather than threaded through every call site, because these
 * strings ARE the pipeline's own vocabulary — inventing a parallel set would let the two
 * drift apart, and the log line is the thing that gets updated when behaviour changes.
 */
function stageForAction(action: string): ProgressStage {
  const a = action.toLowerCase();
  if (a.includes('script') || a.includes('narrative')) return 'script';
  if (a.includes('scene') && a.includes('breaking')) return 'storyboard';
  if (a.includes('visual prompt') || a.includes('entities')) return 'storyboard';
  if (a.includes('stitch')) return 'stitch';
  if (a.includes('complete')) return 'done';
  if (a.includes('asset') || a.includes('batch')) return 'scene';
  return 'init';
}

/** Emit a scene-scoped progress event. `reused` is the bit a spinner cannot express. */
function emitScene(
  project: Project, scene: Scene, stage: ProgressStage, message: string, reused: boolean,
) {
  const sceneIndex = project.scenes.indexOf(scene) + 1;
  progressBus.emit({
    projectId: project.project_id!,
    stage, message, reused,
    sceneIndex: sceneIndex > 0 ? sceneIndex : undefined,
    sceneTotal: project.scenes.length,
  });
}

async function updateProgress(project: Project, action: string, percent?: number, signal?: AbortSignal) {
  await guardedSaveProjectState(project, signal);

  progressBus.emit({
    projectId: project.project_id!,
    stage: stageForAction(action),
    message: action,
    percent,
  });

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

export type RunPipelineOptions = {
  preview?: boolean,
  mode?: 'test' | 'production',
  /**
   * Last chance to stop before the stitch. Returns halt reasons, empty to proceed.
   * Optional and unset on every existing caller, so a manually started render is
   * byte-for-byte the render it was before this existed.
   */
  beforeStitch?: (project: Project) => Promise<string[]>,
};

/**
 * Every AI call made anywhere below this point is attributed to this project.
 *
 * A wrapper rather than a parameter threaded through the agents: text generation happens
 * four levels down, inside agents that take a brief and have no business knowing about
 * analytics. See withProjectScope.
 */
export function runPipeline(project_id: string, options?: RunPipelineOptions): Promise<void> {
  return withProjectScope(project_id, () => runPipelineScoped(project_id, options));
}

async function runPipelineScoped(project_id: string, options?: RunPipelineOptions): Promise<void> {
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
  // Wall clock, not CPU time: "how long until I have a video" is the question this
  // answers, and it is measured from here so a queue wait would show up too.
  const renderStartedMs = Date.now();
  const imagesBefore = countGeneratedImages(await loadProject(project_id).catch(() => undefined));
  logEvent('render_started', project_id, { preview: options?.preview === true, mode: options?.mode ?? 'production' });

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
      progressBus.emit({
        projectId: project.project_id!,
        stage: 'init',
        message: `${staleSceneIds.size} scene(s) changed, ${unchangedCount} reusing cached output`,
        sceneTotal: (project.scenes || []).length,
        // No `reused` flag: this is a summary of the whole run, and a badge saying
        // "regenerating" against it read as though all of them were.
      });
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

    // A project that already has scenes has an approved script, and images the user may
    // already have approved against it. The render honours both.
    //
    // This used to be an all-or-nothing skip: every scene had to carry both narration
    // and visuals[0].prompt, and if a single one did not, the whole thing fell through
    // to the scripting phase — which overwrites project.script AND project.scenes. A
    // fifteen-scene script with fifteen generated images came back as eight scenes of
    // someone else's writing, and because the original script had been overwritten in
    // the same pass there was nothing left to compare it against. Reproduced again from
    // the image side three days later: six scenes with six approved images in, six
    // regenerated scenes out, image_path gone from every one.
    //
    // Now: repair what is repairable, halt on what is not, and never rewrite. The
    // scripting phase below is reachable only for a project with no scenes at all.
    if ((project.scenes || []).length > 0) {
      const repaired = repairSceneVisuals(project.scenes);
      if (repaired) console.log(`[Orchestrator] Backfilled a visual prompt on ${repaired} scene(s) from their own background/legacy fields`);

      const broken = project.scenes
        .map((scene: any, index: number) => ({ scene, where: `scene ${(scene.order ?? index) + 1}` }))
        .filter(({ scene }: any) => !String(scene.narration_text || '').trim() || !String(scene.visuals?.[0]?.prompt || '').trim());

      if (broken.length) {
        // Halt rather than regenerate. Rewriting the user's script is not a repair —
        // it is a different video, and it used to happen without anyone being told.
        const approvedImages = project.scenes.filter((s: any) => s.image_path).length;
        throw new Error(
          `This project has ${project.scenes.length} approved scenes, but ${broken.length} of them cannot be rendered as they stand: `
          + `${broken.map(({ where, scene }: any) => `${where} is missing ${!String(scene.narration_text || '').trim() ? 'narration' : 'a visual prompt'}`).join('; ')}. `
          + `Fix those scenes, or clear the scene list if you want the script rewritten from scratch. `
          + `The render stopped instead of rewriting your script`
          + (approvedImages ? ` and replacing your ${approvedImages} approved image(s).` : '.'),
        );
      }

      if (project.status === 'draft' || project.status === 'pending' ||
          project.status === 'scripting' || project.status === 'scene_parsing') {
        console.log(`[Orchestrator] ${project.scenes.length} approved scenes — skipping scripting and scene_parsing, jumping to generating_assets`);
        project.status = 'generating_assets';
      }
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
      // The renderer reads the same bibles the studio agents do, so a project
      // started from the dashboard writes in the same voice as a handed-off one.
      const knowledgeDocs = await loadKnowledgeDocuments(project!.userId);
      const { rawScript, scenes: drafts } = await withRetry(
        () => ScriptwriterAgent.writeScript(project!, directorPlan, project!.storyArc, knowledgeDocs),
        { retries: 2 },
      );
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
      // Read the script for its setting once, before any image is generated. One short
      // call per render, not per scene, and only for projects with no universe to say
      // it for them. Cached on the project so a re-render reuses the same answer and
      // the two halves of a video cannot disagree about where they are set.
      if (needsVisualContext(project) && (project as any).visual_context === undefined) {
        try {
          (project as any).visual_context = await inferVisualContext(project.topic || '', project.script || '');
          console.log(`[Orchestrator] Visual context: ${(project as any).visual_context || '(the script names no particular setting)'}`);
        } catch (contextErr: any) {
          // Never fatal: without it the imagery is what it was before this existed.
          (project as any).visual_context = '';
          console.warn('[Orchestrator] Visual context inference failed:', contextErr?.message);
        }
        await guardedSaveProjectState(project, signal);
      }

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
          progressBus.emit({
            projectId: project!.project_id!,
            stage: 'scene',
            message: `Scene ${sceneIndex} of ${totalScenes}`,
            sceneIndex, sceneTotal: totalScenes,
          });
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
        //
        // ensureBackgroundPrompt is what actually decides this, and it runs inside
        // processSingleScene — i.e. AFTER this test. So a pipeline-created project,
        // where every scene gets its background_prompt derived from the visual prompt,
        // read as "no Stage 2 scenes here" and went down the parallel branch. Harmless
        // until UPSCALE_IMAGES was switched on: three Real-ESRGAN processes then ran at
        // once, each ~2.5GB, and every one of them blew past UPSCALE_TIMEOUT_MS. Measured
        // on a 7-scene episode — 12 of 13 upscales lost to timeouts and ~62 minutes of a
        // 76-minute render spent producing nothing, against 151.7s for the one that
        // happened to run alone. Deriving it here first makes the test see the truth;
        // the call in processSingleScene then finds the field set and returns false.
        for (const s of batch) ensureBackgroundPrompt(s);
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

    if (project.status === 'stitching_video' && options?.beforeStitch) {
       // Everything above is per-scene work already paid for; everything below is the
       // full-length encode. This is the last point where stopping costs nothing more.
       const reasons = await options.beforeStitch(project);
       if (reasons.length) throw new Error(`Pre-render check failed: ${reasons.join('; ')}`);
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
    // Always terminal, on every exit path. A stream that just stops leaves the user
    // watching a spinner that will never resolve, which is the thing this replaces.
    // error_log carries the pipeline's real reason rather than a generic phase message.
    const finished = project?.status;

    // Analytics terminal event, here for the same reason the SSE one is: every exit
    // path passes through this block, including the throws. imagesGenerated is the
    // delta over the run, so a fully cached re-render correctly records zero cost.
    const durationSec = Number(((Date.now() - renderStartedMs) / 1000).toFixed(1));
    const imagesGenerated = Math.max(0, countGeneratedImages(project) - imagesBefore);
    if (finished === 'cancelled') {
      logEvent('render_cancelled', project_id, { durationSec, imagesGenerated });
    } else if (finished === 'failed') {
      logEvent('render_failed', project_id, {
        durationSec, imagesGenerated, error: project?.error_log || 'Render failed',
      });
    } else {
      logEvent('render_completed', project_id, {
        durationSec, imagesGenerated,
        estimatedCostUsd: estimateCostUsd(imagesGenerated),
        status: finished, scenes: project?.scenes?.length ?? 0,
        qualityScore: project?.quality_score ?? null,
      });
    }

    progressBus.emit({
      projectId: project_id,
      stage: finished === 'cancelled' ? 'cancelled' : finished === 'failed' ? 'failed' : 'done',
      message: project?.current_action
        || (finished === 'failed' ? 'Render failed' : 'Render complete'),
      error: finished === 'failed' ? (project?.error_log || 'Render failed') : undefined,
      percent: finished === 'failed' || finished === 'cancelled' ? undefined : 100,
    });
  }
}


/**
 * Guarantees the invariant every renderer downstream assumes: a scene has a
 * background_prompt. Returns true if it had to derive one.
 *
 * Four places build scenes — projectController's two editor paths, StoryboardAgent,
 * and the legacy generateScenes — and only the editor ones set the field. Everything
 * that makes a render look finished hangs off it: the aesthetic suffix carrying
 * "absolutely no text, no words, no numbers ... anywhere in the image" is appended to
 * background_prompt and to nothing else, and a scene without a background_path never
 * gets flagged `unified`, so it renders on the legacy ffmpeg compositor at 30fps
 * instead of Metro V4 at 24 with its vignette, grain and grade.
 *
 * Deriving from visuals[0].prompt is exactly what projectController already does
 * (`s.background_prompt || ... || s.visuals?.[0]?.prompt`) — this puts the same
 * fallback on the path that skipped it.
 */
export function ensureBackgroundPrompt(scene: Scene): boolean {
  if (String(scene.background_prompt || '').trim()) return false;
  const visualPrompt = String(scene.visuals?.[0]?.prompt || '').trim();
  if (!visualPrompt) return false;
  scene.background_prompt = visualPrompt;
  return true;
}

/**
 * Makes the image the user approved in the editor the one the render uses.
 *
 * `scene.image_path` is where generateSceneImage and saveSceneImage record the
 * approved picture, and until now nothing in the render ever read it. The render
 * wrote it (renderVisualClip, below) and never consulted it, so it was a UI
 * breadcrumb rather than a decision.
 *
 * That mattered because the pre-render cleanup around line 700 wipes every other
 * trace of the approval before the assets phase starts: it clears
 * `scene.background_path` unconditionally, clears `visual.rendered_path` whenever
 * it is a local path — which is exactly where screen 4 puts the approved image
 * under STORAGE_MODE=local — and then resets `visual.status` from 'completed'
 * back to 'pending' unless the asset is a .mp4. The comment there says "generated
 * images (asset_path) are kept", and screen 4 does not write asset_path.
 *
 * With every signal erased, the background gate below saw a scene with a prompt
 * and no background and generated a fresh image, the NARRATOR branch adopted that
 * image as the whole frame, and the approved one was orphaned. Measured on a real
 * project: 9 images approved at 16:28, 9 different images generated at 16:31-16:44,
 * and the video shipped the second set.
 *
 * Returns 'adopted' when the approved image is now the visual's asset, 'none' when
 * the scene never had one, and 'missing' when it had one that is no longer on disk
 * — which the caller turns into a halt rather than a silent substitution.
 */
export type ApprovedImage = 'adopted' | 'none' | 'missing';

export function adoptApprovedImage(scene: any): ApprovedImage {
  const approved = String(scene?.image_path || '').trim();
  if (!approved) return 'none';
  const visual = scene?.visuals?.[0];
  if (!visual) return 'none';
  // A remote URL cannot be stat'd here; renderVisualClip downloads it. Only a local
  // path can be checked, and a local path that has gone is the case worth halting on.
  const isRemote = /^https?:\/\//i.test(approved);
  if (!isRemote && !fs.existsSync(approved)) return 'missing';
  visual.asset_path = approved;
  visual.status = 'completed';
  // The approved image IS the whole frame — exactly what the NARRATOR branch means when
  // it sets this after generating a background. That branch is unreachable here: it sits
  // behind `if (visual.status === 'completed') return`, and adopting is what makes the
  // visual completed. Without setting it here, renderVisualClip's Metro V4 gate
  // (`scene?.unified && USE_METRO_V4`) is false for every approved-image scene and the
  // render drops to the legacy ffmpeg compositor — 30fps, no vignette, no grain, no
  // grade. Approving an image would have quietly cost the whole grade.
  (scene as any).unified = true;
  return 'adopted';
}

export async function processSingleScene(scene: Scene, project: Project, voicePreset: string, isPreview: boolean, isTestMode: boolean, signal?: AbortSignal, characterAnchors: Map<string, string> = new Map()) {
  // Check for cancellation at start of scene
  if (signal?.aborted) throw new Error('PIPELINE_CANCELLED');

  // An image the user approved in the editor is the image that renders. Same rule the
  // script already follows: what was approved is not re-derived, and a scene that
  // genuinely cannot be rendered stops the run by name instead of quietly becoming
  // something else.
  //
  // This runs FIRST of the three guards below. Adopting marks the visual 'completed',
  // which is what stops the visual-context and art-style passes rewriting the prompt of
  // a scene whose picture is already chosen — the prompt the user approved stays the
  // prompt the editor shows.
  const approvedImage = adoptApprovedImage(scene);
  if (approvedImage === 'missing') {
    const where = `scene ${(scene.order ?? 0) + 1}`;
    throw new Error(
      `The approved image for ${where} is no longer on disk (${scene.image_path}). ` +
      `The render stopped rather than generating a different image in its place — ` +
      `regenerate that scene's image in the editor, then render again.`,
    );
  }
  if (approvedImage === 'adopted') {
    console.log('[Orchestrator] Using the approved editor image for scene', scene.scene_id, '—', path.basename(String(scene.image_path)));
  }

  // The B-roll cutaway: one scene of the episode shows the real, licence-verified
  // photograph of the thing being talked about instead of a generated impression of it.
  //
  // Resolved here rather than at the assets stage below, because the point is to NOT
  // generate an image for this scene. resolveEntityImage is idempotent and deduplicated —
  // it is designed to be called from every scene — so asking early costs one shared
  // lookup, and asking at all is free for a project that names nothing.
  //
  // cutawayIndex owns every condition; see it for why this is at most one scene and never
  // the open, the close, or a scene the user approved an image for. Nothing is sourced
  // here: it promotes the file the name-card had already licence-checked, so there is one
  // licensing path in this codebase and this is not a second one.
  await resolveEntityImage(project, signal);
  const cutaway = cutawayIndex(project);
  if (cutaway >= 0 && (project.scenes || [])[cutaway]?.scene_id === scene.scene_id) {
    const sourced = (project as any).entity_image?.image;
    const local = String(sourced?.localPath || '').trim();
    if (local && fs.existsSync(local) && scene.visuals?.[0]) {
      scene.visuals[0].asset_path = local;
      scene.visuals[0].status = 'completed';
      // Same reason adoptApprovedImage sets it: the picture IS the whole frame, and
      // without this the render drops to the legacy compositor and loses the grade.
      (scene as any).unified = true;
      console.log(
        `[Orchestrator] Cutaway on scene ${cutaway + 1}: ${sourced.title} (${sourced.licenseShortName},`,
        `credit ${sourced.attributionRequired ? 'required — drawn on the name-card' : 'not required'})`,
      );
    } else {
      console.log('[Orchestrator] Cutaway scene had no usable local file — generating imagery as normal');
    }
  }

  // What the script says about where and when this is set. A universe supplies this
  // through its cast bible; a project without one has only its own script, and without
  // reading it a scene like "a resolute statesman delivering a speech" is drawn with
  // whatever faces the image model reaches for by default.
  //
  // This has to run BEFORE ensureBackgroundPrompt, which copies visuals[0].prompt into
  // background_prompt: the background gate below generates from background_prompt, and
  // on a NARRATOR scene that background becomes the whole frame. Applied after it — as
  // it was until ensureBackgroundPrompt existed — the context reached only the character
  // path, which a unified scene never takes, so the one image the viewer sees was drawn
  // without it.
  const visualContext = String((project as any).visual_context || '');
  if (visualContext && scene.visuals[0] && (scene.visuals[0] as any).status !== 'completed') {
    const withContext = applyVisualContext(scene.visuals[0].prompt || '', visualContext);
    if (withContext !== scene.visuals[0].prompt) {
      scene.visuals[0].prompt = withContext;
      console.log(`[Orchestrator] Visual context applied to scene ${scene.scene_id}: ${visualContext}`);
    }
  }

  // Consecutive shots have to LOOK different or the cut does not read as one. Measured
  // at a stricter scene-detection threshold, only 67% of this pipeline's cuts were
  // separable against the reference's 100% — two adjacent stills of the same subject
  // came back framed almost identically, so there was nothing at the boundary for a
  // detector or an eye to catch.
  //
  // Same guard as the visual context above: a completed visual is an approved or adopted
  // image and is never regenerated, so its prompt must not be rewritten either. And
  // applyShotFraming leaves a prompt that already states its own framing alone — a shot
  // the script chose outranks a positional cycle.
  const framingIndex = (project.scenes || []).findIndex((s: any) => s.scene_id === scene.scene_id);
  if (framingIndex >= 0 && scene.visuals[0] && (scene.visuals[0] as any).status !== 'completed') {
    const framed = applyShotFraming(scene.visuals[0].prompt || '', framingIndex);
    if (framed !== scene.visuals[0].prompt) {
      scene.visuals[0].prompt = framed;
      console.log(`[Orchestrator] Shot framing for scene ${framingIndex + 1}: ${framed.slice(framed.lastIndexOf(', ') + 2)}`);
    }
  }

  // Every scene renders through the "unified" path — the background image IS the
  // frame — and that path is gated on background_prompt being set. Four places build
  // scenes (projectController x2, StoryboardAgent, the legacy generateScenes) and only
  // the two editor ones set it, so every pipeline-created project silently fell through
  // to the legacy ffmpeg compositor: 30fps instead of Metro V4's 24, no vignette, no
  // grain, no grade, and — because the aesthetic suffix is appended to background_prompt
  // and nothing else — no "absolutely no text in the image" instruction. Measured on two
  // renders driven through POST /pipeline/run: garbled pseudo-text in 4 of 6 and 4 of 7
  // shots, against 0 of 10 on the editor-path video that shipped to YouTube.
  //
  // The guard belongs here rather than in the four constructors: this is the one function
  // every scene reaches, whoever built it, so a fifth constructor cannot reintroduce it.
  if (ensureBackgroundPrompt(scene)) {
    console.log('[Orchestrator] background_prompt derived from visual prompt for scene', scene.scene_id);
  }


  // Strip `NAME:` prefixes once, here, before TTS, captions and the overlay all
  // read narration_text. Patching any one of those three leaves the other two
  // still speaking or printing the prefix — a rendered frame showed the caption
  // "RAVI: This staging" and another the overlay "ARJUN: It's just a routine
  // refresh for". Character attribution is already resolved at storyboard time,
  // so nothing downstream still needs the marker.
  {
    const spoken = stripSpeakerPrefix(scene.narration_text);
    if (spoken !== scene.narration_text) {
      console.log('[Orchestrator] stripped speaker prefix from scene', scene.scene_id);
      scene.narration_text = spoken;
      // caption_text is a copy of the narration at every constructor; keep them equal.
      if ((scene as any).caption_text) (scene as any).caption_text = spoken;
    }
  }

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
     emitScene(project, scene, 'tts',
       audioFresh ? 'Narration already recorded' : 'Recording narration', audioFresh);
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

  // `approvedImage === 'adopted'` is the whole point of the guard: a scene whose
  // picture the user already chose must not have a second one generated behind it.
  // The pre-render cleanup clears background_path on every run, so without this the
  // condition below is always true for an editor project and the approved image is
  // replaced on every single render.
  if (scene.background_prompt && !scene.background_path && !(scene as any).unified && approvedImage !== 'adopted') {
    try {
      const bgArtStyle = (project.universe as any)?.backgroundArtStyle || '';
      // The aspect the render will actually crop to. Both this hint and the API-level
      // aspectRatio below have to agree with it, or the image is generated for the wrong
      // frame and the centre-crop throws most of it away.
      const bgAspect = isShortsProject(project) ? '9:16' : '16:9';
      const aestheticSuffix = (project as any).universeId
        ? INDIAN_AESTHETIC_SUFFIX
        : `cinematic lighting, clean professional style, suitable for educational content, main subject centered with generous margins on all sides (frame edges will be cropped to ${bgAspect === '16:9' ? '16:9 landscape' : '9:16 vertical'}), absolutely no text, no words, no numbers, no lettering, no typography anywhere in the image`;
      const fullBgPrompt = [scene.background_prompt, aestheticSuffix, bgArtStyle].filter(Boolean).join(', ');
      console.log('[Orchestrator] Background full prompt:', fullBgPrompt.slice(0, 120));
      // aspectRatio was missing here, and generateImageBase64 defaults to 9:16 without
      // it. So every background in a 16:9 project came back 768x1344 portrait, and the
      // cover-crop to 1920x1080 kept only the middle 32% of the height — which is the
      // "top of the image is cut off" report. assetService and projectController both
      // already pass it; this was the one caller that did not.
      const bgBase64 = await AIService.generateImageBase64(fullBgPrompt, {
        aspectRatio: bgAspect,
        isStoryEpisode: !!(project as any).universeId,
      });
      if (bgBase64) {
        const bgBuffer = await stripLetterbox(Buffer.from(bgBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
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
    // The share is weighted by what the beat is doing, not only by how much was
    // written in it. Word count alone makes the edit a function of sentence length and
    // nothing else: a hook and a close of equal length get equal time, which is the one
    // thing a professional edit never does. The weights renormalise against the same
    // total below, so every scene's share still sums to exactly `target` — this moves
    // hold time between beats, it does not add any.
    const target = targetLengthSeconds(project.settings?.targetLength);
    const here = project.scenes.findIndex((s: any) => s.scene_id === scene.scene_id);
    const share = beatShares(project.scenes, target)[here] ?? 0;
    const plan = planScenePadding([audioDur], share);
    holdDuration = plan.durations[0];
    (scene as any).pad_seconds = Number((holdDuration - audioDur).toFixed(3));
    if (!plan.reachedTarget) {
      console.warn(`[TargetLength] Scene ${scene.scene_id} needs ${share.toFixed(1)}s of the requested ${target}s but its narration is only ${audioDur.toFixed(1)}s — capped at ${plan.total.toFixed(1)}s (${MAX_PAD_FACTOR}x narration). Not padding with silence: the script is too short for ${target}s.`);
    } else if (holdDuration > audioDur) {
      console.log(`[TargetLength] Scene ${scene.scene_id}: holding still ${(holdDuration - audioDur).toFixed(2)}s past narration (${audioDur.toFixed(2)}s → ${holdDuration.toFixed(2)}s) toward the ${target}s target`);
    }
  }

  // A real brand asset for the tool this episode is about, if the script names one and
  // Commons has a safely-licensed image of it. Resolved once per project (the call is
  // idempotent and de-duplicated, so the batch's other two scenes wait on the same
  // lookup rather than making their own), before any overlay is planned — the name-card
  // treatment reads the result synchronously. It never throws: no image just means the
  // generated imagery renders exactly as it did before.
  await resolveEntityImage(project, signal);

  // Measure the speech span before the clip is rendered, not after.
  //
  // The motion-graphics overlay is drawn INTO the clip by the engine, so "when is this
  // word actually spoken" has to be known while there are still frames to draw on. This
  // is the same measurement assembleSceneSegment makes, moved one step earlier and
  // cached — assembly reuses the WAV rather than re-encoding it.
  if (scene.narration_path && fs.existsSync(scene.narration_path)) {
    await prepareSceneAudio(scene, scene.narration_path, project, signal);
  }

  for (const visual of scene.visuals) {
    let existingRendered = (visual as any).rendered_path as string | undefined;
    // A clip rendered with a different Cinematic Effect is not this scene's clip.
    // The motion is part of the clip's path, so a mismatch means the stored one was
    // built with the old movement — drop it rather than skip the render and ship it.
    if (existingRendered?.endsWith('.mp4')) {
      // Same key renderVisualClip will compute, overlay included — a clip whose kinetic
      // text belongs to an older version of this narration is not this scene's clip.
      const expected = visualClipPath(
        path.join(os.tmpdir(), 'ais-renderer'),
        String(project.project_id),
        visual.visual_id,
        (visual as any).motion_instruction,
        sceneVisualKey(scene, project, holdDuration > 0 ? holdDuration : (visual.duration_target || 5)),
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
    // A multi-frame visual keeps its images on the frames, never on the visual — the
    // generation branch above sets frame.asset_path and nothing else. Gating the clip
    // render on visual.asset_path alone therefore skipped every frame-based scene
    // silently: renderVisualClip is the function that knows how to concat frames, and
    // it was never called, so the scene reached assembly with no clip and failed as
    // "no image was generated" while its images sat on disk.
    const frames = (visual as any).frames as Array<{ asset_path?: string }> | undefined;
    const hasFrameAssets = Array.isArray(frames) && frames.length > 1 && frames.some((f) => f?.asset_path);
    if (!isLocalMp4 && ((visual as any).asset_path || hasFrameAssets)) {
      if (signal?.aborted) throw new Error('PIPELINE_CANCELLED');
      // Ken Burns reads duration_target, the engines read the passed duration —
      // both must cover the hold or assembleSceneSegment would loop the clip.
      if (holdDuration > 0) visual.duration_target = holdDuration;
      const renderedLocal = await renderVisualClip(visual, project, signal, scene, holdDuration > 0 ? holdDuration : undefined);
      if (renderedLocal) (visual as any).rendered_path = renderedLocal;
    } else if (isLocalMp4) {
      console.log('[Orchestrator] Visual already rendered, skipping:', path.basename(existingRendered!));
      emitScene(project, scene, 'synthesis', 'Animation already rendered', true);
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
       const anyImage = visual?.asset_path || (visual?.frames || []).find((f: any) => f?.asset_path)?.asset_path;
       scene.error_log = anyImage
         ? `Scene visual was never rendered to video (image exists at ${path.basename(String(anyImage))}). The clip render step did not produce a file.`
         : `No image was generated for this scene, so there was nothing to render. Check the image provider logs — the Visual Style and prompt are set, but no asset was produced.`;
       return;
     }

     if (scene.segment_path && fs.existsSync(scene.segment_path)) {
       console.log('[Orchestrator] Reusing segment:', scene.segment_path.slice(-40));
       emitScene(project, scene, 'segment', 'Video segment already built', true);
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
        duration: scene.duration_actual || 0,
        // The scene itself, not just its file. stitchScenes needs to know what beat
        // each segment is and what overlay it carries — the effects layer decides
        // where a cut is worth marking from exactly that, and a list of paths and
        // durations cannot answer it.
        scene,
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
      progressBus.emit({ projectId: activeProject.project_id!, stage: 'quality_gate',
        message: 'Running quality checks', percent: 95 });
      const gate = await runQualityGate(activeProject);
      activeProject.quality_gate = gate;
      activeProject.quality_score = gate.score;

      for (const check of gate.checks) {
        console.log(`[QualityGate] ${check.status.toUpperCase().padEnd(7)} ${check.label} — ${check.detail}`);
      }

      // Publishing metadata, if nothing has produced any yet. Only the two manual
      // "generate script" endpoints ever set this, so a project rendered by the
      // pipeline or the scheduler reached YouTube as "Untitled" with an empty
      // description and no tags — measured, on video ljNF9y-GHeU. Here rather than
      // at publish time so it lands on the record where it can be reviewed and
      // edited before anything goes out.
      if (!activeProject.seo_metadata?.title) {
        const seo = await generateSeoMetadata(activeProject);
        if (seo) {
          activeProject.seo_metadata = seo;
          console.log(`[SeoAgent] Publishing metadata ready: "${seo.title}" (${seo.tags.length} tags)`);
        }
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
      // The gate verdict is its own event: the score is the number worth trending, and
      // which check failed is the thing you want when the trend turns.
      logEvent('quality_gate', project_id, {
        passed: gate.passed,
        score: gate.score,
        failures: gate.failures,
        failedChecks: gate.checks.filter((c: any) => c.status === 'fail').map((c: any) => c.label),
      });

      console.log(`[Orchestrator] Final video saved to: ${activeProject.output_path}`);

      // Started here and not awaited: the project is already complete and already
      // playable. A 34 MB episode takes ~20s to push at the measured 1.76 MB/s, and no
      // one should wait on that to see their video.
      if (activeProject.cloud_backup?.status === 'pending') {
        progressBus.emit({ projectId: activeProject.project_id!, stage: 'cloud_backup',
          message: 'Backing up to cloud storage (the video is already ready)', percent: 100 });
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
    // Asking for the visuals to be regenerated revokes the approval. adoptApprovedImage
    // treats scene.image_path as authoritative, so leaving it set here would resurrect
    // the picture the user just asked to replace.
    scene.image_path = undefined;
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

  // 2. Reset visual. Same as regenerateScene: an explicit regenerate revokes the
  // approved image, or adoptApprovedImage would hand the old one straight back.
  if (scene.visuals[0]?.visual_id === visual_id) (scene as any).image_path = undefined;
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
