import { Router } from 'express';
import { progressBus, isTerminal, ProgressEvent } from '../progressBus.js';
import fs from 'fs';
import path from 'path';
import {
  previewProject,
  getProjectTimeline,
  generateScript,
  selectHook,
  generateScenes,
  generateSceneAudio,
  generateSceneImage,
  renderProject,
  getProjectStatus,
  updateSceneNarration,
  updateProjectCharacter,
  updateProjectWorldEntities,
  analyzeProjectWorld,
  updateProjectScript,
  createScenesBatch,
  saveSceneImage,
  updateProjectSettings,
  cancelProject,
  abortProjectProcesses,
  analyzeImageAndCreateScript,
  resetProject,
  updateSceneFields
} from '../../controllers/projectController.js';
import { v4 as uuidv4 } from 'uuid';
import { toUrl } from '../../utils/path.js';
import { projectVideoFileName } from '../../utils/filename.js';

import { AIService } from '../../services/aiService.js';
import { FirestoreService } from '../db/firestore.js';
import { loadProject, saveProjectState, listLocalProjects, patchProject, deleteLocalProject, resetSceneForRetry } from '../../pipeline/orchestrator.js';
import { logEvent } from '../../services/logService.js';
import {
  buildMetadata, uploadVideo, YouTubeNotConfiguredError, YouTubeNotConnectedError,
  YouTubeUploadError, type YouTubePrivacy,
} from '../services/youtubeService.js';

export const projectsRouter = Router();

/**
 * The UI only ever sends these nested under `settings`, but the pipeline reads
 * them at the TOP level of the project (directorAgent/scriptwriterAgent prompts,
 * orchestrator cache keys). Without this mapping they are `undefined` in every
 * prompt. Defaults mirror the fallbacks in orchestrator.loadProject.
 */
export function pipelineFieldsFromSettings(settings: any) {
  const s = settings || {};
  return {
    mode: s.aspectRatio === '9:16' || s.exportMode === 'shorts' ? 'shorts' : 'long',
    style_profile: s.styleProfile || 'cinematic',
    hook_strategy: s.hookStrategy || 'default',
    pacing_intensity: s.pacingIntensity || 'moderate',
  };
}

projectsRouter.get('/test_ai', async (req, res) => {
   try {
      const text = await AIService.generateText('Say hello');
      res.json({ text });
   } catch (e) {
      res.status(500).json({ error: String(e) });
   }
});

projectsRouter.get('/test-adc', async (req, res) => {
  const mode = process.env.GOOGLE_CLOUD_PROJECT ? 'ADC (Vertex AI)' : 'API Keys';
  try {
    const text = await AIService.generateText('Say hello in one sentence', { task: 'default' });
    res.json({ ok: true, mode, text });
  } catch (e: any) {
    res.status(500).json({ ok: false, mode, error: String(e) });
  }
});

projectsRouter.post('/clear-ai-quota', (req, res) => {
  AIService.clearQuotaFlags();
  res.json({ message: 'AI quota flags cleared. All models will be retried on next operation.' });
});


projectsRouter.post('/:id/retry-failed-assets', async (req, res) => {
  const { id } = req.params;
  try {
    // patchProject, NOT FirestoreService — same bug as the delete and music routes:
    // under DISABLE_FIRESTORE=true this 404'd and no local project could be retried.
    let scenesReset = 0;
    const saved = await patchProject(id, (project: any) => {
      scenesReset = 0;
      for (const scene of project.scenes || []) {
        resetSceneForRetry(scene);
        scenesReset++;
      }
    }, 'retry-failed-assets');

    if (!saved) return res.status(409).json({ error: 'Could not reset assets — try again.' });
    res.json({ message: 'Assets reset to pending. Start render to regenerate.', scenesReset });
  } catch (error: any) {
    if (/not found/i.test(error?.message || '')) {
      return res.status(404).json({ error: 'Project not found' });
    }
    console.error('Failed to reset assets:', error);
    res.status(500).json({ error: 'Failed to reset assets' });
  }
});

