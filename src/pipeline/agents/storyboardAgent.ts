import { v4 as uuidv4 } from 'uuid';
import { Project } from '../../models/project.js';
import { DirectorPlan } from './directorAgent.js';
import { AIService } from '../../services/aiService.js';
import { Scene, VisualFrame } from '../../models/scene.js';
import { secondsForWords, countWords } from '../../utils/targetLength.js';

const SHOT_TYPES = ['wide shot', 'medium shot', 'close-up', 'detail shot', 'over-shoulder shot'];

// scene_type values the render engines actually understand. Anything else
// ('hook', 'build', 'cta', legacy junk) falls back to 'default' — the same
// particle/transition preset those values already resolved to.
const RENDER_SCENE_TYPES = new Set(['bedroom', 'street', 'grid', 'corridor', 'black']);

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

const VERBS_OF_SPEECH = 'says?|said|asks?|asked|replies|replied|answers?|answered|announces?|announced|mutters?|muttered|adds?|added|shouts?|shouted|calls? out|states?|stated';

/**
 * Attribution patterns for one character, derived from their name.
 *
 * Universes describe characters, not phrasings, so the signals here are the
 * ones a script actually carries: a `NAME:` dialogue prefix, or a named
 * attribution around a spoken line. This used to be a hardcoded table of
 * catchphrases for three Signal Squad characters, which meant every other
 * universe's cast silently collapsed to NARRATOR.
 */
export function buildSpeakerPatterns(name: string): RegExp[] {
  const n = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    // "RAVI: Staging is unreachable."
    new RegExp(`(^|["'“\\s])${n}\\s*:`, 'i'),
    // "Ravi said, 'Staging is unreachable.'" — verb within a short span of the name.
    new RegExp(`\\b${n}\\b[^.?!]{0,40}?\\b(${VERBS_OF_SPEECH})\\b`, 'i'),
  ];
}

/**
 * Which universe character speaks this line, or NARRATOR.
 *
 * Ambiguity resolves to NARRATOR: no characters supplied (a project with no
 * universe), nobody attributed, or two characters attributed in one line.
 */
export function detectCharacter(narration: string, chars: any[]): string {
  const speaking = (chars ?? []).filter(
    (c) => typeof c?.name === 'string' && c.name.trim() && buildSpeakerPatterns(c.name).some((p) => p.test(narration)),
  );
  return speaking.length === 1 ? String(speaking[0].name).toUpperCase() : 'NARRATOR';
}

// The UI's Visual Style slugs, as positive prompt phrases. Anything else
// (DirectorAgent writes free-form styles) is passed through verbatim.
export const VISUAL_STYLE_PHRASES: Record<string, string> = {
  cinematic: 'cinematic photorealistic',
  anime: 'anime / 2D animation style',
  '3d': '3D animated film style',
  watercolor: 'watercolor illustration',
  cyberpunk: 'cyberpunk neon aesthetic',
  // Shipped by the built-in "minimalist" template (server/routes/templates.ts) but
  // absent from both this map and the dropdown, so it fell through as a bare adjective.
  minimalist: 'clean minimalist flat design, generous negative space, limited palette',
};

/**
 * The art style every image prompt is locked to, in priority order:
 * a universe's locked style, then the user's Visual Style pick, then whatever the
 * DirectorAgent invented, then photorealistic.
 */
export function resolveArtStyle(project: any, plan: any): string {
  const planStyle = plan?.visual_style?.trim();
  const userStyle = project?.settings?.visualStyle?.trim();
  const userPhrase = userStyle ? VISUAL_STYLE_PHRASES[userStyle.toLowerCase()] || userStyle : '';
  return project?.universe?.artStyle?.trim()
    || userPhrase
    || (planStyle ? VISUAL_STYLE_PHRASES[planStyle.toLowerCase()] || planStyle : '')
    || 'photorealistic';
}

/** The default cadence: a push, then a drift, repeating. Cuts read as deliberate. */
export const ALTERNATING_MOTIONS = ['zoom_in', 'pan_right'] as const;

/**
 * The Cinematic Effect the user picked, or the alternating default.
 *
 * Shared with the visual-prompt fast path in projectController, which used to
 * hardcode 'zoom_in' and silently ignore the setting.
 *
 * The default alternates by scene index. It previously read
 * `idx === 0 ? 'zoom_in' : 'pan_right'`, which is only "alternating" for the first
 * two scenes — every scene from the second onward panned right, so a six-scene video
 * was one zoom followed by five identical pans.
 *
 * 'random' draws independently per scene, so it repeats and reverses direction across
 * cuts with no editorial logic. It stays selectable but is no longer what you get by
 * default.
 */
