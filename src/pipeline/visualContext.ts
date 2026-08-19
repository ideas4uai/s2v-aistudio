import { AIService } from '../services/aiService.js';
import type { Project } from '../models/project.js';

/**
 * The region, era and cultural setting a project's imagery should depict, derived
 * from the script the user actually wrote.
 *
 * Why this exists: a scene whose narration names a place gets a prompt that names it
 * too ("jubilant crowds celebrating in Delhi streets"), but a scene that says
 * "Nehru spoke of a tryst with destiny" becomes "close-up of a resolute statesman's
 * face" — and an image model handed that with no other cue draws a white man in a
 * suit. Measured on a real fifteen-scene script about Indian independence, 4 of 15
 * prompts carried the region and 11 did not.
 *
 * A universe already solves this: its character bible states appearance per character
 * and the art style is injected per scene. This is the same idea for the projects that
 * have no universe, taken from the only source of truth those projects have — their
 * own script.
 */

/** Asks the model, once per project. Kept to one short call: this is not per scene. */
const DEFAULT_ASK = (prompt: string) => AIService.generateText(prompt, { task: 'planning' });

/**
 * Deliberately not a lookup table of regions. A gazetteer would only ever know the
 * places someone thought to type into it, and the request here is for whatever the
 * script states — a Lagos newsroom, a Kyoto workshop, 1947 Punjab — not a menu.
 */
export async function inferVisualContext(
  topic: string,
  script: string,
  ask: (prompt: string) => Promise<string> = DEFAULT_ASK,
): Promise<string> {
  const material = `${topic}\n\n${script}`.trim();
  if (!material) return '';

  const answer = await ask(
    `Read this video script and say where and when its imagery should be set.\n\n`
    + `SCRIPT:\n${material.slice(0, 4000)}\n\n`
    + `Answer with a single short phrase naming the region, era and the appearance of the `
    + `people who should be depicted — for example "Indian, 1947 North India, period dress" `
    + `or "contemporary Lagos, Nigerian" or "1920s rural Japan, Japanese".\n`
    + `If the script does not indicate any particular place, culture or period, answer exactly NONE.\n`
    + `Answer with the phrase alone and nothing else.`,
  ).catch(() => '');

  const context = String(answer || '').trim().replace(/^["']|["'.]$/g, '').trim();
  // A model that will not commit is the same as a script that does not say.
  if (!context || /^none$/i.test(context) || context.length > 120) return '';
  return context;
}

/**
 * Whether this project needs the script read for context at all.
 *
 * A universe brings its own cast bible and art style, both already injected per scene,
 * and a second opinion derived from the script would argue with them.
 */
export const needsVisualContext = (project: Project): boolean => !(project as any).universe;

/** Content words of `text`, for deciding whether a prompt already says this itself. */
const words = (text: string): string[] =>
  (String(text || '').toLowerCase().match(/[a-z]{4,}/g) ?? []);

/**
 * Appends the context to a prompt that does not already carry it.
 *
 * The check is per prompt, not per project: a prompt that already says "Delhi streets"
 * gains nothing from being told it is Indian, and repeating a term is how a prompt
 * ends up weighting it hardest.
 */
export function applyVisualContext(prompt: string, context: string): string {
  const base = String(prompt || '').trim();
  if (!base || !context) return base;
  const have = new Set(words(base));
  // Already established if the prompt names any distinctive term from the context.
  if (words(context).some((word) => have.has(word))) return base;
  return `${base}, ${context}`;
}
