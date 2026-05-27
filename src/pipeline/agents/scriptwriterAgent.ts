import { Project } from '../../models/project.js';
import { AIService } from '../../services/aiService.js';
import { DirectorPlan } from './directorAgent.js';

export const ScriptwriterAgent = {
  writeScript: async (project: Project, plan: DirectorPlan) => {
    console.log(`[ScriptwriterAgent] Narrative arc: ${plan.narrative_arc}`);
    
    const characterContext = project.world_entities?.characters?.length 
      ? `CHARACTERS TO INCLUDE:\n${project.world_entities.characters.map(c => `- ${c.name}: ${c.description}`).join('\n')}`
      : (project.character_description ? `CHARACTER FOCUS:\n${project.character_description}` : '');

    const locationContext = project.world_entities?.locations?.length
      ? `LOCATIONS TO USE:\n${project.world_entities.locations.map(l => `- ${l.name}: ${l.description}`).join('\n')}`
      : '';

    const targetLength = project.settings?.targetLength || '60s';
    const wordsPerSecond = 2.5;
    const durationSeconds =
      targetLength === '30s' ? 30 :
      targetLength === '60s' ? 60 :
      targetLength === '3m'  ? 180 :
      targetLength === '5m'  ? 300 : 60;
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

