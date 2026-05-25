import { FirestoreService } from '../server/db/firestore.js';
import { Request, Response } from 'express';
import { runPipeline, runScenePipeline, loadProject, saveProjectState } from '../pipeline/orchestrator.js';
import { WorldAgent } from '../pipeline/agents/worldAgent.js';
import { DirectorAgent } from '../pipeline/agents/directorAgent.js';
import { ScriptwriterAgent } from '../pipeline/agents/scriptwriterAgent.js';
import { StoryboardAgent } from '../pipeline/agents/storyboardAgent.js';
import { AIService } from '../services/aiService.js';
import { hashCode } from '../utils/hash.js';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';

export async function previewProject(req: Request, res: Response) {
  const { id } = req.params;
  try {
    // Start preview pipeline async
    runPipeline(id, { preview: true }).catch(console.error);
    res.json({ message: 'Preview started' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to start preview' });
  }
}

export async function getProjectTimeline(req: Request, res: Response) {
  const { id } = req.params;
  try {
    const project = await loadProject(id);
    res.json({ timeline: project.scenes?.map(s => s.timeline) || [] });
  } catch (error) {
    res.status(500).json({ error: 'Failed' });
  }
}

export async function updateProjectScript(req: Request, res: Response) {
  const { id } = req.params;
  const { script } = req.body;
  try {
    const p = await loadProject(id);
    p.script = script;
    await saveProjectState(p);
    res.json({ message: 'Script updated' });
  } catch (error) {
    res.status(500).json({ error: 'Failed' });
  }
}

export async function generateScript(req: Request, res: Response) {
  const { id } = req.params;
  try {
    const project = await loadProject(id);
    console.log(`[Pipeline] Stage 1: Planning and Scripting for project ${id}`);
    
    // 1. Director Planning
    const plan = await DirectorAgent.planVideo(project);
    
    // 2. Scriptwriting
    const scriptResult = await ScriptwriterAgent.writeScript(project, plan);
    
    // 3. World Analysis
    const entities = await WorldAgent.analyzeWorld(project, scriptResult.rawScript);

    // 4. SEO Metadata Generation
    let seoMetadata = null;
    try {
      const seoPrompt = `Given this video script about "${project.topic}", generate:
1. YouTube title (60 chars max, includes keyword, curiosity gap)
2. Description (150 words, keyword-rich, includes timestamps)
3. Tags (15 tags, mix of broad and specific)
4. Thumbnail text overlay (5 words max, bold claim)
Return as JSON: {title, description, tags, thumbnailText}`;

      const seoRaw = await AIService.generateText(seoPrompt, { task: 'seo' });
      const seoStr = seoRaw.replace(/```json\n?|```/g, '').trim();
      const fb = seoStr.indexOf('{');
      const lb = seoStr.lastIndexOf('}');
      if (fb !== -1 && lb !== -1) seoMetadata = JSON.parse(seoStr.substring(fb, lb + 1));
    } catch (seoErr) {
      console.warn('[generateScript] SEO metadata generation failed (non-fatal):', seoErr);
    }

    // Save results
    project.script = scriptResult.rawScript;
    project.world_entities = entities;
    if (seoMetadata) project.seo_metadata = seoMetadata;
    await saveProjectState(project);

    res.json({ script: scriptResult.rawScript, entities, plan, seoMetadata });
  } catch (error: any) {
    console.error('generateScript error:', error);
    res.status(500).json({ error: 'Failed to generate script', details: error.message });
  }
}

export async function generateScenes(req: Request, res: Response) {
  const { id } = req.params;
  const { script: userScript } = req.body; 
  
  console.log(`[ProjectController] generateScenes called for project ${id}`);
  
  try {
    const project = await loadProject(id);
    const scriptToUse = userScript || project.script;
    
    if (!scriptToUse) {
      console.warn(`[ProjectController] No script provided for project ${id}`);
      return res.status(400).json({ error: 'No script found. Generate a script first.' });
    }

    console.log(`[ProjectController] Planning video for project ${id}...`);
    const plan = await DirectorAgent.planVideo(project);
    console.log(`[ProjectController] Video plan generated.`);
    
    console.log(`[ProjectController] Segmenting script for project ${id}...`);
    const prompt = `You are a script segmentation specialist. Segment this script into logical scenes for a short video.
    
    ### Script:
    "${scriptToUse}"
    
    ### Format Requirement:
    Output valid JSON with "scenes" array. Each scene needs:
    - narration: the exact words spoken
    - visual: a descriptive cinematic prompt
    - duration: seconds (3-7 range)
    
    Example:
    {
      "scenes": [
        { "narration": "...text...", "visual": "...prompt...", "duration": 4 }
      ]
    }`;
    
    let segmentResponse: string | undefined;
    let parsed: any;
    
    try {
      segmentResponse = await AIService.generateText(prompt, { task: 'segmentation' });
      console.log(`[ProjectController] Segmentation response received.`);
    } catch (segmentError) {
      console.error(`[ProjectController] AI segmentation failed:`, segmentError);
      // FALLBACK: Manual segmentation if AI quota is hit
      const sentences = scriptToUse.split(/[.!?]+/).filter((s: string) => s.trim().length > 5);
      const fallbackScenes = sentences.map((s: string, i: number) => ({
        narration: s.trim() + '.',
        visual: `Cinematic visualization of: ${s.trim()}`,
        duration: Math.min(Math.max(s.split(' ').length / 2.5, 3), 7),
        order: i
      }));
      
      console.log(`[ProjectController] Using manual fallback segmentation with ${fallbackScenes.length} scenes.`);
      parsed = { scenes: fallbackScenes };
    }
    
    if (!parsed && segmentResponse) {
      try {
        parsed = JSON.parse(segmentResponse);
      } catch (err) {
        try {
          const jsonStr = segmentResponse.replace(/```json|```/g, '').trim();
          const firstBrace = jsonStr.indexOf('{');
          const lastBrace = jsonStr.lastIndexOf('}');
          
          if (firstBrace === -1 || lastBrace === -1) {
            // Try parsing directly
            parsed = JSON.parse(jsonStr);
          } else {
            parsed = JSON.parse(jsonStr.substring(firstBrace, lastBrace + 1));
          }
        } catch (parseError) {
          console.error(`[ProjectController] JSON parse failed for segmentation:`, segmentResponse);
          // Second fallback on parse error
          const sentences = scriptToUse.split(/[.!?]+/).filter((s: string) => s.trim().length > 5);
          parsed = { 
            scenes: sentences.map((s: string, i: number) => ({
              narration: s.trim() + '.',
              visual: `Cinematic visual: ${s.trim()}`,
              duration: 5,
              order: i
            }))
          };
        }
      }
    }
    
    console.log(`[ProjectController] Expanding visuals with StoryboardAgent for project ${id}...`);
    const scenesResult = await StoryboardAgent.expandVisuals(project, plan, parsed.scenes);
    console.log(`[ProjectController] Storyboard expansion complete. Generated ${scenesResult.length} scenes.`);
    
    console.log(`[ProjectController] Saving scenes and assets to DB for project ${id}...`);
    project.scenes = scenesResult.map(s => {
      const sceneId = s.scene_id || uuidv4();
      return {
        scene_id: sceneId,
        projectId: id,
        order: s.order,
        narration_text: s.narration_text,
        caption_text: s.caption_text,
        duration_target: s.duration_target,
        status: 'pending',
        stage: 'audio',
        visuals: [
          {
            visual_id: uuidv4(),
            prompt: s.visuals?.[0]?.prompt || '',
            asset_type: 'image',
            status: 'pending',
            duration_target: s.duration_target
          }
        ]
      } as any;
    });

    await saveProjectState(project);

    console.log(`[ProjectController] generateScenes successful for project ${id}`);
    res.json({ message: 'Scenes generated successfully', count: scenesResult.length });
  } catch (error: any) {
    console.error(`[ProjectController] generateScenes error for project ${id}:`, error);
    res.status(500).json({ error: 'Failed to generate scenes', details: error.message });
  }
}

export async function createScenesBatch(req: Request, res: Response) {
  const { id } = req.params;
  const { scenes: scenesData } = req.body;
  try {
    const project = await loadProject(id);
    
    project.scenes = scenesData.map((s: any) => {
      const sceneId = s.scene_id || uuidv4();
      return {
        scene_id: sceneId,
        projectId: id,
        order: s.order,
        narration_text: s.narration_text,
        caption_text: s.caption_text,
        duration_target: s.duration_target,
        status: 'pending',
        stage: 'audio',
        visuals: [
          {
            visual_id: uuidv4(),
            prompt: s.visual_prompt || s.visuals?.[0]?.prompt || '',
            asset_type: 'image',
            status: 'pending',
            duration_target: s.duration_target
          }
        ]
      } as any;
    });

    await saveProjectState(project);
    res.json({ message: 'Scenes batch created' });
  } catch (error) {
    console.error('createScenesBatch error:', error);
    res.status(500).json({ error: 'Failed' });
  }
}

export async function generateSceneAudio(req: Request, res: Response) {
  const { id, sceneId } = req.params;
  try {
    const project = await loadProject(id);
    const scene = project.scenes.find(s => s.scene_id === sceneId);
    if (!scene) throw new Error('Scene not found');
    res.json({ message: 'Success' });
  } catch (error) {
    res.status(500).json({ error: 'Failed' });
  }
}

export async function saveSceneImage(req: Request, res: Response) {
  const { id, sceneId } = req.params;
  const { base64Data } = req.body;
  
  if (!base64Data) {
    console.warn(`[saveSceneImage] No base64 data provided for scene ${sceneId}`);
    return res.status(400).json({ error: 'No image data provided' });
  }

  try {
    const buffer = Buffer.from(base64Data, 'base64');
    const assetId = uuidv4();
    const fileName = `${sceneId}_${assetId}.jpg`;
    
    console.log(`[saveSceneImage] Received image data for project ${id}, scene ${sceneId}. Size: ${buffer.length} bytes`);
    
    // Upload to Supabase Storage via FirestoreService.uploadAsset
    const url = await FirestoreService.uploadAsset(id, fileName, buffer, 'image/jpeg');

    const project = await loadProject(id);
    if (!project.scenes) {
       project.scenes = [];
    }
    
    const scene = project.scenes.find(s => s.scene_id === sceneId || (s as any).id === sceneId);
    if (scene) {
        scene.status = 'completed';
        scene.image_path = url; // Useful for UI
        if (!scene.visuals) scene.visuals = [];
        if (scene.visuals.length === 0) {
            scene.visuals.push({
                visual_id: uuidv4(),
                prompt: 'User provided image',
                asset_type: 'image',
                status: 'completed',
                rendered_path: url,
                duration_target: scene.duration_target || 5,
                motion_instruction: 'none',
                cache_key: `user-${assetId}`
            });
        } else {
            scene.visuals[0].rendered_path = url;
            scene.visuals[0].status = 'completed';
        }
    } else {
        console.warn(`[saveSceneImage] Scene ${sceneId} not found in project ${id}. Current scenes:`, project.scenes.map(s => s.scene_id || (s as any).id));
    }
    
    await saveProjectState(project);
      
    res.json({ message: 'Saved', url });
  } catch (error) {
    console.error('saveSceneImage error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}

export async function generateSceneImage(req: Request, res: Response) {
  const { id, sceneId } = req.params;
  try {
    const project = await loadProject(id);
    const scene = project.scenes.find(s => s.scene_id === sceneId || (s as any).id === sceneId);
    if (!scene) return res.status(404).json({ error: 'Scene not found' });

    const prompt = scene.visuals?.[0]?.prompt || (scene as any).visual_prompt || 'Cinematic video scene';
    console.log(`[generateSceneImage] Generating image for scene ${sceneId}, prompt: ${prompt.substring(0, 60)}...`);

    let buffer: Buffer;
    try {
      const base64Data = await AIService.generateImageBase64(prompt);
      buffer = Buffer.from(base64Data, 'base64');
    } catch (geminiErr) {
      console.warn('[generateSceneImage] Gemini failed, using Picsum fallback:', geminiErr instanceof Error ? geminiErr.message : geminiErr);
      const cleanPrompt = prompt.replace(/\[.*?\]/g, '').trim();
      const seed = Math.abs(hashCode(cleanPrompt)) % 1000;
      const picsumRes = await fetch(`https://picsum.photos/seed/${seed}/1080/1920`, {
        redirect: 'follow',
        signal: AbortSignal.timeout(10000),
      });
      if (!picsumRes.ok) throw new Error('Picsum also failed');
      buffer = Buffer.from(await picsumRes.arrayBuffer());
    }
    const assetId = uuidv4();
    const fileName = `${sceneId}_${assetId}.jpg`;

    const url = await FirestoreService.uploadAsset(id, fileName, buffer, 'image/jpeg');

    scene.status = 'completed';
    scene.image_path = url;
    if (!scene.visuals) scene.visuals = [];
    if (scene.visuals.length === 0) {
      scene.visuals.push({
        visual_id: uuidv4(),
        prompt,
        asset_type: 'image',
        status: 'completed',
        rendered_path: url,
        duration_target: scene.duration_target || 5,
        motion_instruction: 'none',
        cache_key: `gen-${assetId}`
      });
    } else {
      scene.visuals[0].rendered_path = url;
      scene.visuals[0].status = 'completed';
    }

    await saveProjectState(project);
    res.json({ message: 'Generated', url });
  } catch (error) {
    console.error('generateSceneImage error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}

export async function renderProject(req: Request, res: Response) {
  const { id } = req.params;
  try {
    const project = await loadProject(id);
    if (project.status === 'cancelled' || project.status === 'failed') {
      project.status = 'draft';
      project.is_cancelled = false;
      project.error_log = null;
      await saveProjectState(project);
    }
    runPipeline(id, { preview: false }).catch(console.error);
    res.json({ message: 'Full render pipeline started' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to start render' });
  }
}

import { abortManager } from '../pipeline/abortManager.js';

export function abortProjectProcesses(id: string) {
  abortManager.abort(id);
}

export async function cancelProject(req: Request, res: Response) {
  const { id } = req.params;
  try {
     console.log(`[ProjectController] Cancellation requested for ${id}`);
     const project = await loadProject(id);
     project.is_cancelled = true;
     project.status = 'cancelled';
     await saveProjectState(project);
     
     // Instantly kill running processes
     abortManager.abort(id);
     
     res.json({ message: 'Cancellation signal sent' });
  } catch (error) {
     res.status(500).json({ error: String(error) });
  }
}

export async function analyzeImageAndCreateScript(req: Request, res: Response) {
  const { id } = req.params;
  const { base64Data } = req.body;
  
  if (!base64Data) return res.status(400).json({ error: 'No image provided' });

  try {
     console.log(`[ProjectController] analyzeImageAndCreateScript for project ${id}`);
     const project = await loadProject(id);
     
     const analysisPrompt = `Analyze this image and generate a creative short video story based on it.
     The story should use elements from the image as key objects or settings.
     
     Return JSON with:
     1. title: Recommended video title
     2. script: The full narration script
     3. character_description: A detailed physical description of the main character or visual style consistent with the image.
     
     Format: {"title": "...", "script": "...", "character_description": "..."}`;

     const result = await AIService.analyzeImage(base64Data, analysisPrompt, { json: true });
     const data = JSON.parse(result);
     
     project.topic = data.title || project.topic;
     project.script = data.script;
     project.character_description = data.character_description;
     
     // Save the uploaded image as the first scene's reference
     const fileName = `reference_${uuidv4()}.jpg`;
     const buffer = Buffer.from(base64Data, 'base64');
     const url = await FirestoreService.uploadAsset(id, fileName, buffer, 'image/jpeg');
     
     // Seed first scene with this image
     project.scenes = [{
        scene_id: uuidv4(),
        order: 0,
        narration_text: "Starting from your uploaded image...",
        caption_text: "",
        image_path: url,
        status: 'completed',
        visuals: [{
           visual_id: uuidv4(),
           prompt: 'Reference image provided by user',
           asset_type: 'image',
           status: 'completed',
           rendered_path: url,
           duration_target: 5,
           motion_instruction: 'zoom_in',
           cache_key: 'user-ref'
        }]
     } as any];

     await saveProjectState(project);
     res.json({ message: 'Image analyzed and script created', data });
  } catch (err: any) {
     console.error('analyzeImageAndCreateScript error:', err);
     res.status(500).json({ error: err.message });
  }
}

export async function getProjectStatus(req: Request, res: Response) {
  const { id } = req.params;
  try {
     const project = await loadProject(id);
     res.json({ 
       status: project.status, 
       current_action: project.current_action,
       progress_percent: project.progress_percent,
       logs: project.logs || [],
       error_log: project.error_log 
     });
  } catch (error) {
     res.status(500).json({ error: String(error) });
  }
}

export async function updateSceneNarration(req: Request, res: Response) {
  const { id, sceneId } = req.params;
  const { narrationText } = req.body;
  try {
     const project = await loadProject(id);
     const scene = project.scenes.find(s => s.scene_id === sceneId || (s as any).id === sceneId);
     if (scene) {
        scene.narration_text = narrationText;
        await saveProjectState(project);
     }
     res.json({ message: 'Updated' });
  } catch(error) {
     res.status(500).json({ error: String(error) });
  }
}

export async function updateProjectCharacter(req: Request, res: Response) {
  const { id } = req.params;
  const { characterDescription } = req.body;
  try {
     const project = await loadProject(id);
     project.character_description = characterDescription;
     (project as any).characterDescription = characterDescription;
     await saveProjectState(project);
     res.json({ message: 'Updated' });
  } catch(error) {
     res.status(500).json({ error: String(error) });
  }
}

export async function updateProjectWorldEntities(req: Request, res: Response) {
  const { id } = req.params;
  const { worldEntities } = req.body;
  try {
     const project = await loadProject(id);
     project.world_entities = worldEntities;
     (project as any).worldEntities = worldEntities;
     await saveProjectState(project);
     res.json({ message: 'Updated' });
  } catch(error) {
     res.status(500).json({ error: String(error) });
  }
}

export async function updateProjectSettings(req: Request, res: Response) {
  const { id } = req.params;
  const { settings } = req.body;
  try {
     const project = await loadProject(id);
     project.settings = settings;
     await saveProjectState(project);
     res.json({ message: 'Settings updated' });
  } catch(error) {
     res.status(500).json({ error: String(error) });
  }
}

export async function analyzeProjectWorld(req: Request, res: Response) {
  const { id } = req.params;
  const { script: userScript } = req.body;
  try {
     const project = await loadProject(id);
     const scriptToAnalyze = userScript || project.script;
     
     if (scriptToAnalyze) {
       const entities = await WorldAgent.analyzeWorld(project, scriptToAnalyze);
       project.world_entities = entities;
       project.script = scriptToAnalyze;
       await saveProjectState(project);
       res.json(entities);
     } else {
       res.status(400).json({ error: 'No script found to analyze.' });
     }
  } catch(error) {
     console.error('analyzeProjectWorld error:', error);
     res.status(500).json({ error: String(error) });
  }
}
