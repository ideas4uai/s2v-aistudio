import { v4 as uuidv4 } from 'uuid';
import { Project } from '../../models/project.js';
import { DirectorPlan } from './directorAgent.js';
import { AIService } from '../../services/aiService.js';
import { Scene, VisualFrame } from '../../models/scene.js';

const SHOT_TYPES = ['wide shot', 'medium shot', 'close-up', 'detail shot', 'over-shoulder shot'];

function detectEmotion(text: string): string {
  const t = text.toLowerCase();
  if (/confus|what|why|how|bhai|kya|\?/.test(t)) return 'confused';
  if (/wow|amazing|great|yes|finally|aha|excited/.test(t)) return 'excited';
  if (/think|hmm|wait|maybe|actually|wonder/.test(t)) return 'thinking';
  if (/wrong|error|fail|broken|bug|crash/.test(t)) return 'angry';
  if (/sad|sorry|unfortunate|disappoint/.test(t)) return 'sad';
  if (/!\s*$/.test(t)) return 'surprised';
  return 'neutral';
}

export const StoryboardAgent = {
  expandVisuals: async (project: Project, plan: DirectorPlan, drafts: any[]): Promise<Scene[]> => {
    const isStoryEpisode = project.projectType === 'story_episode' && !!project.universe;
    console.log(`[StoryboardAgent] Expanding ${drafts.length} scenes (${isStoryEpisode ? 'story episode - multi-frame' : 'standard'})...`);

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

      const featuredCharacters = project.universe && project.featuredCharacterIds?.length
        ? project.universe.characters.filter((c: any) => project.featuredCharacterIds!.includes(c.id))
        : (project.universe?.characters || []);

      const characterContext = featuredCharacters.length > 0
        ? featuredCharacters.map((c: any) =>
            `If ${c.name} appears in this scene: ${c.appearance}. Colors: ${c.colorPalette}. Art style: ${project.universe?.artStyle || 'photorealistic'}.`
          ).join(' ')
        : '';

      const fullExpansionPrompt = characterContext
        ? `${expansionPrompt}\n\nCHARACTER VISUAL RULES (apply if the scene includes these characters):\n${characterContext}`
        : expansionPrompt;

      try {
        // NULL tease scenes bypass normal expansion
        if ((draft as any).is_null_tease) {
          return {
            ...draft,
            expandedPrompt: draft.visual || 'corrupted digital glitch, signal red and black, ERROR text fragments, reality distortion, scan lines, dark void, ominous, photorealistic, 9:16 vertical, cinematic frame',
            is_null_tease: true,
          };
        }

        console.log(`[StoryboardAgent] Expanding scene ${idx + 1}/${drafts.length} (${shotType})...`);
        await new Promise(resolve => setTimeout(resolve, idx * 200));

        if (isStoryEpisode) {
          const sceneDuration = draft.duration || 7;
          const multiFramePrompt = `You are a visual director creating image prompts for an AI image generator.

TOPIC: ${project.topic}
NARRATION (what is being spoken): "${draft.narration}"
SHOT TYPE FOR THIS SCENE: ${shotType}
${characterContext ? `\nCHARACTER VISUAL RULES:\n${characterContext}\n` : ''}
Generate 3 visual frames for this scene showing character progression. Each frame shows a different moment in the same scene.

Rules:
1. Each frame must be a LITERAL representation of the narration content.
2. Always specify: subject, action, environment, lighting.
3. Include character appearance details where relevant.
4. End every prompt with: "photorealistic, 9:16 vertical, cinematic lighting, sharp focus"
5. Max 50 words per prompt.

Return ONLY a JSON array (no extra text):
[
  { "prompt": "...", "motion": "zoom_in", "duration": 3 },
  { "prompt": "...", "motion": "pan_right", "duration": 2 },
  { "prompt": "...", "motion": "zoom_out", "duration": 2 }
]
Total duration of all frames must equal ${sceneDuration} seconds.`;

          const rawResponse = await AIService.generateText(multiFramePrompt, { task: 'visual_expansion' });
          let frames: VisualFrame[] | undefined;
          try {
            const arrStart = rawResponse.indexOf('[');
            const arrEnd = rawResponse.lastIndexOf(']');
            if (arrStart !== -1 && arrEnd !== -1) {
              const parsed = JSON.parse(rawResponse.substring(arrStart, arrEnd + 1));
              if (Array.isArray(parsed) && parsed.length > 0) {
                frames = parsed.map((f: any) => ({
                  frame_id: uuidv4(),
                  prompt: String(f.prompt || draft.visual),
                  duration: Number(f.duration) || sceneDuration / 3,
                  motion: String(f.motion || 'zoom_in'),
                }));
              }
            }
          } catch (parseErr) {
            console.warn(`[StoryboardAgent] Multi-frame parse failed for scene ${idx + 1}, falling back to single frame:`, parseErr);
          }
          let referenceImageUrl: string | undefined;
          if (isStoryEpisode) {
            const primaryChar = featuredCharacters.find((c: any) =>
              draft.narration?.toLowerCase().includes(c.name.toLowerCase())
            ) || featuredCharacters[0];
            referenceImageUrl = primaryChar?.referenceImageUrl;
          }
          return { ...draft, expandedPrompt: frames?.[0]?.prompt || draft.visual, frames, referenceImageUrl };
        }

        const expandedPrompt = await AIService.generateText(fullExpansionPrompt, { task: 'visual_expansion' });
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

      const emotion = detectEmotion(s.narration || '');

      return {
        scene_id: uuidv4(),
        order: s.order || idx,
        scene_type: idx === 0 ? 'hook' : (idx === drafts.length - 1 ? 'cta' : 'build'),
        narration_text: s.narration,
        caption_text: s.narration,
        captions: [],
        caption_chunks: [],
        emotion,
        visuals: [{
          visual_id: uuidv4(),
          prompt: s.expandedPrompt,
          asset_type: 'ai_image',
          duration_target: s.duration || 5,
          motion_instruction: motion,
          status: 'pending',
          cache_key: '',
          emotion,
          ...(s.frames ? { frames: s.frames } : {}),
          ...(s.referenceImageUrl ? { referenceImageUrl: s.referenceImageUrl } : {}),
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
        ...(s.is_null_tease ? { is_null_tease: true } : {}),
      } as any;
    });
  }
};
