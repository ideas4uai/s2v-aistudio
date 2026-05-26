import { Project } from '../../models/project.js';
import { AIService } from '../../services/aiService.js';

export interface DirectorPlan {
  visual_style: string;
  color_palette: string;
  camera_language: string;
  pacing_notes: string;
  overall_mood: string;
  narrative_arc: string;
}

export class DirectorAgent {
  static async planVideo(project: Project): Promise<DirectorPlan> {
    console.log(`[DirectorAgent] Planning video for topic: ${project.topic}`);
    const targetLength = project.settings?.targetLength || '60s';
    const sceneCountGuide: Record<string, string> = {
      '30s': '4-6 scenes',
      '60s': '7-9 scenes',
      '3m':  '14-18 scenes',
      '5m':  '24-30 scenes',
    };
    const sceneCountHint = sceneCountGuide[targetLength] || sceneCountGuide['60s'];

    const prompt = `You are an expert AI Video Director. You are designing a visual blueprint for a high-concept video.
Topic: "${project.topic}"
Style Profile: ${project.style_profile}
Hook Strategy: ${project.hook_strategy}
Pacing Intensity: ${project.pacing_intensity}
Mode: ${project.mode}
Target Length: ${targetLength} (plan for ${sceneCountHint})

Your job is to dictate the creative direction so that the Storyboard and Scriptwriter follow a unified vision.
### DIRECTIVES:
1. **The Abstract to Concrete**: Translate complex ideas into specific visual metaphors.
2. **Atmospheric Depth**: Define exactly how light, texture, and focus should be used.
3. **Consistency**: Create a repeating visual anchor (a color, a shape, or a character trait).
4. **Scene Variety (Pacing)**: Each scene MUST show a NEW visual — no two consecutive scenes may show the same subject. Alternate between: (a) Concept visualization — abstract metaphor representing the idea, (b) Real world example — concrete grounded scene, (c) Character/human element — emotional close-up or human reaction, (d) Data/text visual — informational overlay or statistic. Reflect this variety in the pacing_notes field.

Provide a JSON response with:
- visual_style: (e.g. "Gritty 16mm film noir", "Hyper-dynamic 3D motion graphics with neon accents")
- color_palette: (3-4 specific hex codes or descriptive colors that evoke the intended emotion)
- camera_language: (e.g. "Low-angle heroic shots", "Rapid whip-pans and Dutch tilts for disorientation")
- pacing_notes: (Exact rhythmic instructions: e.g. "Sync cuts to sub-bass peaks", "Gradual slow-motion ramps")
- overall_mood: (High-level psychological vibe)
- narrative_arc: (The visual "journey" from start to finish)

Output ONLY valid JSON.`;

    try {
      const rawResult = await AIService.generateText(prompt, { task: 'planning' });
      let parsed: any;
      try {
        parsed = JSON.parse(rawResult);
      } catch (err) {
        let jsonStr = rawResult.trim();
        const firstBrace = jsonStr.indexOf('{');
        const lastBrace = jsonStr.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1) {
          jsonStr = jsonStr.substring(firstBrace, lastBrace + 1);
          parsed = JSON.parse(jsonStr);
        } else {
          throw new Error('No valid JSON found in AI response');
        }
      }
      return parsed as DirectorPlan;
    } catch (e) {
      console.warn(`[DirectorAgent] Failed to generate plan, returning default. Error: ${e}`);
      return {
        visual_style: project.style_profile === 'cinematic' ? 'Cinematic, high quality, 4k resolution' : 'Clean, well-lit, professional',
        color_palette: 'Vibrant and contrasting colors',
        camera_language: 'Smooth pans and stable shots',
        pacing_notes: project.pacing_intensity === 'fast' ? 'Quick cuts, fast moving parts' : 'Moderate pacing, give time to read',
        overall_mood: 'Engaging and informative',
        narrative_arc: 'Hook the viewer, explain the concept, end with a call to action.',
      };
    }
  }
}
