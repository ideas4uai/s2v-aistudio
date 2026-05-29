import { Project } from '../models/project.js';
import { StyleProfile } from '../models/types.js';
import { Scene, Visual, VisualFrame } from '../models/scene.js';
import { calculateQualityScore } from '../services/qualityService.js';
import * as fs from 'fs';
import * as path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import ffmpegStatic from 'ffmpeg-static';

const execAsync = promisify(exec);
const ffmpegPath = ffmpegStatic as string;
import { withRetry } from '../utils/retry.js';
import { v4 as uuidv4 } from 'uuid';
import { fallbackHook, fallbackScript, fallbackSceneGraph } from './fallbacks.js';
import { generateSceneAudio } from '../services/voiceService.js';
import { generateCaptions } from '../services/captionService.js';
import { generateAsset } from '../services/assetService.js';
import { renderVisualClip, validateVisualClip, assembleSceneSegment, renderCaptions, stitchScenes } from '../services/renderService.js';
import { generateHash, generateAudioHash, generateVisualHash, generateSceneHash, generateAssetHash } from '../utils/hash.js';
import { getScenesToRender } from '../utils/diff.js';
import { getFromCache } from '../services/cacheService.js';
import { logUserEvent } from '../services/logService.js';
import { buildSceneTimeline } from '../utils/timeline.js';
import { QuotaService } from '../server/services/quotaService.js';
import { AIService } from '../services/aiService.js';
import { FirestoreService } from '../server/db/firestore.js';
import { DirectorAgent } from './agents/directorAgent.js';
import { ScriptwriterAgent } from './agents/scriptwriterAgent.js';
import { StoryboardAgent } from './agents/storyboardAgent.js';
import { WorldAgent } from './agents/worldAgent.js';
import { abortManager } from './abortManager.js';

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

