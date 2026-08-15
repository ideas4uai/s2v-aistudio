/**
 * Drift checks that sit between automate-mode stages.
 *
 * Every check returns the shape the quality gate already reports failures in — a
 * list of specific reasons, empty when it passes — so a halt reads the same
 * whether a guardrail or the terminal gate produced it.
 *
 * Deliberately lexical, not LLM. Each of these runs between two stages that each
 * already cost several model calls; adding another round trip per transition
 * would put the guardrail layer's latency on the same order as the work it
 * guards. The ceiling that buys is stated on each check.
 */

import { flagCraftIssues, flagUnverifiedClaims } from '../../pipeline/agents/scriptPrompt.js';
import { MAX_PAD_FACTOR, TARGET_TOLERANCE, targetWordCount } from '../../utils/targetLength.js';
import { checkAudioPresent } from '../../services/qualityService.js';
import type { Project } from '../../models/project.js';
import type { ProductionScene, StoryPlan } from '../domain/types.js';

/**
 * Words too common to prove two pieces of text are about the same thing. Sibling
 * of scriptPrompt's GENERIC_CLOSE_WORDS, which is tuned for closing questions —
 * this one has to survive being pointed at an image prompt.
 */
const STOPWORDS = new Set([
  'about', 'after', 'again', 'against', 'their', 'there', 'these', 'those', 'this', 'that', 'they',
  'them', 'then', 'than', 'with', 'without', 'into', 'from', 'your', 'yours', 'have', 'having',
  'will', 'would', 'could', 'should', 'been', 'being', 'were', 'what', 'when', 'where', 'which',
  'while', 'more', 'most', 'much', 'many', 'some', 'such', 'only', 'just', 'ever', 'even', 'also',
  'over', 'under', 'still', 'because', 'before', 'between', 'through', 'here', 'like', 'make',
  'made', 'take', 'takes', 'come', 'comes', 'goes', 'going', 'know', 'knows', 'think', 'thing',
  'things', 'something', 'anything', 'everything', 'nothing', 'really', 'very', 'well', 'good',
  'best', 'better', 'need', 'needs', 'want', 'wants', 'help', 'work', 'works', 'time', 'times',
  'people', 'thats', 'dont', 'youre', 'were', 'shot', 'scene', 'image', 'style', 'view', 'look',
  'looking', 'background', 'foreground', 'camera', 'lighting', 'colour', 'color', 'detailed',
  'highly', 'cinematic', 'photorealistic', 'render', 'rendering', 'quality', 'digital',
]);

/**
 * Crude singular stem: a trailing 's' on a word long enough for it to be a plural.
 * Same trick flagCraftIssues uses, so "tests" matches a script about a test suite.
 */
const stem = (word: string): string =>
  word.length > 4 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;

/** The content words of `text`: four letters and up, stemmed, minus the stoplist. */
export function contentWords(text: string): Set<string> {
  const words = String(text ?? '').toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? [];
  return new Set(words.map(stem).filter((word) => !STOPWORDS.has(word)));
}

const shareAWord = (a: Set<string>, b: Set<string>): boolean => [...a].some((word) => b.has(word));

const short = (text: string): string => (text.length > 70 ? `${text.slice(0, 67)}…` : text);

/**
 * Idea → Story, the free half. One shared content word is a smoke alarm, not a
 * critic: it says an angle is worth a second look, never that it is wrong.
 *
 * It is deliberately not the whole check. Measured on real runs, the Idea Agent
 * writes titles as metaphors — "The Data Drift Anomaly" for a topic about a flaky
 * Friday test — and those trip a pure word-overlap rule about half the time.
 */
export function checkAngleRelevance(seedTopic: string, angle: string): string[] {
  const seed = contentWords(seedTopic);
  if (!seed.size) return [];
  return shareAWord(contentWords(angle), seed)
    ? []
    : [`the angle "${short(angle)}" shares no subject word with the topic "${short(seedTopic)}"`];
}

/**
 * Idea → Story, the whole check. The lexical rule above screens for free; only an
 * angle it cannot vouch for is put to the model, so the common path costs nothing
 * and the rare one costs a single short call.
 *
 * Fails closed: if the adjudicator is unavailable or answers something else, the
 * lexical verdict stands. A halt the user can clear with Retry is the cheaper
 * mistake, given the alternative is a whole render on a drifted angle.
 */
export async function checkAngleDrift(
  seedTopic: string,
  angle: string,
  adjudicate?: (prompt: string) => Promise<string>,
): Promise<string[]> {
  const suspicion = checkAngleRelevance(seedTopic, angle);
  if (!suspicion.length || !adjudicate) return suspicion;

  const verdict = await adjudicate(
    `TOPIC: "${seedTopic}"\nPROPOSED ANGLE: "${angle}"\n\n` +
    'Is the angle a take on that topic, or is it about a different subject? ' +
    'Titles are often metaphors — judge the subject, not the wording. ' +
    'Answer with one word: RELATED or UNRELATED.',
  ).catch(() => '');

  return /\bRELATED\b/i.test(verdict) && !/\bUNRELATED\b/i.test(verdict)
    ? []
    : [`${suspicion[0]}, and a relevance check did not vouch for it`];
}

/**
 * The Script Agent's own two checks, promoted from warn-only to a halt.
 *
 * They stay warn-only where the pipeline calls them, and that is still right there:
 * a render already underway should not die on a regex's opinion. Here nothing has
 * been spent on images or audio yet and a retry costs one stage, so the same signal
 * is worth stopping for.
 */