// CRUD
projectsRouter.get('/', async (req, res) => {
  try {
    const uid = (req as any).user?.uid;
    if (!uid) {
        return res.json([]);
    }

    // Locally-stored projects first. In DISABLE_FIRESTORE mode every render writes
    // here and nowhere else, so querying only Firestore made them invisible on the
    // dashboard even though loadProject() resolves them fine (hence: openable by
    // direct URL, absent from the list).
    const localProjects = listLocalProjects();

    // Firestore may still hold projects from cloud-mode sessions. Show both rather
    // than hiding either set — but never let a Firestore outage empty the dashboard
    // of local work, which is what the previous unguarded call did.
    let remoteProjects: any[] = [];
    try {
      remoteProjects = (await FirestoreService.getProjects(uid)) || [];
    } catch (remoteErr: any) {
      console.warn('[Projects] Firestore list unavailable — showing local projects only:', remoteErr?.message);
    }

    // Same precedence as loadProject: a local copy wins over the remote one.
    const byId = new Map<string, any>();
    for (const p of remoteProjects) byId.set(p.id || p.project_id, p);
    for (const p of localProjects) byId.set(p.project_id!, p);

    const allProjects = [...byId.values()];
    const mappedProjects = allProjects.map((p: any) => {
      const charDesc = (p as any).characterDescription || (p as any).character_description || '';
      return {
        ...p,
        // The dashboard navigates on `id`; locally-stored records only reliably carry
        // `project_id`, and a card without an id is a dead tile.
        id: p.id || p.project_id,
        output_path: toUrl(p.output_path || ''),
        previewVideoPath: toUrl(p.previewVideoPath || ''),
        character_description: charDesc,
        characterDescription: charDesc, // Keep both for safety
        world_entities: (p as any).worldEntities ? (typeof (p as any).worldEntities === 'string' ? JSON.parse((p as any).worldEntities) : (p as any).worldEntities) : 
                       ((p as any).world_entities ? (typeof (p as any).world_entities === 'string' ? JSON.parse((p as any).world_entities) : (p as any).world_entities) : 
                       { characters: [], locations: [], objects: [] })
      };
    });
    res.json(mappedProjects);
  } catch (error) {
    console.error('Error fetching projects:', error);
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
});

projectsRouter.get('/:id', async (req, res) => {
  try {
    let project: any;
    try {
      project = await loadProject(req.params.id);
    } catch {
      return res.status(404).json({ error: 'Project not found' });
    }
    
    // Map Firestore Project to what the UI expects
    const charDesc = project.characterDescription || project.character_description || '';
    
    const response = {
      ...project,
      id: project.project_id || project.id,
      title: project.topic || project.title,
      output_path: toUrl(project.output_path || ''),
      previewVideoPath: toUrl(project.previewVideoPath || ''),
      outputPath: toUrl(project.output_path || ''),
      character_description: charDesc,
      characterDescription: charDesc,
      world_entities: project.world_entities || project.worldEntities || { characters: [], locations: [], objects: [] },
      scenes: (project.scenes || []).map((s: any) => ({
        id: s.scene_id || s.id,
        order: s.order ?? s.orderIndex ?? 0,
        duration: s.duration_target || s.duration,
        narration_text: s.narration_text || s.narrationText,
        visual_prompt: s.visuals?.[0]?.prompt || s.visualPrompt,
        character: s.character || 'NARRATOR',
        emotion: s.emotion || 'neutral',
        scene_type: (s as any).scene_type || '',
        image_path: toUrl(s.visuals?.[0]?.asset_path || s.visuals?.[0]?.rendered_path || s.preview_path || ''),
        audio_path: toUrl(s.narration_path || ''),
        preview_path: toUrl(s.preview_path || ''),
        segment_path: toUrl(s.segment_path || ''),
        captioned_path: toUrl(s.captioned_path || ''),
        status: s.status,
        suggestions: s.suggestions,
        background_prompt: s.background_prompt || '',
        background_path: s.background_path || null,
        background_url: s.background_url || null,
      }))
    };

    res.json(response);
  } catch (error) {
    console.error(`Error fetching project ${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to fetch project', details: error instanceof Error ? error.message : String(error) });
  }
});

projectsRouter.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    // loadProject, NOT FirestoreService.getProject — see the download route. Under
    // DISABLE_FIRESTORE=true a local-only project is absent from Firestore, so this
    // 404'd and no local project could ever be deleted.
    let project: any;
    try {
      project = await loadProject(id);
    } catch {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const userId = (req as any).user?.uid;
    // Locally-created projects predate per-user ownership and carry no userId. Treat an
    // unowned local record as the caller's rather than making it undeletable forever.
    if (project.userId && project.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized to delete this project' });
    }

    // Cancel running processes for the project
    abortProjectProcesses(id);

    const removedLocally = deleteLocalProject(id);
    // Firestore may still hold a copy from a cloud-mode session. Best-effort: a local
    // delete that succeeded must not be reported as a failure because Firestore is off.
    let remoteError: string | null = null;
    try {
      await FirestoreService.deleteProject(id);
    } catch (remoteErr: any) {
      remoteError = remoteErr?.message || String(remoteErr);
      console.warn(`[Projects] Firestore delete failed for ${id} (local copy removed):`, remoteError);
    }

    if (!removedLocally && remoteError) {
      return res.status(500).json({ error: 'Failed to delete project', details: remoteError });
    }
    res.json({ message: 'Project deleted successfully', removedLocally });
  } catch (error) {
    console.error('Error deleting project:', error);
    res.status(500).json({ error: 'Failed to delete project' });
  }
});

projectsRouter.post('/', async (req, res) => {
  const {
    title, description, script, settings,
    projectType, universe, universeId, episodeNumber,
    featuredCharacterIds, featuredLocationId
  } = req.body;
  const id = uuidv4();
  const userId = (req as any).user?.uid;

  if (!userId) {
     return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const newProject: any = {
      project_id: id,
      id: id,
      userId,
      title: title || 'Untitled Project',
      topic: title || 'Untitled Project',
      description,
      script,
      settings: settings || {},
      ...pipelineFieldsFromSettings(settings),
      status: 'draft',
      characterDescription: '',
      worldEntities: { characters: [], locations: [], objects: [] },
      projectType: projectType || 'standard',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      scenes: []
    };

    if (universe) newProject.universe = universe;
    if (universeId) newProject.universeId = universeId;
    if (episodeNumber) newProject.episodeNumber = episodeNumber;
    if (featuredCharacterIds) newProject.featuredCharacterIds = featuredCharacterIds;
    if (featuredLocationId) newProject.featuredLocationId = featuredLocationId;
    
    console.log(`[API] Creating project: ${id} - ${title}`);
    if (process.env.DISABLE_FIRESTORE === 'true') {
      await saveProjectState(newProject as any);
    } else {
      await FirestoreService.saveProject(newProject);
    }
    logEvent('project_created', id, {
      title, projectType: newProject.projectType,
      aspectRatio: (newProject as any).settings?.aspectRatio,
      universeId: (newProject as any).universeId ?? null,
    });
    res.status(201).json(newProject);
  } catch (error) {
    console.error('Error creating project:', error);
    res.status(500).json({ error: 'Failed to create project', details: error instanceof Error ? error.message : String(error) });
  }
});

// Pipeline actions
projectsRouter.post('/:id/generate-script', generateScript);
projectsRouter.post('/:id/select-hook', selectHook);
projectsRouter.post('/:id/generate-scenes', generateScenes);
projectsRouter.post('/:id/scenes/batch', createScenesBatch);
projectsRouter.patch('/:id/script', updateProjectScript);
projectsRouter.patch('/:id/settings', updateProjectSettings);
projectsRouter.post('/:id/scenes/:sceneId/image', saveSceneImage);
projectsRouter.post('/:id/scenes/:sceneId/generate-audio', generateSceneAudio);
projectsRouter.post('/:id/scenes/:sceneId/generate-image', generateSceneImage);
projectsRouter.post('/:id/update-character', updateProjectCharacter);
projectsRouter.post('/:id/update-world-entities', updateProjectWorldEntities);
projectsRouter.post('/:id/analyze-world', analyzeProjectWorld);
projectsRouter.post('/:id/scenes/:sceneId/update-narration', updateSceneNarration);
projectsRouter.patch('/:id/scenes/:sceneId', updateSceneFields);
projectsRouter.post('/:id/preview', previewProject);
projectsRouter.post('/:id/pipeline/run', renderProject);
projectsRouter.post('/:id/cancel', cancelProject);
projectsRouter.post('/:id/reset', resetProject);
projectsRouter.post('/:id/analyze-image', analyzeImageAndCreateScript);
projectsRouter.get('/:id/status', getProjectStatus);
projectsRouter.get('/:id/timeline', getProjectTimeline);

/**
 * Live render progress as Server-Sent Events.
 *
 * Subscribed per project id, so a client watching A is never registered on B's channel.
 * On connect it replays the most recent event, if a render is in flight — reconnecting
 * after a refresh should show where the render is, not an empty panel until whatever is
 * running next happens to finish.
 *
 * Everything here is about not leaking the connection. The listener is removed on close,
 * on error, and after a terminal event; the heartbeat exists so a client that vanished
 * without a FIN (laptop closed, network dropped) still surfaces as a write failure rather
 * than a listener held forever against a project nobody is watching.
 */
projectsRouter.get('/:id/progress', (req, res) => {
  const projectId = req.params.id;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Without this, a proxy that buffers responses turns a live stream into one big
    // payload delivered when the render is already over.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  let closed = false;
  const send = (event: ProgressEvent) => {
    if (closed) return;
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      cleanup();
      return;
    }
    if (isTerminal(event.stage)) {
      // The render is over. Close rather than hold an idle connection open, and let the
      // browser's EventSource reconnect only if a new render starts.
      cleanup();
      res.end();
    }
  };

  const unsubscribe = progressBus.subscribe(projectId, send);

  const heartbeat = setInterval(() => {
    if (closed) return;
    // A comment line: valid SSE, ignored by EventSource, and it fails loudly if the
    // socket is gone — which is what releases the listener for a client that never
    // sent a close.
    try { res.write(': keepalive\n\n'); } catch { cleanup(); }
  }, 15000);

  function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  }

  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('error', cleanup);

  // Replay: what is happening right now, for a client that joined mid-render.
  const latest = progressBus.latest(projectId);
  if (latest) {
    send(latest);
  } else {
    send({
      projectId, stage: 'init', message: 'Waiting for a render to start…',
      at: new Date().toISOString(),
    });
  }
});

projectsRouter.patch('/:id/music', async (req, res) => {
  try {
    // patchProject, NOT FirestoreService — same bug the download route above documents.
    // With DISABLE_FIRESTORE=true the project lives only in the local store, so
    // getProject() returned null and every music save 404'd. The picker reported
    // "Saved" regardless, so the selection looked stored and the render then read
    // music_track: undefined and muxed no music at all.
    const { music_track, music_volume } = req.body;
    const saved = await patchProject(req.params.id, (project: any) => {
      if (music_track !== undefined) project.music_track = music_track || null;
      if (music_volume !== undefined) project.music_volume = Number(music_volume);
    }, 'music');
    if (!saved) return res.status(409).json({ error: 'Music selection could not be saved — try again.' });
    res.json({ ok: true });
  } catch (err: any) {
    if (/not found/i.test(err?.message || '')) return res.status(404).json({ error: 'Project not found' });
    res.status(500).json({ error: 'Failed to update music' });
  }
});

/**
 * Resolves a project's rendered video to a path on this disk.
 *
 * output_path is written absolute by the renderer but served to the UI as a
 * root-relative URL, and older records carry either — so the leading slash has to go
 * before joining or path.join discards the cwd.
 */
export function resolveOutputFile(outputPath: string): string {
  const stored = outputPath.replace(/\\/g, '/');
  return path.isAbsolute(stored) ? stored : path.join(process.cwd(), stored.replace(/^\/+/, ''));
}

/**
 * Publishes a rendered video to the connected YouTube channel.
 *
 * Manual trigger only: this runs because someone clicked publish on this project. The
 * quality gate is enforced here rather than trusted to the caller — the whole point of
 * having a gate is that a bad video cannot reach the channel, and a UI check is a
 * suggestion while a server check is a rule. `force` exists because the operator is
 * allowed to overrule their own gate, but it has to be said out loud.
 */
projectsRouter.post('/:id/publish/youtube', async (req, res) => {
  const { id } = req.params;
  const privacyStatus: YouTubePrivacy = ['private', 'unlisted', 'public'].includes(req.body?.privacyStatus)
    ? req.body.privacyStatus : 'private';
  const force = req.body?.force === true;

  try {
    let project: any;
    try {
      project = await loadProject(id);
    } catch {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (!project?.output_path) {
      return res.status(409).json({ error: 'This project has no rendered video yet. Render it first.' });
    }
    if (project.output_path.startsWith('http')) {
      return res.status(409).json({
        error: 'The only copy of this video is remote. Re-render locally before publishing.',
      });
    }

    const filePath = resolveOutputFile(project.output_path);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'The rendered file is missing from disk. Re-render before publishing.' });
    }

    // The gate. A project is publishable when its gate passed; anything else needs an
    // explicit override, and the override is recorded on the project.
    const gate = project.quality_gate;
    if (!gate) {
      return res.status(409).json({
        error: 'This video has not been through the quality gate. Re-render it before publishing.',
      });
    }
    if (!gate.passed && !force) {
      logEvent('publish_blocked', id, { score: gate.score, failures: gate.failures });
      return res.status(409).json({
        error: 'Blocked by the quality gate.',
        score: gate.score,
        failures: gate.failures,
        hint: 'Fix the failures and re-render, or repeat the request with force: true to publish anyway.',
      });
    }

    const meta = buildMetadata(project);
    console.log(`[Publish] ${id} -> YouTube as "${meta.title}" (${privacyStatus}, ${(fs.statSync(filePath).size / 1e6).toFixed(1)} MB)`);

    const started = Date.now();
    const result = await uploadVideo(filePath, meta, privacyStatus);
    const durationSec = Number(((Date.now() - started) / 1000).toFixed(1));

    await patchProject(id, (p: any) => {
      p.youtube = {
        videoId: result.videoId,
        url: result.url,
        privacyStatus: result.privacyStatus,
        title: result.title,
        publishedAt: new Date().toISOString(),
        forcedPastQualityGate: !gate.passed,
      };
    }, 'youtube-publish');

    logEvent('publish_uploaded', id, {
      videoId: result.videoId, privacyStatus: result.privacyStatus, durationSec,
      qualityScore: gate.score, forced: !gate.passed,
    });
    console.log(`[Publish] ${id} published: ${result.url}`);
    res.json(result);
  } catch (err: any) {
    // Loud, and with the next action in it — the same contract as cloud backup.
    const message = err?.message || String(err);
    console.error(`[Publish] FAILED for ${id}: ${message}`);
    logEvent('publish_failed', id, { error: message, name: err?.name });

    if (err instanceof YouTubeNotConfiguredError) {
      return res.status(503).json({ error: message, needsConfig: true });
    }
    if (err instanceof YouTubeNotConnectedError) {
      return res.status(412).json({ error: message, needsAuth: true });
    }
    if (err instanceof YouTubeUploadError) {
      return res.status(err.status === 401 ? 412 : 502).json({
        error: message, reason: err.reason, retryable: err.retryable,
        needsAuth: err.status === 401,
      });
    }
    res.status(500).json({ error: `Publish failed: ${message}` });
  }
});

projectsRouter.get('/:id/download', async (req, res) => {
  try {
    // loadProject, NOT FirestoreService.getProject: in DISABLE_FIRESTORE mode the
    // project exists only in the local store, so going straight to Firestore returned
    // null and every download 404'd with "please re-render" on a perfectly good video.
    let project: any;
    try {
      project = await loadProject(req.params.id);
    } catch {
      return res.status(404).json({ error: 'Video not found, please re-render' });
    }
    if (!project || !project.output_path) {
      return res.status(404).json({ error: 'Video not found, please re-render' });
    }

    if (project.output_path.startsWith('http')) {
      return res.json({ downloadUrl: project.output_path });
    }

    // output_path is written as an absolute path by the renderer but served to the UI
    // as a root-relative URL ("/outputs/x.mp4"), and older records may carry either —
    // so strip the leading slash before joining or path.join discards the cwd.
    const stored = project.output_path.replace(/\\/g, '/');
    const filePath = path.isAbsolute(stored)
      ? stored
      : path.join(process.cwd(), stored.replace(/^\/+/, ''));

    if (!fs.existsSync(filePath)) {
       return res.status(404).send('Physical file not found on server.');
    }

    // Match the on-disk naming scheme so the downloaded file and the server file agree.
    const fileName = projectVideoFileName(project.title || project.topic, project.project_id || req.params.id);

    // In AI Studio environment, we should try to set explicit cache control for downloads
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'no-cache');
    
    console.log(`[Download] Serving file: ${filePath}`);
    const fileStream = fs.createReadStream(filePath);
    fileStream.on('error', (err) => {
      console.error('[Download] Stream error:', err);
      if (!res.headersSent) {
        res.status(500).send('Stream error');
      }
    });
    fileStream.pipe(res);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).send(`Failed to serve download: ${error instanceof Error ? error.message : String(error)}`);
  }
});