export async function loadProject(project_id: string): Promise<Project> {
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

export async function saveProjectState(project: Project): Promise<void> {
  const errorMsg = project.error_log ? ` ErrorLog: ${project.error_log}.` : '';
  console.log(`[DB] Saving project state for ${project.project_id}. Status: ${project.status}.${errorMsg} Scenes count: ${project.scenes?.length || 0}`);
  
  try {
     project.updated_at = new Date();
     await FirestoreService.saveProject(project);
     console.log(`[DB] Project state synced to Firestore. Status: ${project.status}`);
  } catch (err) {
     console.error(`[DB] Failed to sync project ${project.project_id} to Firestore:`, err);
  }
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

async function updateProgress(project: Project, action: string, percent?: number) {
  await guardedSaveProjectState(project);

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

async function guardedSaveProjectState(project: Project) {
  const freshProject = await loadProject(project.project_id);
  if (freshProject.is_cancelled || freshProject.status === 'cancelled') {
    project.is_cancelled = true;
    project.status = 'cancelled';
    throw new Error('PIPELINE_CANCELLED');
  }
  await saveProjectState(project);
}

// Global map to track running pipelines per project
const runningPipelines = new Set<string>();

export async function runPipeline(project_id: string, options?: { preview?: boolean, mode?: 'test' | 'production' }): Promise<void> {
  console.log('[Orchestrator] runPipeline called for:', project_id);
  if (runningPipelines.has(project_id)) {
    console.log(`[Orchestrator] A pipeline is already running for project ${project_id}. Skipping.`);
    return;
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
    project = loadedProject;

    if (project.status === 'completed') {
      console.log(`[Orchestrator] Project ${project.project_id} already completed.`);
      return;
    }

    // Allow re-runs from cancelled or failed state
    if (project.status === 'cancelled' || project.status === 'failed') {
      console.log(`[Orchestrator] Resetting project ${project.project_id} from '${project.status}' to 'draft' for re-run.`);
      project.status = 'draft';
      project.error_log = null;
    }

    // Reset cancellation if starting fresh
    project.is_cancelled = false;
    project.logs = [];
    await updateProgress(project, 'Initializing pipeline...', 5);

    // --- PHASE 0: Storage Connectivity Probe ---
    if (!isTestMode) {
      try {
        await updateProgress(project, 'Testing cloud connectivity...', 7);
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
      await guardedSaveProjectState(project);
    }

    // Status Transitions (only reached when no existing scenes)
    if (project.status === 'draft' || project.status === 'pending') {
      project.status = 'scripting';
      await guardedSaveProjectState(project);
    }
    
    if (project.status === 'scripting') {
      console.log(`[Orchestrator] Phase: scripting — calling DirectorAgent.planVideo`);
      await updateProgress(project, 'AI is drafting the script and visual direction...', 10);
      const directorPlan = await withRetry(() => DirectorAgent.planVideo(project!), { retries: 2 });
      console.log(`[Orchestrator] DirectorAgent.planVideo complete`);
      console.log(`[Orchestrator] Phase: scripting — calling ScriptwriterAgent.writeScript`);
      await updateProgress(project, 'Refining narrative structure...', 15);
      const { rawScript, scenes: drafts } = await withRetry(() => ScriptwriterAgent.writeScript(project!, directorPlan), { retries: 2 });
      console.log(`[Orchestrator] ScriptwriterAgent.writeScript complete, ${drafts.length} draft scenes`);
      project.script = rawScript;
      
      console.log(`[Orchestrator] Phase: scripting — calling WorldAgent.analyzeWorld`);
      await updateProgress(project, 'Identifying world entities for consistency...', 20);
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
      await guardedSaveProjectState(project);
    }

    if (project.status === 'scene_parsing') {
      console.log(`[Orchestrator] Phase: scene_parsing — calling StoryboardAgent.expandVisuals`);
      await updateProgress(project, 'Breaking script into visual scenes...', 30);
      const directorPlan = { character_consistency: project.character_description || 'N/A', pacing: project.pacing_intensity, scene_count: project.scenes?.length || 5 };
      
      // Re-map from the temporary scenes we saved
      const drafts = (project.scenes || []).map((s: any) => ({
         order: s.order,
         narration: s.narration_text,
         visual: s.visuals?.[0]?.prompt || ''
      }));

      await updateProgress(project, 'Expanding visual prompts for image generation...', 35);
      const scenes = await withRetry(() => StoryboardAgent.expandVisuals(project!, directorPlan as any, drafts), { retries: 2 });
      console.log(`[Orchestrator] StoryboardAgent.expandVisuals complete, ${scenes.length} scenes`);
      project.scenes = scenes;
      project.status = 'generating_assets';
      await guardedSaveProjectState(project);
    }

    if (project.status === 'generating_assets') {
      await updateProgress(project, 'Generating AI assets (Images & Audio)...', 40);
      
      const scenesToProcess = project.scenes.filter(s => s.status !== 'completed' && s.status !== 'degraded');
      
      // Process in small batches to preserve CPU and respect rate limits
      const batchSize = 3; 
      for (let i = 0; i < scenesToProcess.length; i += batchSize) {
        if (signal.aborted) throw new Error('PIPELINE_CANCELLED');
        const batch = scenesToProcess.slice(i, i + batchSize);
        const progress = 40 + Math.floor((i / scenesToProcess.length) * 40);
        await updateProgress(project, `Processing scene batch ${Math.floor(i/batchSize) + 1} of ${Math.ceil(scenesToProcess.length/batchSize)}...`, progress);
        
        await Promise.all(batch.map(async (scene) => {
          // Inner cancellation check
          if (signal.aborted) throw new Error('PIPELINE_CANCELLED');

          const sceneIndex = project!.scenes.indexOf(scene) + 1;
          const totalScenes = project!.scenes.length;
          console.log(`[Orchestrator] Processing scene ${sceneIndex} of ${totalScenes} (${scene.scene_id})`);
          scene.status = 'processing';
          await guardedSaveProjectState(project!);

          try {
            await processSingleScene(scene, project!, 'default_preset', isPreview, isTestMode, signal);
            console.log(`[Orchestrator] Scene ${sceneIndex} of ${totalScenes} complete`);
          } catch (e) {
            if (e instanceof Error && e.message === 'PIPELINE_CANCELLED') throw e;
            console.error(`Scene ${scene.scene_id} failed:`, e);
            scene.status = 'failed';
          }
        }));

        // Small delay between batches
        if (i + batchSize < scenesToProcess.length) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      const allAssetsSuccess = project.scenes.every(s => s.status === 'completed' || s.status === 'degraded');

      if (!allAssetsSuccess) {
         await validateProjectAssets(project, signal);
      }
      
      const finalCheckSuccess = project.scenes.every(s => s.status === 'completed' || s.status === 'degraded');

      if (finalCheckSuccess) {
         project.status = 'stitching_video';
         await guardedSaveProjectState(project);
      } else {
         project.status = 'failed';
         await guardedSaveProjectState(project);
         throw new Error("Asset generation phase failed for some scenes.");
      }
    }

    if (project.status === 'stitching_video') {
       await updateProgress(project, 'Stitching scenes together into final video...', 85);
       await concatFinalVideo(project_id, isPreview, signal);

       if (signal.aborted) throw new Error('PIPELINE_CANCELLED');

       // Reload from Firestore — concatFinalVideo saves status='completed' and output_path
       // on its own local copy; without this reload the stale local project would overwrite both.
       const finalState = await loadProject(project_id);
       project.status = finalState.status;
       project.output_path = finalState.output_path;
       project.quality_score = finalState.quality_score;

       await updateProgress(project, 'Video generation complete!', 100);
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


export async function processSingleScene(scene: Scene, project: Project, voicePreset: string, isPreview: boolean, isTestMode: boolean, signal?: AbortSignal) {
  // Check for cancellation at start of scene
  if (signal?.aborted) throw new Error('PIPELINE_CANCELLED');

  scene.stage = 'audio_and_visuals';
  if (!scene.audio_hash) scene.audio_hash = generateAudioHash(scene.narration_text, voicePreset, (scene as any).character);
  
  const audioPromise = (async () => {
     if (!scene.narration_path || !scene.narration_path.startsWith('http')) {
        console.log(`[Orchestrator] Generating audio for scene ${scene.scene_id}`);
        const audioLocal = await withRetry(() => generateSceneAudio(scene, voicePreset, scene.audio_hash!, project.settings), { retries: 2 });
        console.log(`[Orchestrator] Audio complete for scene ${scene.scene_id}: ${audioLocal ? 'ok' : 'null'}`);
        if (audioLocal) {
           // Upload audio to GCS
           try {
              const fileData = await fs.promises.readFile(audioLocal);
              const extension = path.extname(audioLocal).toLowerCase() || '.mp3';
              const mimeType = extension === '.wav' ? 'audio/wav' : 'audio/mpeg';
              scene.narration_path = await FirestoreService.uploadAsset(project.project_id!, `${scene.scene_id}_audio${extension}`, fileData, mimeType);
              // Keep local for ffmpeg stitching, but store URL in db
           } catch(e) {
              console.log(`Failed to upload audio to GCS for ${scene.scene_id}:`, e);
              scene.narration_path = audioLocal;
           }
        }
     }
  })();

  console.log('[Orchestrator] Scene character:', (scene as any).character, 'visual referenceUrl:', scene.visuals?.[0]?.referenceImageUrl ? 'SET' : 'NOT SET');

  // Derive referenceImageUrl from universe if missing on visuals
  if (project.universe && (scene as any).character) {
    const charName = (scene as any).character as string;
    const matchedChar = (project.universe as any).characters
      ?.find((c: any) => c.name.toUpperCase() === charName.toUpperCase());
    if (matchedChar?.referenceImageUrl) {
      scene.visuals.forEach((v: any) => {
        if (!v.referenceImageUrl) {
          v.referenceImageUrl = matchedChar.referenceImageUrl;
          v.cache_key = ''; // force hash recompute so new reference produces fresh image
        }
      });
      console.log('[Orchestrator] Reference image injected for character:', charName);
    }
  }

  const visualsPromise = Promise.all(scene.visuals.map(async (visual, i) => {
     if (visual.status === 'completed') return;
     visual.status = 'processing';

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
           try {
             const fileData = await fs.promises.readFile(localAsset);
             const remoteUrl = await FirestoreService.uploadAsset(project.project_id!, `${frame.frame_id}.png`, fileData, 'image/png');
             frame.asset_path = remoteUrl;
           } catch(e) {
             frame.asset_path = localAsset;
           }
         }
       }));
       if (i === 0 && visual.frames[0]?.asset_path) scene.image_path = visual.frames[0].asset_path;
     } else {
       // Single-frame path (standard behavior)
       console.log(`[Orchestrator] Generating image for scene ${scene.scene_id}, visual ${i} (${visual.asset_type})`);
       let localAsset = await withRetry(() => generateAsset(visual, visual.cache_key, project.mode, project), { retries: 2 });
       console.log(`[Orchestrator] Image complete for scene ${scene.scene_id}, visual ${i}: ${localAsset ? 'ok' : 'null'}`);
       if (localAsset) {
          try {
             const isVideo = localAsset.endsWith('.mp4');
             const fileData = await fs.promises.readFile(localAsset);
             const remoteUrl = await FirestoreService.uploadAsset(project.project_id!, `${visual.visual_id}${isVideo ? '.mp4' : '.png'}`, fileData, isVideo ? 'video/mp4' : 'image/png');
             visual.asset_path = remoteUrl;
             if (i === 0 && !isVideo) scene.image_path = remoteUrl;
          } catch(e) {
             visual.asset_path = localAsset;
             if (i === 0 && !localAsset.endsWith('.mp4')) scene.image_path = localAsset;
          }
       }
     }

     // Render visual clip — handles both single and multi-frame internally
     const renderedLocal = await renderVisualClip(visual, project, signal);

     // Quick cancellation check after render
     if (signal?.aborted) throw new Error('PIPELINE_CANCELLED');

     if (renderedLocal) {
        visual.rendered_path = renderedLocal;
     }
     visual.status = 'completed';
  }));

  // Wait for both Audio and Visuals to finish concurrently
  await Promise.all([audioPromise, visualsPromise]);

  // 3. Assembly
  scene.stage = 'render';
  if (scene.narration_path) {
     // download URL into local if it's http
     let localAudio = scene.narration_path;
     if (localAudio.startsWith('http')) {
         const res = await fetch(localAudio);
         const buffer = await res.arrayBuffer();
         localAudio = path.join(os.tmpdir(), `${scene.scene_id}_audio_dl.mp3`);
         await fs.promises.writeFile(localAudio, Buffer.from(buffer));
     }

     const sceneRenderedPath = await withRetry(() => assembleSceneSegment(scene, localAudio, scene.cache_key, signal), { retries: 2 });
     if (sceneRenderedPath) {
        scene.segment_path = sceneRenderedPath;
        
        // --- ADDED CAPTIONING LOGIC ---
        if (scene.caption_text) {
           const { chunks } = await generateCaptions(scene, localAudio, 'default');
           scene.caption_chunks = chunks;
           const captionedLocal = await renderCaptions(scene, signal);
           scene.captioned_path = captionedLocal;
           scene.rendered_path = captionedLocal; // Final captioned version
        } else {
           scene.rendered_path = sceneRenderedPath;
        }

        // Upload to GCS
        try {
           const finalFileToUpload = scene.rendered_path || sceneRenderedPath;
           const fileData = await fs.promises.readFile(finalFileToUpload);
           const remoteUrl = await FirestoreService.uploadAsset(project.project_id!, `${scene.scene_id}_segment.mp4`, fileData, 'video/mp4');
           scene.rendered_path = remoteUrl;
           // Keep captioned_path in sync — local file will be deleted, so point to the HTTP URL
           if (scene.captioned_path) scene.captioned_path = remoteUrl;

           // Cleanup local files
           if (finalFileToUpload.startsWith(os.tmpdir())) fs.promises.unlink(finalFileToUpload).catch(() => {});
           if (sceneRenderedPath.startsWith(os.tmpdir()) && sceneRenderedPath !== finalFileToUpload) fs.promises.unlink(sceneRenderedPath).catch(() => {});
        } catch(e) {
           scene.rendered_path = scene.rendered_path || sceneRenderedPath;
        }
     }
     
     if (localAudio.startsWith(os.tmpdir())) {
        fs.promises.unlink(localAudio).catch(() => {});
     }
  }

  scene.status = 'completed';
  scene.stage = 'done';
}

  // --------------------------------------------------------------------------
  // Finalize Pipeline (Phase 4C Step 3D)
  // --------------------------------------------------------------------------
export async function cleanupAssets(project: Project) {
  if (project.status !== 'completed') return;
  console.log(`[Orchestrator] Cleaning up intermediate assets for project ${project.project_id}`);

  const shouldDelete = (path: string) =>
    path.includes('_audio.wav') ||
    path.includes('_segment.mp4');

  for (const scene of project.scenes || []) {
     try {
       if (scene.narration_path?.startsWith('http') && shouldDelete(scene.narration_path)) {
          await FirestoreService.deleteAssetByUrl(scene.narration_path);
       }
       if (scene.rendered_path?.startsWith('http') && shouldDelete(scene.rendered_path)) {
          await FirestoreService.deleteAssetByUrl(scene.rendered_path);
       }
     } catch(e) {
       console.warn(`[Orchestrator] Failed to cleanup scene ${scene.scene_id}:`, e);
     }
  }
}

export async function validateProjectAssets(project: Project, signal?: AbortSignal) {
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
            await processSingleScene(scene, project, 'default_preset', project.preview_mode || false, false, signal);
         } catch (e) {
            console.error(`Recovery generation failed for scene ${scene.scene_id}:`, e);
            scene.status = 'failed';
         }
      }
  }
}