export function checkScriptQuality(script: string, topic: string, sourceMaterial = ''): string[] {
  return [
    ...flagUnverifiedClaims(script, sourceMaterial).map((claim) => `unsourced claim: ${claim}`),
    ...flagCraftIssues(script, topic),
  ];
}

/** The story beats as one piece of prose, in the order they are told. */
export const storyProse = (story: StoryPlan): string =>
  [story.hook, story.conflict, story.escalation, story.twist, story.punchline, story.reaction,
    story.ending, story.lesson, story.cta]
    .map((beat) => beat?.trim())
    .filter(Boolean)
    .join(' ');

/**
 * Both bounds come off the padding planner's own constants rather than taste.
 *
 * Floor: padding is capped at MAX_PAD_FACTOR, so a script this short can only reach
 * its target by holding every scene at 95% of the maximum stretch — which is exactly
 * the "60s target, 103-word script" failure, where the video technically hit its
 * length and visibly sagged doing it. Works out at 0.70.
 *
 * Ceiling: padding can only add time, so an over-long script has no lever at all and
 * simply overruns. Set at double TARGET_TOLERANCE — one tolerance band of overrun is
 * within what the pipeline already calls on target.
 */
export const MIN_WORD_RATIO = 1 / (MAX_PAD_FACTOR * 0.95);
export const MAX_WORD_RATIO = 1 + 2 * TARGET_TOLERANCE;

export const wordCount = (text: string): number => (String(text ?? '').trim().match(/\S+/g) ?? []).length;

/** Script → Storyboard. The script has to be the length the render was planned for. */
export function checkDuration(script: string, targetSeconds: number): string[] {
  const budget = targetWordCount(targetSeconds);
  if (budget <= 0) return [];
  const words = wordCount(script);
  const ratio = words / budget;
  if (ratio < MIN_WORD_RATIO) {
    return [`the script is ${words} words against a ${budget}-word budget for ${targetSeconds}s (${Math.round(ratio * 100)}%) — padding would have to hold every scene at its cap to fill the gap`];
  }
  if (ratio > MAX_WORD_RATIO) {
    return [`the script is ${words} words against a ${budget}-word budget for ${targetSeconds}s (${Math.round(ratio * 100)}%) — padding can only add time, so this overruns the target`];
  }
  return [];
}

/**
 * Storyboard → Voice. Each image prompt has to be about what its scene says.
 *
 * A prompt is anchored if it shares one content word with its own narration or with
 * the episode topic, or if it names the character the script put in that scene — the
 * Storyboard Agent writes appearance-led prompts ("Raj, 34, beard, black polo…") and
 * those are about the scene even when they quote none of its words. Both anchors come
 * off the script side, never off the prompt's own siblings, or this would be checking
 * one generated field against another.
 *
 * The whole storyboard fails when more than a third of its scenes drift: a single
 * unanchored prompt is a legitimate atmospheric shot, and halting a render over one
 * establishing frame would make automate mode useless.
 *
 * ponytail: this catches a prompt with no connection to the script — the vacuous
 * "abstract technology concept" case. It does NOT catch a prompt that uses the right
 * words to describe the wrong picture; the historical Playwright storyboard named
 * tests and dashboards and still rendered stock illustration, and that drift is what
 * the entity-image sourcing work fixes, not this.
 */
export function checkImagePromptRelevance(scenes: ProductionScene[], topic: string): string[] {
  if (!scenes.length) return ['the package has no scenes'];
  const topicWords = contentWords(topic);
  const reasons: string[] = [];

  for (const scene of scenes) {
    const prompt = scene.imagePrompt?.positive?.trim();
    if (!prompt) {
      reasons.push(`scene ${scene.order} has no image prompt`);
      continue;
    }
    const narration = scene.dialogue.map((line) => line.text).join(' ').trim();
    // A wordless beat says nothing, so there is nothing for its prompt to be about.
    // Judged against the episode title alone this fired on both silent scenes of a
    // real six-scene storyboard — the reaction beats, which are supposed to be pure
    // picture. The check's question is "does this illustrate what the scene says";
    // a scene that says nothing does not get asked.
    if (!narration) continue;
    const anchor = new Set([...contentWords(narration), ...topicWords]);
    // Names are matched whole rather than as content words: plenty of them are three
    // letters, which is below the threshold that keeps filler out of the sets above.
    const named = (scene.characters ?? []).some((who) => who?.trim() && prompt.toLowerCase().includes(who.trim().toLowerCase()));
    if (!named && anchor.size && !shareAWord(contentWords(prompt), anchor)) {
      reasons.push(`scene ${scene.order}'s image prompt is about nothing the scene says: "${short(prompt)}"`);
    }
  }

  return reasons.length > scenes.length / 3 ? reasons : [];
}

/**
 * Voice → Render. Every scene has audible narration before the full-length encode.
 *
 * Literally the quality gate's own audio check, run at the last moment where stopping
 * is still cheap: the per-scene work above it is already paid for, the stitch below it
 * is the longest single step in the render. Calling the same function is the point —
 * a render that would fail the terminal gate on audio never starts.
 */
export async function checkSceneAudio(project: Project): Promise<string[]> {
  const check = await checkAudioPresent(project);
  return check.status === 'fail' ? [check.detail] : [];
}
