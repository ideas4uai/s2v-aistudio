import { Project } from '../../models/project.js';
import { AIService } from '../../services/aiService.js';
import { DirectorPlan } from './directorAgent.js';
import { StoryArc } from './storyAgent.js';
import { targetLengthSeconds } from '../../utils/targetLength.js';

export const ScriptwriterAgent = {
  writeScript: async (project: Project, plan: DirectorPlan, storyArc?: StoryArc) => {
    if (storyArc) {
      return ScriptwriterAgent._writeConversational(project, plan, storyArc);
    }
    return ScriptwriterAgent._writeLegacy(project, plan);
  },

  _writeConversational: async (project: Project, plan: DirectorPlan, storyArc: StoryArc) => {
    const targetLength = project.settings?.targetLength || '60s';
    const wordsPerSecond = 2.5;
    const durationSeconds = targetLengthSeconds(targetLength);
    const targetWords = Math.round(durationSeconds * wordsPerSecond);

    // A universe means a cast, and a cast means the episode is dialogue, not an
    // explainer. Without this branch the same second-person voiceover rules
    // applied to every project, which is why character episodes came back as
    // "you heard Arjun say…" narration with no speaker to attribute.
    const cast = project.universe?.characters ?? [];
    const isCharacterEpisode = cast.length > 0;

    const prompt = isCharacterEpisode
      ? `You are writing a short character-driven episode: "${project.topic}"

WORLD: ${project.universe?.world ?? ''}
TONE (locked): ${project.universe?.toneRules ?? ''}
EPISODE STRUCTURE (locked): ${project.universe?.episodeStructure ?? ''}

CAST — only these characters may speak:
${cast.map((c: any) => `- ${c.name} (${c.role}): ${c.personality} Voice: ${c.voiceStyle}`).join('\n')}

STORY SPINE (turn this into spoken lines):
Hook: ${storyArc.beat_1_hook}
Context: ${storyArc.beat_2_context}
Surprise: ${storyArc.beat_3_surprise}
Insight: ${storyArc.beat_4_insight}
CTA: ${storyArc.beat_5_cta}

HARD RULES:
1. Every narration field is SPOKEN DIALOGUE by exactly one character, written as "NAME: line".
   Example: "RAVI: Staging environment unreachable."
2. Use the character names from the cast above, uppercase, followed by a colon. Never invent characters.
3. Never write about the characters in third person, and never address the viewer as "you" except in the final CTA scene.
4. Keep lines short and speakable — this is a speech bubble, not a paragraph. Max 15 words.
5. Match each character's personality and voice from the cast list.
6. Emotion and reaction carry the comedy. Do not explain the joke.
7. One scene per beat, in the order the locked episode structure gives. Do not add scenes beyond the beats.
8. At most ONE scene may be wordless (the reaction beat) — write "" for its narration. Every other scene, including the last, must have a spoken line.
9. Visual fields: describe the characters by name, what their faces are doing, and the environment. NEVER written text, numbers, labels, charts, signs, or UI screenshots — rendered text gets clipped by the vertical crop and fights the burned-in captions.

LENGTH — this is a hard constraint, not a target:
- The "duration" values across ALL scenes MUST sum to exactly ${durationSeconds} seconds. Add them up before you answer.
- About ${targetWords} spoken words in total (${durationSeconds}s at 2.5 words/sec). Under is better than over.

Output ONLY valid JSON:
{
  "rawScript": "Full spoken text joined together.",
  "scenes": [
    {
      "narration": "NAME: the spoken line for this scene.",
      "visual": "Who is on screen, their expression, the environment, the lighting.",
      "duration": 3,
      "order": 0
    }
  ]
}`
      : `You are writing narration for a YouTube Short about: "${project.topic}"

STORY SPINE (expand this into a full script):
Hook: ${storyArc.beat_1_hook}
Context: ${storyArc.beat_2_context}
Surprise: ${storyArc.beat_3_surprise}
Insight: ${storyArc.beat_4_insight}
CTA: ${storyArc.beat_5_cta}

HARD RULES — every sentence must follow ALL of these:
1. Max 15 words per sentence. Count before writing.
2. Write as if speaking to ONE person, not an audience.
3. No sentence starts with "This", "The", "It", "In this video", or "Today".
4. Use contractions: you're, it's, that's, here's, don't, can't.
5. No passive voice. Not "is used by" — say "people use".
6. No definition openings. Not "${project.topic} is a..." — start with action or consequence.
7. One idea per sentence.
8. Include at least one moment that makes the viewer think "wait, really?" — a genuine surprise.
9. Conversational, not academic. Sound like a person, not a textbook.

SCENE REQUIREMENTS:
- Scene 1: Use the hook verbatim as the OPENING LINE, then expand the hook's idea.
- Scene 2: Beat 2 — context. Why now.
- Scene 3: Beat 3 — the surprise or counterintuitive fact.
- Scene 4: Beat 4 — simple explanation with analogy.
- Scene 5+: Expand naturally. More detail, examples, or mini-story.
- Final scene: Beat 5 — CTA that leaves them wanting more.
- Every narration field: AT LEAST 20 words. Never one-sentence scenes.
- Visual fields: objects, scenes, atmosphere only — NEVER written text, numbers, labels, charts with figures, signs, or UI screenshots in the image. Rendered text gets clipped by the vertical crop and fights the burned-in captions. Convey data through visual metaphor (scale, glow, contrast) instead.

TARGET: ${targetWords} total words across ALL scenes (${targetLength} at 2.5 words/sec).

Output ONLY valid JSON:
{
  "rawScript": "Full spoken text joined together.",
  "scenes": [
    {
      "narration": "Spoken text for this scene. At least 20 words. Sounds like a person talking.",
      "visual": "Detailed cinematic description — tech/AI visual relevant to the narration. Specific. No people unless needed. No written text or numbers anywhere in the image.",
      "duration": 5,
      "order": 0
    }
  ]
}`;

    console.log(`[ScriptwriterAgent] ${isCharacterEpisode ? `Dialogue mode (${cast.length} characters)` : 'Conversational mode'} — topic: ${project.topic}, target: ${targetWords} words`);

    try {
      const response = await AIService.generateText(prompt, { task: 'script' });
      let parsed: any;
      try {
        parsed = JSON.parse(response);
      } catch {
        const jsonStr = response.replace(/```json\n?|```/g, '').trim();
        const firstBrace = jsonStr.indexOf('{');
        const lastBrace = jsonStr.lastIndexOf('}');
        if (firstBrace === -1 || lastBrace === -1) throw new Error('Malformed JSON');
        let cleaned = jsonStr.substring(firstBrace, lastBrace + 1).replace(/,(\s*[}\]])/g, '$1');
        parsed = JSON.parse(cleaned);
      }

      const scenes: any[] = parsed.scenes || [];
      const totalWords = scenes.reduce((sum: number, s: any) =>
        sum + (s.narration || '').split(' ').filter(Boolean).length, 0);
      console.log(`[ScriptwriterAgent] Conversational: ${totalWords} words / target ${targetWords}`);

      return { rawScript: parsed.rawScript || '', scenes };
    } catch (e) {
      console.error('[ScriptwriterAgent] Conversational mode failed:', e);
      throw e;
    }
  },

  _writeLegacy: async (project: Project, plan: DirectorPlan) => {
    console.log(`[ScriptwriterAgent] Narrative arc: ${plan.narrative_arc}`);
    
    const characterContext = project.world_entities?.characters?.length 
      ? `CHARACTERS TO INCLUDE:\n${project.world_entities.characters.map(c => `- ${c.name}: ${c.description}`).join('\n')}`
      : (project.character_description ? `CHARACTER FOCUS:\n${project.character_description}` : '');

    const locationContext = project.world_entities?.locations?.length
      ? `LOCATIONS TO USE:\n${project.world_entities.locations.map(l => `- ${l.name}: ${l.description}`).join('\n')}`
      : '';

    const targetLength = project.settings?.targetLength || '60s';
    const wordsPerSecond = 2.5;
    const durationSeconds = targetLengthSeconds(targetLength);
    const targetWords = Math.round(durationSeconds * wordsPerSecond);

    const prompt = `You are a professional Video Scriptwriter and Narrative Designer.
Your goal is to write a script for a video about: "${project.topic}"

### CREATIVE DIRECTION (Follow strictly):
- Hook Strategy: ${project.hook_strategy}
- Narrative Arc: ${plan.narrative_arc}
- Tone/Mood: ${plan.overall_mood}
- Pacing: ${plan.pacing_notes}
- Style Profile: ${project.style_profile}

### CONTEXT:
${characterContext}
${locationContext}

### SCRIPT REQUIREMENTS:
1. HOOK (Mandatory): Scene 1 MUST open with a hook — a shocking fact, provocative question, or bold statement. The hook should be 8-15 words, compelling and curiosity-driving. This scene can be longer than 8 words — the hook is the OPENING LINE only, not the entire scene narration. After the hook line, expand the explanation within the same scene.
2. Write a script that is engaging, rhythmic, and perfectly timed for a ${project.mode} video.
3. The narration should be punchy and minimize filler words.
4. TTS OPTIMIZATION (Mandatory): All 'narration' text MUST be optimized for Text-to-Speech. Remove all emojis, hashtags, and complex markdown (bolding, italics inside text) that could cause the engine to stutter or mispronounce symbols.
5. SCENE LENGTH (Mandatory): Every single 'narration' field MUST contain at least 15 words. Scenes with fewer than 15 words will cause TTS to produce clips under 5 seconds which breaks the video timing. Never write one-sentence narrations.
6. Each scene MUST have a specific visual description that matches the narrative arc.
7. If characters are provided, they must be active participants in the scripted scenes.

Provide the output in JSON format exactly like this:
{
  "rawScript": "The full spoken text of the script.",
  "scenes": [
    {
      "narration": "The spoken text for this specific scene.",
      "visual": "A detailed cinematic description of the video for the scene. Reference characters and settings by name.",
      "duration": 5,
      "order": 0
    }
  ]
}

- CRITICAL: Total narration across ALL scenes MUST be exactly ${targetWords} words. Count every word. At 2.5 words/second TTS speed = exactly ${targetLength}. Too few = short video. Too many = long video.
- Narrative Depth: Avoid generic descriptions. Use emotional beats, tension, and a clear resolution.
- Character Voice: If characters are described, use their specific persona and vocabulary in the narration.
- Ensure the JSON is perfectly valid.`;

    try {
      const response = await AIService.generateText(prompt, { task: 'script' });
      
      let parsed: any;
      try {
        parsed = JSON.parse(response);
      } catch {
        const jsonStr = response.replace(/```json\n?|```/g, '').trim();
        const firstBrace = jsonStr.indexOf('{');
        const lastBrace  = jsonStr.lastIndexOf('}');
        if (firstBrace === -1 || lastBrace === -1) {
          throw new Error('AI returned malformed JSON, will retry');
        }
        let cleaned = jsonStr.substring(firstBrace, lastBrace + 1);
        cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1');
        try {
          parsed = JSON.parse(cleaned);
        } catch {
          throw new Error('AI returned malformed JSON, will retry');
        }
      }

      let scenes: any[] = parsed.scenes || [];

      // NULL tease: append a hidden final scene for story episodes with a NULL character
      if (project.projectType === 'story_episode') {
        const hasNull = project.universe?.characters?.some(
          (c: any) => c.name?.toUpperCase() === 'NULL' || c.id === 'null'
        );
        if (hasNull) {
          const nullTeases: Record<number, string> = {
            1: 'Phone screen briefly shows corrupted N̷U̷L̷L̷ text for 1 frame, looks like a glitch',
            2: 'News ticker text corrupts with ERROR://NULL for 2 frames then returns to normal',
            3: 'One character eye briefly flashes signal red for 1 frame during emotional moment',
            4: 'Aura or glow effect around a character briefly turns all red for half a second',
            5: 'Mechanical or digital element shows ERROR//NULL text buried in visual noise',
            6: 'A shadowy figure is visible for 3 seconds, cold and still, says nothing',
            7: 'All previous teases replay in quick 8-second montage before final scene',
          };
          const episodeNum = project.episodeNumber || 1;
          const nullTease = nullTeases[episodeNum] || nullTeases[1];
          scenes.push({
            narration: '',
            visual: nullTease,
            duration: episodeNum === 7 ? 8 : 1.5,
            order: scenes.length,
            is_null_tease: true,
          });
          console.log(`[Scriptwriter] NULL tease appended for episode ${episodeNum}`);
        }
      }
      const totalWords = scenes.reduce((sum: number, s: any) =>
        sum + (s.narration || '').split(' ').filter(Boolean).length, 0);
      console.log(`[Scriptwriter] Words: ${totalWords} / target: ${targetWords}`);

      if (totalWords < targetWords * 0.8) {
        console.warn(`[Scriptwriter] Only ${totalWords} words, target ${targetWords}. Requesting expansion...`);
        const expandPrompt = `The following video script is too short (${totalWords} words, need ${targetWords}).
Expand each scene's narration to be longer and more detailed.
Keep the same scene structure, titles, and visual prompts — only expand the narration text.
Add more explanation, examples, and vivid detail to reach ${targetWords} total words.
Script: ${JSON.stringify(scenes)}
Return ONLY a valid JSON array of scenes in the exact same format, no markdown, no extra keys.`;
        try {
          const expandResponse = await AIService.generateText(expandPrompt, { task: 'script' });
          let expandedRaw = expandResponse.replace(/```json\n?|```/g, '').trim();
          const arrStart = expandedRaw.indexOf('[');
          const arrEnd   = expandedRaw.lastIndexOf(']');
          if (arrStart !== -1 && arrEnd !== -1) {
            const expandedScenes = JSON.parse(expandedRaw.substring(arrStart, arrEnd + 1));
            if (Array.isArray(expandedScenes) && expandedScenes.length > 0) {
              scenes = expandedScenes;
              const expandedWords = scenes.reduce((sum: number, s: any) =>
                sum + (s.narration || '').split(' ').filter(Boolean).length, 0);
              console.log(`[Scriptwriter] Expanded to ${expandedWords} words`);
            }
          }
        } catch (expandErr) {
          console.warn('[Scriptwriter] Expansion call failed, using original:', expandErr);
        }
      }

      return { rawScript: parsed.rawScript || "", scenes };
    } catch (e) {
      console.error('[ScriptwriterAgent] Failed:', e);
      throw e;
    }
  }
};