export async function concatFinalVideo(project_id: string, isPreview: boolean = false, signal?: AbortSignal): Promise<void> {
  const activeProject = await loadProject(project_id);
  
  try {
    // 1. Get ordered scenes and 2. Collect scene.segment_path
    const sortedScenes = [...activeProject.scenes].sort((a, b) => a.order - b.order);
    const finalScenes = [];
    const downloadedPaths: string[] = [];

    console.log('[Stitch] Total scenes:', sortedScenes.length);
    for (const scene of sortedScenes) {
      console.log('[Stitch] Scene:', scene.scene_id,
        'status:', scene.status,
        'rendered_path:', scene.rendered_path?.substring(0, 60),
        'captioned_path:', scene.captioned_path?.substring(0, 60),
        'segment_path:', scene.segment_path?.substring(0, 60));
    }

    for (const scene of sortedScenes) {
      if (scene.status !== 'completed' && scene.status !== 'degraded') continue;

      // rendered_path is the authoritative final output (may be a remote URL after upload)
      let videoPath: string | undefined = isPreview
        ? scene.preview_path
        : (scene.captioned_path || scene.rendered_path || scene.segment_path);

      // If captioned_path is a stale local path (deleted after upload), fall back to rendered_path
      if (videoPath && !videoPath.startsWith('http') && !fs.existsSync(videoPath)) {
        console.warn(`[Stitch] captioned_path not found locally for ${scene.scene_id}, falling back to rendered_path`);
        videoPath = scene.rendered_path || scene.segment_path;
      }

      if (!videoPath) continue;

      // If the path is a remote URL, download it locally for FFmpeg
      if (videoPath.startsWith('http')) {
        try {
          const res = await fetch(videoPath);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buf = await res.arrayBuffer();
          const localDl = path.join(os.tmpdir(), 'ais-renderer', `${scene.scene_id}_dl.mp4`);
          fs.mkdirSync(path.dirname(localDl), { recursive: true });
          fs.writeFileSync(localDl, Buffer.from(buf));
          downloadedPaths.push(localDl);
          videoPath = localDl;
        } catch (dlErr) {
          console.warn(`[Orchestrator] Failed to download scene ${scene.scene_id} for stitching:`, dlErr);
          continue;
        }
      }

      if (fs.existsSync(videoPath) && fs.statSync(videoPath).size > 0) {
        finalScenes.push({
          video_path: videoPath,
          duration: scene.duration_actual || 0
        });
      }
    }

    if (finalScenes.length > 0) {
  // 3. Run FFmpeg concat (no re-encode)
      const stitchedVideoPath = await stitchScenes(finalScenes, activeProject, signal);
      
      const fileName = isPreview ? `${activeProject.project_id}_preview.mp4` : `${activeProject.project_id}.mp4`;
      
      // Upload final video to GCS directly from stitched path
      let finalUrl = '';
      try {
         const fileData = await fs.promises.readFile(stitchedVideoPath);
         finalUrl = await FirestoreService.uploadAsset(activeProject.project_id!, fileName, fileData, 'video/mp4');
         
         // Delete stitched temp file
         if (stitchedVideoPath.startsWith(os.tmpdir())) {
            fs.promises.unlink(stitchedVideoPath).catch(() => {});
         }
      } catch (err) {
         console.error('Failed to upload final output video', err);
      }

      // Extract thumbnail from final video (best frame at 1.5s hook moment)
      if (!isPreview && stitchedVideoPath && fs.existsSync(stitchedVideoPath)) {
        const thumbnailLocal = path.join(os.tmpdir(), 'ais-renderer', `${project_id}_thumbnail.jpg`);
        try {
          const thumbCmd = `"${ffmpegPath}" -i "${stitchedVideoPath}" -ss 1.5 -vframes 1 -q:v 2 -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2" -y "${thumbnailLocal}"`;
          await execAsync(thumbCmd, { timeout: 30000 });
          if (fs.existsSync(thumbnailLocal)) {
            const thumbBuffer = await fs.promises.readFile(thumbnailLocal);
            const thumbUrl = await FirestoreService.uploadAsset(activeProject.project_id!, `${project_id}_thumbnail.jpg`, thumbBuffer, 'image/jpeg');
            activeProject.thumbnail_path = thumbUrl;
            console.log('[Orchestrator] Thumbnail saved:', thumbUrl);
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

      if (isPreview) {
        activeProject.preview_video_path = finalUrl || stitchedVideoPath;
      } else {
        activeProject.output_path = finalUrl || stitchedVideoPath;
      }
      activeProject.completed_at = new Date();
      
      // Calculate Quality Score
      activeProject.quality_score = calculateQualityScore(activeProject);
      
      const anyFailed = activeProject.scenes.some((s: Scene) => s.status === 'failed');
      const anyDegraded = activeProject.scenes.some((s: Scene) => s.status === 'degraded');
      activeProject.status = (anyFailed || anyDegraded) ? 'degraded' : 'completed';
      
      // Track video generation
      await logUserEvent('video_generated', project_id, { status: activeProject.status, qualityScore: activeProject.quality_score });

      console.log(`[Orchestrator] Final video saved to: ${finalUrl || stitchedVideoPath}`);
      
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
    const sceneRenderedPath = await withRetry(() => assembleSceneSegment(scene, finalAudioPath, assemblyCacheKey), { retries: 2 });
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