export function pickMotion(project: Project, idx: number): string {
  const effect = project.settings?.motionEffect;
  if (effect === 'random') {
    const effects = ['zoom_in', 'zoom_out', 'pan_right', 'pan_left'];
    return effects[Math.floor(Math.random() * effects.length)];
  }
  if (!effect || effect === 'alternate') {
    return ALTERNATING_MOTIONS[idx % ALTERNATING_MOTIONS.length];
  }
  return effect;
}

export const StoryboardAgent = {
  expandVisuals: async (project: Project, plan: DirectorPlan, drafts: any[]): Promise<Scene[]> => {
    const isStoryEpisode = project.projectType === 'story_episode' && !!project.universe;
    // The style tail used to be the literal string "photorealistic", which
    // overrode any universe whose whole identity is not being photorealistic —
    // and then ignored the plan's visual_style (the user's Visual Style pick).
    // The user's Visual Style dropdown outranks the DirectorAgent's invented style.
    // It used to be ignored entirely: plan.visual_style is free-form LLM prose
    // ("Sophisticated, minimalist digital aesthetic with glowing, ethereal elements"),
    // which never matches a VISUAL_STYLE_PHRASES key, so the phrase map never fired and
    // whatever the model felt like became the art style regardless of what was picked.
    const artStyle = resolveArtStyle(project, plan);
    // "9:16 vertical" was hardcoded even for projects rendering 16:9.
    const orientation = project.settings?.aspectRatio === '16:9' ? '16:9 landscape' : '9:16 vertical';
    const styleTail = `${artStyle}, ${orientation}, cinematic lighting, sharp focus`;
    console.log(`[StoryboardAgent] Expanding ${drafts.length} scenes (${isStoryEpisode ? 'story episode - multi-frame' : 'standard'}), style: ${artStyle}`);

    // Hoisted out of the per-draft loop: the cast is the same for every scene,
    // and the expansion prompt now has to branch on whether there is one.
    const featuredCharacters = project.universe && project.featuredCharacterIds?.length
      ? project.universe.characters.filter((c: any) => project.featuredCharacterIds!.includes(c.id))
      : (project.universe?.characters || []);

    const characterContext = featuredCharacters.length > 0
      ? featuredCharacters.map((c: any) =>
          `${c.name} — ${c.appearance} Colors: ${c.colorPalette}.`
        ).join('\n')
      : '';

    const expandedResults = await Promise.all(drafts.map(async (draft, idx) => {
      const shotType = SHOT_TYPES[idx % SHOT_TYPES.length];

      // The Scriptwriter already described the shot it intended. Dropping it
      // meant a wordless beat (a reaction, a visual punchline) expanded from an
      // empty narration and lost whatever the story put on screen.
      const intendedShot = String(draft.visual ?? '').trim();

      const expansionPrompt = `You are a visual director creating image prompts for an AI image generator.

TOPIC: ${project.topic}
NARRATION (what is being spoken): "${draft.narration}"${intendedShot ? `\nINTENDED SHOT (from the script — this is what must be on screen): "${intendedShot}"` : ''}
SHOT TYPE FOR THIS SCENE: ${shotType}

Your job: Write a single image generation prompt that shows EXACTLY what the narration and the intended shot describe.

RULES:
1. The image must be a LITERAL representation of the narration and intended shot. If narration says "Instagram", show a phone with Instagram. If it says "students learning", show students in a classroom. When the narration is empty, the intended shot IS the scene — render it faithfully.
2. Never generate landscapes, nature, or abstract art unless the narration explicitly mentions them.
3. Always specify: subject, action, environment, lighting.
4. Always end with: "${styleTail}"
5. Max 50 words total.
6. ${characterContext
        ? 'Name the characters listed below when the narration involves them, and restate their locked appearance details. Never redesign them.'
        : 'Do NOT mention any character names or story archetypes.'}
7. NEVER include readable text, numbers, words, logos, charts with figures, or signage in the image — rendered text gets clipped by the vertical crop and fights the burned-in captions. Convey data visually (scale, glow, contrast) instead of with written figures.
8. A screen is never the answer, and this does not depend on how abstract the narration is. Do NOT make a monitor, phone, dashboard, hologram, terminal or floating interface the subject of the shot, and never describe code, text or a UI on one. Those come back as panels of garbled lettering, which is the most obvious mark of a generated image. The rule binds hardest when the narration names software directly ("the stack trace", "the test suite", "the code", "the dashboard") — answer those with the person, the hand, the room, or a physical object that stands in for the idea. A device may sit in the frame as an object — dark, glare-washed, or well out of focus — but never as the thing being read.

FEW-SHOT EXAMPLES:
Narration: "Instagram has 2 billion daily users"
Prompt: "Close-up of a person's thumb scrolling a phone held low in evening light, the screen a soft wash of glare with no detail on it, blurred crowd of faces behind them, ${styleTail}"

Narration: "Most students fail because they never practice"
Prompt: "Student sitting at desk surrounded by textbooks looking frustrated, pen down, head in hands, warm study lamp light, realistic classroom background, ${styleTail}"

Narration: "The human brain processes images 60,000 times faster than text"
Prompt: "Split screen: left side towering stack of paper documents in dim grey light, right side colorful brain with glowing neural connections, scientific visualization style, deep blue background, ${styleTail}"

Narration: "Every successful YouTuber posts consistently"
Prompt: "Content creator at modern desk setup with ring light and camera recording, one monitor glowing with a rising green line and no figures on it, motivated expression, ${styleTail}"

Now write the image prompt for this narration:
"${draft.narration}"

Return ONLY the image prompt. No explanation, no preamble, no quotes.`;

      const fullExpansionPrompt = characterContext
        ? `${expansionPrompt}\n\nART STYLE (locked): ${artStyle}\n\nCHARACTER VISUAL RULES (apply if the scene includes these characters):\n${characterContext}`
        : expansionPrompt;

      try {
        // NULL tease scenes bypass normal expansion
        if ((draft as any).is_null_tease) {
          return {
            ...draft,
            expandedPrompt: draft.visual || `corrupted digital glitch, signal red and black, ERROR text fragments, reality distortion, scan lines, dark void, ominous, photorealistic, ${orientation}, cinematic frame`,
            is_null_tease: true,
          };
        }

        console.log(`[StoryboardAgent] Expanding scene ${idx + 1}/${drafts.length} (${shotType})...`);
        await new Promise(resolve => setTimeout(resolve, idx * 200));

        if (isStoryEpisode) {
          const sceneDuration = draft.duration || 7;
          const multiFramePrompt = `You are a visual director creating image prompts for an AI image generator.

TOPIC: ${project.topic}
NARRATION (what is being spoken): "${draft.narration}"${intendedShot ? `\nINTENDED SHOT (from the script — this is what must be on screen): "${intendedShot}"` : ''}
SHOT TYPE FOR THIS SCENE: ${shotType}
ART STYLE (locked): ${artStyle}
${characterContext ? `\nCHARACTER VISUAL RULES (locked — never redesign):\n${characterContext}\n` : ''}
Generate 3 visual frames for this scene showing character progression. Each frame shows a different moment in the same scene.

Rules:
1. Each frame must be a LITERAL representation of the narration and the intended shot. When the narration is empty, the intended shot IS the scene — render it faithfully.
2. Always specify: subject, action, environment, lighting.
3. Name the characters the narration involves and restate their locked appearance details in every frame that shows them.
4. End every prompt with: "${styleTail}"
5. Max 50 words per prompt.
6. NEVER include readable text, numbers, words, logos, or signage in any frame — rendered text gets clipped by the vertical crop. Never make a monitor, phone, dashboard or interface the subject of a frame, and never describe code or a UI on one, whatever the narration is about; a device may appear as an object, dark or out of focus, but never as the thing being read.

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
      const motion = pickMotion(project, idx);

      // The scriptwriter does not emit a duration, so `s.duration || 5` gave every
      // scene in every pipeline-created project the same 5s target regardless of
      // what was written in it — while the narration ran 6-9.7s. Every scene
      // overran by the same amount, which is what made the cut rhythm metronomic.
      // Derive it from the words actually written instead, so a three-word beat
      // stays a three-word beat.
      const sceneSeconds = s.duration || secondsForWords(countWords(s.narration));

      const emotion = detectEmotion(s.narration || '');
      const character = detectCharacter(s.narration || '', featuredCharacters);
      // scene_type is the RENDER vocabulary (bedroom|street|grid|corridor|black)
      // that Metro V4 picks transitions and particles from. Writing narrative
      // 'hook'/'build'/'cta' here clobbered the user's pick with values the
      // renderer discards, so keep any existing choice and default otherwise.
      const existingScene = (project.scenes || []).find((es: any) => es.order === (s.order ?? idx)) as any;
      const keptSceneType = RENDER_SCENE_TYPES.has(existingScene?.scene_type) ? existingScene.scene_type : 'default';

      return {
        scene_id: uuidv4(),
        order: s.order || idx,
        scene_type: keptSceneType,
        narration_text: s.narration,
        caption_text: s.narration,
        captions: [],
        caption_chunks: [],
        emotion,
        character,
        visuals: [{
          visual_id: uuidv4(),
          prompt: s.expandedPrompt,
          asset_type: 'ai_image',
          duration_target: sceneSeconds,
          motion_instruction: motion,
          status: 'pending',
          cache_key: '',
          emotion,
          ...(s.frames ? { frames: s.frames } : {}),
          ...(s.referenceImageUrl ? { referenceImageUrl: s.referenceImageUrl } : {}),
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
        suggestions: [],
        ...(s.is_null_tease ? { is_null_tease: true } : {}),
      } as any;
    });
  }
};
