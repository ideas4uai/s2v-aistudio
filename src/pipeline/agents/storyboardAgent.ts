import { v4 as uuidv4 } from 'uuid';
import { Project } from '../../models/project.js';
import { DirectorPlan } from './directorAgent.js';
import { AIService } from '../../services/aiService.js';
import { Scene } from '../../models/scene.js';

export const StoryboardAgent = {
  expandVisuals: async (project: Project, plan: DirectorPlan, drafts: any[]): Promise<Scene[]> => {
    console.log(`[StoryboardAgent] Path: Expanding ${drafts.length} scenes with AI...`);
    
    const worldContext = `
STYLE: ${plan.visual_style}
COLOR BLOSSOM: ${plan.color_palette}
CAMERA: ${plan.camera_language}

CHARACTERS IN WORLD:
${project.world_entities?.characters?.map(c => `- ${c.name}: ${c.prompt}`).join('\n') || 'N/A'}

LOCATIONS IN WORLD:
${project.world_entities?.locations?.map(l => `- ${l.name}: ${l.prompt}`).join('\n') || 'N/A'}
`;

    const scenes: Scene[] = [];
    
    // Process scenes in parallel for speed
    const expandedResults = await Promise.all(drafts.map(async (draft, idx) => {
      const prompt = `You are a Visual Storyboard Artist. Expand this scene description into a high-quality, descriptive visual prompt for AI image generation.

      Scene Narration: "${draft.narration}"
      Draft Visual: "${draft.visual}"
      Scene position: ${idx + 1} of ${drafts.length}

      ### WORLD CONTEXT:
      ${worldContext}

      ### RULES:
      1. Reference specific character physical traits from the WORLD CONTEXT by name.
      2. Ensure the visual style "${plan.visual_style}" is heavily emphasized.
      3. Use descriptive lighting terms (e.g., "Rembrandt lighting", "Volumetric fog", "Golden hour").
      4. Avoid words like "photorealistic" or "ultra-detailed". Use specific descriptors.
      5. Output ONLY the expanded prompt, max 60 words.
      6. This is scene ${idx + 1} of ${drafts.length} — choose a DIFFERENT camera angle and shot type than adjacent scenes. Cycle through: wide establishing shot, medium shot, close-up, over-the-shoulder, aerial/bird's eye, low-angle hero shot.
      7. The visual MUST directly reflect this specific narration action — do not reuse the same composition from other scenes.`;
      
      try {
        console.log(`[StoryboardAgent] Expanding scene ${idx + 1}/${drafts.length}...`);
        // Add a slight staggered delay to avoid instant burst if rate limits are tight
        await new Promise(resolve => setTimeout(resolve, idx * 200));
        
        const expandedPrompt = await AIService.generateText(prompt, { task: 'visual_expansion' });
        
        let finalPrompt = expandedPrompt.trim();
        if (plan.character_consistency && plan.character_consistency !== 'N/A') {
          const raw: any = plan.character_consistency;
          let charRef: string;
          if (typeof raw === 'object' && raw !== null) {
            const name = (raw.name || '').trim();
            const styleSnippet = raw.style ? raw.style.split(/\s+/).slice(0, 5).join(' ') : '';
            charRef = styleSnippet ? `${name}, ${styleSnippet}` : name;
          } else {
            charRef = String(raw).split(/\s+/).slice(0, 8).join(' ');
          }
          if (charRef) finalPrompt = `[CHAR: ${charRef}] ${finalPrompt}`;
        }
        
        return {
          ...draft,
          expandedPrompt: finalPrompt
        };
      } catch (e) {
        console.warn(`[StoryboardAgent] Expansion failed for scene ${idx + 1}, using draft:`, e);
        return {
          ...draft,
          expandedPrompt: draft.visual
        };
      }
    }));

    return expandedResults.map((s: any, idx: number) => {
      let motion = idx === 0 ? 'zoom_in' : 'pan_right';
      if (project.settings?.motionEffect && project.settings.motionEffect !== 'random') {
        motion = project.settings.motionEffect;
      } else if (project.settings?.motionEffect === 'random') {
        const effects = ['zoom_in', 'zoom_out', 'pan_right', 'pan_left'];
        motion = effects[Math.floor(Math.random() * effects.length)];
      }

      return {
        scene_id: uuidv4(),
        order: s.order || idx,
        scene_type: idx === 0 ? 'hook' : (idx === drafts.length - 1 ? 'cta' : 'build'),
        narration_text: s.narration,
        caption_text: s.narration,
        captions: [],
        caption_chunks: [],
        visuals: [{
          visual_id: uuidv4(),
          prompt: s.expandedPrompt,
          asset_type: 'ai_image',
          duration_target: s.duration || 5,
          motion_instruction: motion,
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
        suggestions: [],
      } as any;
    });
  }
};

