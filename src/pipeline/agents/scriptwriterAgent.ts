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
1. HOOK (Mandatory): Scene 1 (order: 0) MUST open with a hook — a shocking fact, provocative question, or bold statement that creates immediate curiosity. Keep the hook line to MAX 8 words. Examples: "Most people have NO idea how AI really works." / "This technology will change everything you know." Start with the hook line, then expand the explanation in subsequent scenes.
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

      const result = { rawScript: parsed.rawScript || "", scenes: parsed.scenes || [] };
      const totalWords = result.scenes.reduce((sum: number, s: any) =>
        sum + (s.narration || '').split(' ').length, 0);
      console.log(`[Scriptwriter] Words: ${totalWords} / target: ${targetWords}`);
      if (Math.abs(totalWords - targetWords) > targetWords * 0.2) {
        console.warn('[Scriptwriter] Word count off >20%, consider retry');
      }
      return result;
    } catch (e) {
      console.error('[ScriptwriterAgent] Failed:', e);
      throw e;
    }
  }
};

