import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { 
  previewProject, 
  getProjectTimeline, 
  generateScript, 
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

import { AIService } from '../../services/aiService.js';
import { FirestoreService } from '../db/firestore.js';

export const projectsRouter = Router();

projectsRouter.get('/test_ai', async (req, res) => {
   try {
      const text = await AIService.generateText('Say hello');
      res.json({ text });
   } catch (e) {
      res.status(500).json({ error: String(e) });
   }
});

projectsRouter.post('/clear-ai-quota', (req, res) => {
  AIService.clearQuotaFlags();
  res.json({ message: 'AI quota flags cleared. All models will be retried on next operation.' });
});

projectsRouter.post('/:id/retry-failed-assets', async (req, res) => {
  const { id } = req.params;
  try {
    const project: any = await FirestoreService.getProject(id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    
    if (project.scenes) {
      project.scenes.forEach((scene: any) => {
        scene.status = 'pending';
        scene.error_log = null;
        scene.errorLog = null;
        if (scene.visuals) {
          scene.visuals.forEach((v: any) => {
            v.status = 'pending';
          });
        }
      });
      await FirestoreService.saveProject(project);
    }

    res.json({ message: 'Assets reset to pending. Start render to regenerate.' });
  } catch (error) {
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
    const allProjects = await FirestoreService.getProjects(uid) || [];
    const mappedProjects = allProjects.map((p: any) => {
      const charDesc = (p as any).characterDescription || (p as any).character_description || '';
      return {
        ...p,
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
    const project: any = await FirestoreService.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    
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
        order: s.order || s.orderIndex,
        duration: s.duration_target || s.duration,
        narration_text: s.narration_text || s.narrationText,
        visual_prompt: s.visuals?.[0]?.prompt || s.visualPrompt,
        character: s.character || 'NARRATOR',
        emotion: s.emotion || 'neutral',
        image_path: toUrl(s.visuals?.[0]?.rendered_path || s.preview_path || ''),
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
    const project = await FirestoreService.getProject(id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    
    const userId = (req as any).user?.uid;
    if (project.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized to delete this project' });
    }

    // Cancel running processes for the project
    abortProjectProcesses(id);

    await FirestoreService.deleteProject(id);
    res.json({ message: 'Project deleted successfully' });
  } catch (error) {
    console.error('Error deleting project:', error);
    res.status(500).json({ error: 'Failed to delete project' });
  }
});

projectsRouter.post('/', async (req, res) => {
  const {
    title, description, script, settings, referenceImages,
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
      referenceImages: referenceImages || [],
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
    await FirestoreService.saveProject(newProject);
    res.status(201).json(newProject);
  } catch (error) {
    console.error('Error creating project:', error);
    res.status(500).json({ error: 'Failed to create project', details: error instanceof Error ? error.message : String(error) });
  }
});

// Pipeline actions
projectsRouter.post('/:id/generate-script', generateScript);
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

projectsRouter.patch('/:id/music', async (req, res) => {
  try {
    const project: any = await FirestoreService.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { music_track, music_volume } = req.body;
    if (music_track !== undefined) project.music_track = music_track || null;
    if (music_volume !== undefined) project.music_volume = Number(music_volume);
    await FirestoreService.saveProject(project);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update music' });
  }
});

projectsRouter.get('/:id/download', async (req, res) => {
  try {
    const project: any = await FirestoreService.getProject(req.params.id);
    if (!project || !project.output_path) {
      return res.status(404).json({ error: 'Video not found, please re-render' });
    }

    if (project.output_path.startsWith('http')) {
      return res.json({ downloadUrl: project.output_path });
    }

    const filePath = path.isAbsolute(project.output_path) 
      ? project.output_path 
      : path.join(process.cwd(), project.output_path);

    if (!fs.existsSync(filePath)) {
       return res.status(404).send('Physical file not found on server.');
    }

    const fileName = (project.title || project.topic) ? `${(project.title || project.topic).replace(/[^a-z0-9]/gi, '_')}.mp4` : 'video.mp4';
    
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
