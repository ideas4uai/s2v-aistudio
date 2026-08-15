import { Project } from '../../models/project.js';
import { AIService } from '../../services/aiService.js';
import { targetLengthSeconds, sceneCountRange } from '../../utils/targetLength.js';

export interface DirectorPlan {
  visual_style: string;
  color_palette: string;
  camera_language: string;
  pacing_notes: string;
  overall_mood: string;
  narrative_arc: string;
}

export const PLAN_FIELDS: Array<keyof DirectorPlan> = [
  'visual_style', 'color_palette', 'camera_language', 'pacing_notes', 'overall_mood', 'narrative_arc',
];

/**
 * Flattens whatever JSON the model answered with into the prose these fields
 * promise. Lists keep their separators so a palette still reads as a palette and
 * a per-beat pacing note still reads as one note per beat.
 */
function asText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join(value.every((v) => typeof v === 'string') ? ', ' : '; ');
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, v]) => {
        const text = asText(v);
        return text && `${key.replace(/_/g, ' ')}: ${text}`;
      })
      .filter(Boolean)
      .join('; ');
  }
  return '';
}

/**
 * Every field of a plan as the string the interface says it is.
 *
 * The model does not answer in the shape the prompt asks for, and measured on
 * eight real runs of the same project it never did for one field: `color_palette`
 * came back as an array of hex codes 6 times and an object 2 times, `pacing_notes`
 * as a per-beat object once, and `narrative_arc` as an array of beat objects once.
 * That is the prompt's own doing — it asks for "3-4 hex codes" and for pacing to
 * "reflect this variety" across four labelled categories, both of which describe a
 * list, not a sentence.
 *
 * Until this existed, `planVideo` returned `parsed as DirectorPlan`: a compile-time
 * assertion over untyped JSON, which told every consumer downstream that six strings
 * were waiting for them. Two of them called `.trim()` on it and threw — the script
 * prompt's `clean()` and the storyboard's `visual_style` — and two more interpolated
 * it into a prompt as "[object Object]" without saying anything at all.
 */
export function normalizePlan(parsed: unknown, fallback: DirectorPlan): DirectorPlan {
  const source = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const plan = { ...fallback };
  for (const field of PLAN_FIELDS) {
    const text = asText(source[field]);
    if (text) plan[field] = text;
  }
  return plan;
}

export class DirectorAgent {
  static async planVideo(project: Project): Promise<DirectorPlan> {
    console.log(`[DirectorAgent] Planning video for topic: ${project.topic}`);
    // Any length, not five presets. The lookup table this replaces had nothing to
    // say about a custom target, and sceneCountRange reproduces its shape.
    const secs = targetLengthSeconds(project.settings?.targetLength);
    const targetLength = `${secs}s`;
    const [sceneLo, sceneHi] = sceneCountRange(secs);
    const sceneCountHint = `${sceneLo}-${sceneHi} scenes`;

    const featuredCharacters = project.universe && project.featuredCharacterIds?.length
      ? project.universe.characters.filter((c: any) => project.featuredCharacterIds!.includes(c.id))
      : (project.universe?.characters || []);
    const featuredLocation = project.universe && project.featuredLocationId
      ? project.universe.locations.find((l: any) => l.id === project.featuredLocationId)
      : null;

    const universeContext = project.universe ? `
UNIVERSE CONTEXT:
World: ${project.universe.world}
Art Style: ${project.universe.artStyle}
Tone: ${project.universe.toneRules}
Episode Structure: ${project.universe.episodeStructure}
Episode #${project.episodeNumber || 1}

CHARACTERS IN THIS EPISODE:
${featuredCharacters.map((c: any) => `${c.name} (${c.role}): ${c.personality}`).join('\n')}

LOCATION: ${featuredLocation ? `${featuredLocation.name} — ${featuredLocation.description}` : 'flexible'}
` : '';

    const prompt = `You are an expert AI Video Director. You are designing a visual blueprint for a high-concept video.
Topic: "${project.topic}"
Style Profile: ${project.style_profile}
Hook Strategy: ${project.hook_strategy}
Pacing Intensity: ${project.pacing_intensity}
Mode: ${project.mode}
Target Length: ${targetLength} (plan for ${sceneCountHint})
${universeContext}

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

    // Also the per-field fallback: a plan that answers five of six fields keeps the
    // five and borrows the sixth, rather than the whole plan being all-or-nothing.
    const fallback: DirectorPlan = {
      visual_style: project.style_profile === 'cinematic' ? 'Cinematic, high quality, 4k resolution' : 'Clean, well-lit, professional',
      color_palette: 'Vibrant and contrasting colors',
      camera_language: 'Smooth pans and stable shots',
      pacing_notes: project.pacing_intensity === 'fast' ? 'Quick cuts, fast moving parts' : 'Moderate pacing, give time to read',
      overall_mood: 'Engaging and informative',
      narrative_arc: 'Hook the viewer, explain the concept, end with a call to action.',
    };

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
      return normalizePlan(parsed, fallback);
    } catch (e) {
      console.warn(`[DirectorAgent] Failed to generate plan, returning default. Error: ${e}`);
      return fallback;
    }
  }
}
