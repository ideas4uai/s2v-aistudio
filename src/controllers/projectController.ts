import { FirestoreService } from '../server/db/firestore.js';
import { Request, Response } from 'express';
import { runPipeline, runScenePipeline, loadProject, saveProjectState } from '../pipeline/orchestrator.js';
import { requestContext } from '../server/utils/context.js';
import { WorldAgent } from '../pipeline/agents/worldAgent.js';
import { DirectorAgent } from '../pipeline/agents/directorAgent.js';
import { ScriptwriterAgent } from '../pipeline/agents/scriptwriterAgent.js';
import { HookAgent } from '../pipeline/agents/hookAgent.js';
import { StoryAgent } from '../pipeline/agents/storyAgent.js';
import { StoryboardAgent, pickMotion } from '../pipeline/agents/storyboardAgent.js';
import { AIService } from '../services/aiService.js';
import { hashCode } from '../utils/hash.js';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { toUrl } from '../utils/path.js';
import { storeSceneImage } from '../services/sceneImageStore.js';
import { pipelineFieldsFromSettings } from '../server/routes/projects.js';

export async function previewProject(req: Request, res: Response) {
  const { id } = req.params;
  try {
    const previewToken = (req as any).user?.token || '__dev__';
    requestContext.run({ token: previewToken }, () => {
      runPipeline(id, { preview: true }).catch(console.error);
    });
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

    // 1. Director Planning (always runs)
    const plan = await DirectorAgent.planVideo(project);

    // 2. For generic/educational projects — pause for hook selection
    const isGeneric = !project.universe && project.projectType !== 'story_episode';
    if (isGeneric) {
      console.log(`[Pipeline] Generic project — running HookAgent for hook selection`);
      const hookOptions = await HookAgent.generateHooks(project.topic);

      // Save state and pause pipeline for user to pick a hook
      (project as any).hookOptions = hookOptions;
      (project as any).selectedHook = null;
      (project as any)._directorPlan = plan;
      project.status = 'hook_selection';
      await saveProjectState(project);

      return res.json({ hookOptions, status: 'hook_selection' });
    }

    // Story/universe projects — use existing ScriptwriterAgent directly
    const scriptResult = await ScriptwriterAgent.writeScript(project, plan);
    const entities = await WorldAgent.analyzeWorld(project, scriptResult.rawScript);

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

export async function selectHook(req: Request, res: Response) {
  const { id } = req.params;
  const { hookIndex } = req.body;

  if (typeof hookIndex !== 'number' || hookIndex < 0 || hookIndex > 2) {
    return res.status(400).json({ error: 'hookIndex must be 0, 1, or 2' });
  }

  try {
    const project = await loadProject(id);
    const hooks: Array<{ type: string; text: string }> = (project as any).hookOptions || [];
    if (!hooks.length) {
      return res.status(400).json({ error: 'No hooks found on project — run generate-script first' });
    }

    const chosen = hooks[hookIndex];
    if (!chosen) {
      return res.status(400).json({ error: `hookIndex ${hookIndex} out of range (${hooks.length} hooks available)` });
    }

    console.log(`[selectHook] Chosen: [${chosen.type}] ${chosen.text}`);

    const directorPlan = (project as any)._directorPlan;
    if (!directorPlan) {
      return res.status(400).json({ error: 'Director plan missing — re-run generate-script' });
    }

    // StoryAgent: build 5-beat arc from chosen hook
    const storyArc = await StoryAgent.buildArc(project.topic, chosen.text, directorPlan);

    // ScriptAgent: write conversational script from arc
    const scriptResult = await ScriptwriterAgent.writeScript(project, directorPlan, storyArc);

    // World entities
    const entities = await WorldAgent.analyzeWorld(project, scriptResult.rawScript);

    // SEO
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
    } catch { /* non-fatal */ }

    // Persist
    (project as any).selectedHook = chosen.text;
    (project as any).storyArc = storyArc;
    project.script = scriptResult.rawScript;
    project.world_entities = entities;
    if (seoMetadata) project.seo_metadata = seoMetadata;
    project.status = 'draft';
    await saveProjectState(project);

    res.json({ script: scriptResult.rawScript, storyArc, entities, seoMetadata });
  } catch (error: any) {
    console.error('selectHook error:', error);
    res.status(500).json({ error: 'Failed to process hook selection', details: error.message });
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

    const hasManualScript = scriptToUse.trim().length > 100;
    const hasVisualPrompts = scriptToUse.includes('Visual Prompt');

    // DECIDED, DO NOT "FIX": skipping DirectorAgent for manual scripts is intentional.
    // Explicit user field selections (Visual Style, Cinematic Effect, Scene Type, Voice
    // Style, Target Length...) take precedence over DirectorAgent's judgment by design.
    // DirectorAgent is an LLM: run it over a script the user wrote by hand and it will
    // silently overwrite those choices with its own, which is the exact bug class the
    // classic-flow field audit existed to eliminate. So above 100 chars of hand-written
    // script we build a plan from the user's own settings instead of asking the model.
    // DirectorAgent still runs for generated/short scripts, where there is no explicit
    // user intent to override. Making it authoritative again is an architectural change,
    // not a bug fix — raise it as one if it is ever genuinely wanted.
    let plan: import('../pipeline/agents/directorAgent.js').DirectorPlan;
    if (hasManualScript) {
      console.log(`[ProjectController] Manual script detected — skipping DirectorAgent for project ${id}`);
      plan = {
        visual_style: (project.settings as any)?.visualStyle || (project.settings as any)?.artStyle || 'cinematic',
        color_palette: 'natural, vibrant',
        camera_language: 'mixed shots',
        pacing_notes: 'moderate pacing',
        overall_mood: 'engaging',
        narrative_arc: 'linear'
      };
    } else {
      console.log(`[ProjectController] Planning video for project ${id}...`);
      plan = await DirectorAgent.planVideo(project);
      console.log(`[ProjectController] Video plan generated.`);
    }

    // Fast-path: script has Visual Prompt sections — use prompts directly, skip StoryboardAgent entirely
    if (hasManualScript && hasVisualPrompts) {
      console.log(`[ProjectController] Script has Visual Prompts — building scenes directly, skipping StoryboardAgent`);
      const directScenes: any[] = [];
      let current: any = {};
      for (const line of scriptToUse.split('\n')) {
        const narMatch = line.match(/^Narration:\s*(.+)/i);
        const visMatch = line.match(/^Visual Prompt:\s*(.+)/i);
        const durMatch = line.match(/^Duration:\s*(\d+(?:\.\d+)?)/i);
        if (narMatch) { current.narration = narMatch[1].trim(); }
        if (visMatch) { current.visual = visMatch[1].trim(); if (current.narration) { directScenes.push({ ...current }); current = {}; } }
        if (durMatch) { current.duration = parseFloat(durMatch[1]); }
      }
      if (current.narration && !current.visual) {
        directScenes.push({ narration: current.narration, visual: `Cinematic visual: ${current.narration}`, duration: 5 });
      }
      if (directScenes.length > 0) {
        const featuredCharsForDetection = ((project.universe as any)?.characters as any[] | undefined)
          ?.filter((c: any) => !project.featuredCharacterIds?.length || project.featuredCharacterIds.includes(c.id)) ?? [];

        const FAST_PATH_SPEAKER_PATTERNS: Record<string, string[]> = {
          'byte': ['efficiency rating', 'optimis', 'recommended', 'i have optimis', 'sending', 'logged', 'routing', 'very proud'],
          'nova': ['pattern recognition', 'systems trained', "there's a difference", 'dynamic pricing', "that's a very good question", 'facial recognition'],
          'veer': ['i never asked', 'i picked', "that's not a compliment", 'i hate this', 'fine'],
        };

        const detectChar = (narration: string): string => {
          const text = narration.toLowerCase();
          const mentioned = featuredCharsForDetection.filter((c: any) => text.includes(c.name.toLowerCase()));
          if (mentioned.length !== 1) return 'NARRATOR';
          const char = mentioned[0];
          const name = char.name.toLowerCase();
          const narratedPatterns = [
            `${name} stops`, `${name} opens`, `${name} stares`, `${name} reads`,
            `${name} finds`, `${name} realises`, `${name} wonders`, `${name} is eating`,
            `${name} was`, `${name} has`, `${name}'s`,
          ];
          if (narratedPatterns.some((p: string) => text.includes(p))) return 'NARRATOR';
          const speakerPatterns = FAST_PATH_SPEAKER_PATTERNS[name] || [];
          return speakerPatterns.some((p: string) => text.includes(p)) ? char.name.toUpperCase() : 'NARRATOR';
        };

        project.scenes = directScenes.map((s: any, idx: number) => {
          const existingScene = (project.scenes || []).find((es: any) => es.order === idx);
          return {
          scene_id: uuidv4(),
          projectId: id,
          order: idx,
          narration_text: s.narration,
          caption_text: s.narration,
          character: existingScene?.character || detectChar(s.narration || ''),
          // Never invented here — only carried over, so a user's Scene Type
          // survives a scene regeneration.
          scene_type: existingScene?.scene_type,
          emotion: 'neutral',
          duration_target: s.duration || 5,
          status: 'pending',
          stage: 'audio',
          visuals: [{
            visual_id: uuidv4(),
            prompt: s.visual,
            asset_type: 'ai_image',
            motion_instruction: pickMotion(project, idx),
            status: 'pending',
            cache_key: '',
            duration_target: s.duration || 5,
          }],
          } as any;
        });
        await saveProjectState(project);
        console.log(`[ProjectController] generateScenes (visual-prompt fast-path, ${directScenes.length} scenes) successful for project ${id}`);
        return res.json({ message: 'Scenes generated successfully', count: directScenes.length });
      }
    }

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
    // Agent JSON is loosely shaped — legacy/camelCase aliases handled below
    project.scenes = scenesResult.map((s: any, idx) => {
      const sceneId = s.scene_id || uuidv4();
      return {
        scene_id: sceneId,
        projectId: id,
        order: s.order ?? s.orderIndex ?? idx,
        narration_text: s.narration_text,
        caption_text: s.caption_text,
        duration_target: s.duration_target,
        background_prompt: s.background_prompt || s.backgroundPrompt || s.visual_prompt || s.visuals?.[0]?.prompt || '',
        character: s.character || s.characterName || '',
        scene_type: s.scene_type || s.sceneType || s.type || 'default',
        emotion: s.emotion || 'neutral',
        status: 'pending',
        stage: 'audio',
        visuals: [
          {
            visual_id: uuidv4(),
            prompt: s.visuals?.[0]?.prompt || '',
            asset_type: 'image',
            status: 'pending',
            // Dropping these rebuilt the visual without the Cinematic Effect the
            // StoryboardAgent derived from settings.motionEffect, so renderService
            // fell back to its hardcoded 'zoom_in' for every scene.
            motion_instruction: s.visuals?.[0]?.motion_instruction || s.motion_instruction || 'zoom_in',
            cache_key: s.visuals?.[0]?.cache_key || '',
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
    
    // Local disk in STORAGE_MODE=local, Supabase Storage otherwise
    const url = await storeSceneImage(id, fileName, buffer);

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
      
    res.json({ message: 'Saved', url: toUrl(url) });
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

    const prompt = (req.body?.prompt) || scene.visuals?.[0]?.prompt || (scene as any).visual_prompt || 'Cinematic video scene';
    console.log(`[generateSceneImage] Generating image for scene ${sceneId}, prompt: ${prompt.substring(0, 60)}...`);

    // Resolve reference image: body > universe character match
    let referenceImageUrl: string | undefined = req.body?.referenceImageUrl;
    if (!referenceImageUrl && (project as any).universe) {
      const sceneChar = (scene as any).character as string | undefined;
      if (sceneChar) {
        const matchingChar = ((project as any).universe.characters as any[] | undefined)
          ?.find((c: any) => c.name.toUpperCase() === sceneChar.toUpperCase());
        referenceImageUrl = matchingChar?.referenceImageUrl;
      }
    }

    let buffer: Buffer;
    try {
      const base64Data = await AIService.generateImageBase64(prompt, {
        aspectRatio: project.settings?.aspectRatio === '16:9' ? '16:9' : '9:16',
        isStoryEpisode: !!(project as any).universe,
        referenceImageUrl,
      });
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

    const url = await storeSceneImage(id, fileName, buffer);

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
    res.json({ message: 'Generated', url: toUrl(url) });
  } catch (error) {
    console.error('generateSceneImage error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}

export async function renderProject(req: Request, res: Response) {
  const { id } = req.params;
  try {
    const project = await loadProject(id);
    if (['cancelled', 'failed', 'completed'].includes(project.status)) {
      project.status = 'draft';
      project.is_cancelled = false;
      project.error_log = null;
      project.output_path = undefined;
      await saveProjectState(project);
    }
    const token = (req as any).user?.token || '__dev__';
    requestContext.run({ token }, () => {
      runPipeline(id, { preview: false }).catch(console.error);
    });
    res.json({ message: 'Full render pipeline started' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to start render' });
  }
}

export async function resetProject(req: Request, res: Response) {
  const { id } = req.params;
  try {
    const project = await loadProject(id);
    project.status = 'draft';
    project.output_path = undefined;
    project.error_log = null;
    project.is_cancelled = false;
    await saveProjectState(project);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to reset project' });
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
     const url = await storeSceneImage(id, fileName, buffer);
     
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
       error_log: project.error_log,
       output_path: toUrl(project.output_path || ''),
       outputPath:  toUrl(project.output_path || ''),
     });
  } catch (error) {
     res.status(500).json({ error: String(error) });
  }
}

export async function updateSceneNarration(req: Request, res: Response) {
  const { id, sceneId } = req.params;
  const { narrationText, character } = req.body;
  try {
     const project = await loadProject(id);
     const scene = project.scenes.find(s => s.scene_id === sceneId || (s as any).id === sceneId);
     if (scene) {
        if (narrationText !== undefined) scene.narration_text = narrationText;
        if (character !== undefined) (scene as any).character = character;
        await saveProjectState(project);
     }
     res.json({ message: 'Updated' });
  } catch(error) {
     res.status(500).json({ error: String(error) });
  }
}

export async function updateSceneFields(req: Request, res: Response) {
  const { id, sceneId } = req.params;
  const { narration_text, visual_prompt, duration_target, background_prompt, scene_type, emotion } = req.body;
  try {
    const project = await loadProject(id);
    const scene = project.scenes.find((s: any) => s.scene_id === sceneId || s.id === sceneId);
    if (!scene) return res.status(404).json({ error: 'Scene not found' });
    if (narration_text !== undefined) scene.narration_text = narration_text;
    if (visual_prompt !== undefined && scene.visuals?.[0]) scene.visuals[0].prompt = visual_prompt;
    if (duration_target !== undefined) scene.duration_target = Number(duration_target);
    if (background_prompt !== undefined) (scene as any).background_prompt = background_prompt;
    if (scene_type !== undefined) (scene as any).scene_type = scene_type;
    if (emotion !== undefined) (scene as any).emotion = emotion;
    await saveProjectState(project);
    res.json({ ok: true, scene });
  } catch (error) {
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
  const { settings, universeId } = req.body;
  try {
     const project = await loadProject(id);
     if (settings !== undefined) {
       project.settings = settings;
       // The agents and the asset cache keys read the top-level snake_case
       // fields, not settings.*. Re-derive them here or an edit made after
       // creation (switching to 9:16, changing style profile) leaves `mode`,
       // `style_profile`, `hook_strategy` and `pacing_intensity` stale at
       // whatever create time set — silently wrong prompts and cache hits.
       Object.assign(project, pipelineFieldsFromSettings(settings));
     }
     if (universeId !== undefined) (project as any).universeId = universeId || null;
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
