import { v4 as uuidv4 } from 'uuid';
import { Project } from '../../models/project.js';
import { DirectorPlan } from './directorAgent.js';
import { AIService } from '../../services/aiService.js';
import { Scene } from '../../models/scene.js';

const SHOT_TYPES = ['wide shot', 'medium shot', 'close-up', 'detail shot', 'over-shoulder shot'];

export const StoryboardAgent = {
  expandVisuals: async (project: Project, plan: DirectorPlan, drafts: any[]): Promise<Scene[]> => {
    console.log(`[StoryboardAgent] Expanding ${drafts.length} scenes with narration-anchored prompts...`);

    const expandedResults = await Promise.all(drafts.map(async (draft, idx) => {
      const shotType = SHOT_TYPES[idx % SHOT_TYPES.length];

      const expansionPrompt = `You are a visual director creating image prompts for an AI image generator.

TOPIC: ${project.topic}
NARRATION (what is being spoken): "${draft.narration}"
SHOT TYPE FOR THIS SCENE: ${shotType}

Your job: Write a single image generation prompt that shows EXACTLY what the narration is describing.

RULES:
1. The image must be a LITERAL representation of the narration content. If narration says "Instagram", show a phone with Instagram. If it says "students learning", show students in a classroom.
2. Never generate landscapes, nature, or abstract art unless the narration explicitly mentions them.
3. Always specify: subject, action, environment, lighting.
4. Always end with: "photorealistic, 9:16 vertical, cinematic lighting, sharp focus"
5. Max 50 words total.
6. Do NOT mention any character names or story archetypes.

FEW-SHOT EXAMPLES:
Narration: "Instagram has 2 billion daily users"
Prompt: "Close-up of smartphone screen showing Instagram feed with photos and reels, person's thumb scrolling, soft bokeh background, social media notification bubbles floating, photorealistic, 9:16 vertical, cinematic lighting, sharp focus"

Narration: "Most students fail because they never practice"
Prompt: "Student sitting at desk surrounded by textbooks looking frustrated, pen down, head in hands, warm study lamp light, realistic classroom background, photorealistic, 9:16 vertical, cinematic lighting, sharp focus"

Narration: "The human brain processes images 60,000 times faster than text"
Prompt: "Split screen: left side dense text document, right side colorful brain with glowing neural connections, scientific visualization style, deep blue background, photorealistic, 9:16 vertical, cinematic lighting, sharp focus"

Narration: "Every successful YouTuber posts consistently"
Prompt: "Content creator at modern desk setup with ring light and camera recording, multiple monitors showing YouTube analytics with upward trending graphs, motivated expression, photorealistic, 9:16 vertical, cinematic lighting, sharp focus"

Now write the image prompt for this narration:
"${draft.narration}"

Return ONLY the image prompt. No explanation, no preamble, no quotes.`;

      try {
        console.log(`[StoryboardAgent] Expanding scene ${idx + 1}/${drafts.length} (${shotType})...`);
        await new Promise(resolve => setTimeout(resolve, idx * 200));

        const expandedPrompt = await AIService.generateText(expansionPrompt, { task: 'visual_expansion' });

        return { ...draft, expandedPrompt: expandedPrompt.trim() };
      } catch (e) {
        console.warn(`[StoryboardAgent] Expansion failed for scene ${idx + 1}, using draft visual:`, e);
        return { ...draft, expandedPrompt: draft.visual };
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
