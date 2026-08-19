import {
  WORDS_PER_SECOND,
  targetWordCount,
  sceneCountRange,
  TARGET_TOLERANCE,
} from '../../utils/targetLength.js';

/**
 * Builds the Script Agent's prompt: one generic Role / Objective / Instructions /
 * Constraints template whose every specific word comes from `ScriptBrief`.
 *
 * The rule this file exists to enforce is that no brand, channel, universe or
 * character name appears in the code. A project with a rich knowledge base and a
 * one-off explainer with nothing but a topic run through the same builder; what
 * separates them is the data handed in, so a new universe needs no code change
 * and cannot be half-supported.
 *
 * It is a pure function on purpose — the four sections are assertable without an
 * API key, which is the only way "does a universe actually change the prompt"
 * is a test rather than an opinion.
 */

export interface ScriptCastMember {
  name: string;
  role?: string;
  personality?: string;
  voiceStyle?: string;
}

/** Everything the script prompt is allowed to know. Nothing is required but the topic. */
export interface ScriptBrief {
  topic: string;
  /** Runtime the finished narration must fill. Already clamped by targetLengthSeconds. */
  targetSeconds: number;
  /** Project's hook_strategy — 'question', 'statement', 'story', or a literal hook line. */
  hookStrategy?: string;
  /** 'shorts' | 'long'. Only changes how the format is named to the model. */
  mode?: string;
  /**
   * The series this episode belongs to, when there is one. `name` is whatever the
   * universe calls itself; this file never asks what it is.
   */
  brand?: {
    name?: string;
    world?: string;
    toneRules?: string;
    episodeStructure?: string;
  };
  /** Speaking characters. A non-empty cast turns the script into dialogue. */
  cast?: ScriptCastMember[];
  /** Pre-rendered block from buildKnowledgeContext(). Empty string when there is no KB. */
  knowledge?: string;
  /** The story beats to turn into speech, label -> beat. The agent never invents these. */
  spine?: Record<string, string | undefined>;
  /** Free-form material the caller has that no other field fits — cast notes, prior entities. */
  notes?: string[];
  /** DirectorAgent's visual plan, when the caller has one. */
  direction?: {
    mood?: string;
    narrativeArc?: string;
    pacing?: string;
    styleProfile?: string;
  };
}

export interface ScriptSections {
  role: string;
  objective: string;
  instructions: string[];
  constraints: string[];
}

const clean = (v?: string): string => (v ?? '').trim();

/**
 * The four sections, separately, so tests can assert each one responds to the
 * brief rather than eyeballing one concatenated blob.
 */
export function buildScriptSections(brief: ScriptBrief): ScriptSections {
  const cast = (brief.cast ?? []).filter((c) => clean(c.name));
  const brandName = clean(brief.brand?.name);
  const hasBrand = Boolean(brandName || clean(brief.brand?.world) || clean(brief.brand?.toneRules));
  const hasKnowledge = Boolean(clean(brief.knowledge));

  const seconds = brief.targetSeconds;
  const words = targetWordCount(seconds);
  const [sceneLo, sceneHi] = sceneCountRange(seconds);
  const wordLo = Math.round(words * (1 - TARGET_TOLERANCE));
  const wordHi = Math.round(words * (1 + TARGET_TOLERANCE));
  // Derived, never fixed. The old prompt demanded "at least 20 words per scene"
  // regardless of target, which alone overshoots a 30s budget — the script then
  // came back long and the padding logic got blamed for a scripting problem.
  const perScene = Math.max(1, Math.round(words / sceneHi));
  // 0.6 of the average was a floor high enough to forbid the short beats the
  // objective now asks for — the two rules contradicted and the floor won, which
  // is how every scene ended up the same length. Kept as a floor against a scene
  // that is a single word, not as a second way of specifying the average.
  const perSceneFloor = Math.max(3, Math.round(perScene * 0.45));

  // ── ROLE: who is writing. Comes off the brand, then the cast, then a default
  // that assumes nothing about subject matter beyond "explains things".
  const subject = hasBrand
    ? `the writer for ${brandName || 'this series'}`
    : 'an experienced content writer who writes short-form video scripts';
  const roleParts = [`You are ${subject}.`];
  if (cast.length) {
    roleParts.push(
      `This episode is performed by a cast, so the script is spoken dialogue, not narration.`,
    );
  }
  if (hasKnowledge) {
    roleParts.push(
      `The knowledge base below defines this series' voice, canon and format. Where it and your instincts disagree, it wins.`,
    );
  }
  if (!hasBrand && !cast.length) {
    roleParts.push(
      `There is no established series voice for this piece — write clearly and specifically in your own.`,
    );
  }

  // ── OBJECTIVE: what this particular script has to be.
  const format = brief.mode === 'long' ? 'long-form video' : 'short-form vertical video';
  const objectiveParts = [
    `Write the complete spoken script for a ${format} about "${clean(brief.topic)}".`,
    `Read aloud it must run about ${seconds} seconds — roughly ${words} words at ${WORDS_PER_SECOND} words per second — split across ${sceneLo}-${sceneHi} scenes averaging ${perScene} words.`,
    // "about N words each" was read as "N words every time", and the scripts came
    // back with every scene inside a two-word band. Each scene is one shot, so
    // uniform scenes are uniform shot lengths: measured stdev of 0.48s on a 6.18s
    // mean, against 1.44s on 3.76s for the video that shipped. The cut rhythm is
    // written here, not in the renderer, so the variation has to be asked for.
    `Average, not quota: vary scene length deliberately. Some beats should land in ${Math.max(3, Math.round(perScene * 0.45))}-${Math.round(perScene * 0.7)} words and others in ${Math.round(perScene * 1.2)}-${Math.round(perScene * 1.6)}. A short beat after a long one is heard as a cut; a run of equal-length scenes reads as a slideshow however good the writing is. At least two scenes must be markedly shorter than the rest.`,
  ];
  if (clean(brief.hookStrategy)) {
    objectiveParts.push(`Open on a hook of this kind: ${clean(brief.hookStrategy)}.`);
  }
  if (clean(brief.direction?.mood) || clean(brief.direction?.narrativeArc)) {
    objectiveParts.push(
      `It has to land as: ${[clean(brief.direction?.mood), clean(brief.direction?.narrativeArc), clean(brief.direction?.pacing)].filter(Boolean).join(' / ')}.`,
    );
  }
  objectiveParts.push(
    `The length is the brief, not a suggestion: a script written for a different runtime and stretched afterwards reads as stretched.`,
  );

  // ── INSTRUCTIONS: how it should be built. Structural, and true of any subject.
  //
  // Several of these encode short-form retention craft: front-load the payload, pay
  // off the hook, cut anything that would not be missed, vary the rhythm. They make
  // a script worth staying for, which is *correlated* with retention and is
  // not a lever on reach. What an upload actually reaches is decided by topic choice,
  // title, thumbnail, posting time and the recommendation system, none of which this
  // agent writes or can see. It controls the words. Nothing here buys an audience.
  const instructions = [
    `Lead with the tension. Open on the specific problem, contradiction or consequence the subject creates — not on background, not on how important the area is. The first line must be one that could not be pasted onto a video about anything else.`,
    `Name the subject explicitly within the first two lines. Say what it actually is; do not talk around it in abstractions.`,
    `Front-load the payload. The most surprising or most useful thing you have goes in the first quarter of the runtime, not saved for the end. Someone who leaves after a few seconds should already have got something.`,
    `Show the mechanism. If the subject has named parts, stages or moving pieces, name them and show each one doing its job — a reveal that is mentioned once and dropped is wasted.`,
    `Pay off the opening. Whatever the first line promises, asks or implies has to be answered in plain words by a later scene. An opening that is never returned to is bait, and the viewer feels it.`,
    `One idea per line, and every scene must move the argument forward. If a scene could be cut without loss, cut it and give its words to the others. The same test applies sentence by sentence: delete any sentence that would not be missed.`,
    `Alternate between the concrete and the consequence: a specific example, then what it means.`,
    `Vary sentence length on purpose. A long line followed by a short one is heard as emphasis; a run of same-length sentences flattens into a drone no matter how good the words are.`,
    `Close on a beat that lands — a reversal, a consequence, or a question the viewer will carry. A closing question has to be about the specific thing this script just showed, the kind only someone who watched it would answer; a question that would sit equally well on any video is not a close. Never a summary of what was just said.`,
    `Write for the ear. Contractions, active voice, no subordinate clause stacking. A sentence that needs a second reading has already lost a listener who cannot re-read.`,
    `Adjectives are not content. At most one modifier per noun, and no adverb that is not doing work — "smart, autonomous tools that intelligently update your tests" says less than "tools that update your tests", in twice the runtime.`,
    `Each scene's visual field describes what is on screen: subject, expression, environment, light. Never written text, numbers, labels, charts, signage or UI — rendered text is clipped by the crop and fights the burned-in captions.`,
  ];
  if (cast.length) {
    instructions.push(
      `Every narration field is one character speaking, written as "NAME: line", using only these names. Never write about the cast in the third person and never invent a character.`,
      `Emotion and reaction carry the scene. Do not explain the joke or the point after making it.`,
    );
  }

  // ── CONSTRAINTS: what must not happen. Budget first, then honesty, then format.
  const constraints = [
    `Total spoken words across ALL scenes: between ${wordLo} and ${wordHi}. Count them before answering. Under is better than over.`,
    `No scene's narration may be under ${perSceneFloor} words${cast.length ? ', except at most one wordless reaction beat' : ''}.`,
    `No statistics, percentages, benchmark figures, dates, study citations or named research unless they appear verbatim in the material above. If you want to reach for a number, use a concrete example instead. An invented figure is worse than no figure.`,
    `Do not claim anything about the subject you were not given. No capability, no adoption, no comparison you cannot point at in the brief.`,
    `Match every claim to the strength the material supports. Words that promise a guaranteed outcome — fixes, solves, eliminates, guarantees, always, automatically, never fails — are for outcomes the material above states are guaranteed. Everywhere else, describe the capability as it is: attempts to, proposes, is designed to, helps. "It repairs your tests" and "it proposes a repair you review" are different products; write the one you were actually given.`,
    `No generic dramatic opener. A first line that is a bare intensifier — "Shocking." "Insane." "You won't believe this." "This changes everything." — would fit any video on any subject, and a viewer reads it as bait before hearing the second line. Open hard, but let the force come from the specific thing at stake rather than from adjectives about it.`,
    `One core concept for the whole script. Covering three ideas shallowly is the failure mode; depth on one is the goal.`,
    `No generic pain-point preamble — "developers everywhere struggle with…", "we've all been there" — unless that struggle is literally the subject.`,
    `Plain speakable prose only: no emoji, no hashtags, no markdown, no bracketed stage directions, no URLs, no spelled-out symbols.`,
  ];
  if (clean(brief.brand?.toneRules)) {
    constraints.push(`Tone is locked by this series and is not yours to adjust: ${clean(brief.brand!.toneRules)}`);
  }
  if (clean(brief.brand?.episodeStructure)) {
    constraints.push(`Episode structure is locked: ${clean(brief.brand!.episodeStructure)}`);
  }
  if (brief.spine && Object.values(brief.spine).some((b) => clean(b))) {
    constraints.push(
      `The story beats below are already approved. Turn them into speech in the order given; do not add beats, drop beats or reorder them.`,
    );
  }

  return { role: roleParts.join(' '), objective: objectiveParts.join(' '), instructions, constraints };
}

const numbered = (lines: string[]): string => lines.map((l, i) => `${i + 1}. ${l}`).join('\n');

/** The full prompt string handed to the model. */
export function buildScriptPrompt(brief: ScriptBrief): string {
  const s = buildScriptSections(brief);
  const cast = (brief.cast ?? []).filter((c) => clean(c.name));

  const blocks = [
    `## ROLE\n${s.role}`,
    `## OBJECTIVE\n${s.objective}`,
    `## INSTRUCTIONS\n${numbered(s.instructions)}`,
    `## CONSTRAINTS\n${numbered(s.constraints)}`,
  ];

  if (clean(brief.brand?.world)) blocks.push(`## WORLD\n${clean(brief.brand!.world)}`);
  if (cast.length) {
    blocks.push(
      `## CAST — only these characters may speak\n${cast
        .map((c) => `- ${c.name}${c.role ? ` (${c.role})` : ''}: ${[clean(c.personality), clean(c.voiceStyle)].filter(Boolean).join(' ')}`)
        .join('\n')}`,
    );
  }
  if (clean(brief.knowledge)) blocks.push(`## ${clean(brief.knowledge)}`);

  const notes = (brief.notes ?? []).map(clean).filter(Boolean);
  if (notes.length) blocks.push(`## CONTEXT\n${notes.join('\n')}`);

  const spine = Object.entries(brief.spine ?? {}).filter(([, v]) => clean(v));
  if (spine.length) {
    blocks.push(`## STORY BEATS\n${spine.map(([k, v]) => `- ${k}: ${clean(v)}`).join('\n')}`);
  }

  blocks.push(`## OUTPUT
Output ONLY valid JSON, no markdown fence:
{
  "rawScript": "Every scene's spoken text joined together.",
  "scenes": [
    {
      "narration": ${cast.length ? '"NAME: the line this character speaks."' : '"The spoken text for this scene."'},
      "visual": "Who or what is on screen, their expression, the environment, the light.",
      "duration": 5,
      "order": 0
    }
  ]
}`);

  return blocks.join('\n\n');
}

/**
 * Flags claims a script was told not to invent. Warn-only by design: a regex
 * cannot tell a supplied figure from a hallucinated one, and failing a render on
 * that guess would be worse than the problem. It exists so an unsourced number
 * shows up in the log at generation time instead of in a human review afterwards.
 */
// No trailing \b after `%`: it is a non-word character, so "40%." has no boundary
// there and the match would silently never fire.
export const PERCENT_RE = /\b\d+(?:\.\d+)?\s*(?:%|percent\b)/gi;
export const MULTIPLIER_RE = /\b\d+(?:\.\d+)?\s*x\s+(?:faster|slower|more|less|better|cheaper)\b/gi;

/**
 * The figure shapes worth putting on screen, strongest first. Shares the percent and
 * multiplier patterns with flagUnverifiedClaims above — the same numbers that need
 * sourcing are the ones worth a call-out, so they are defined once.
 *
 * Ordered: a percentage beats a bare count in the same sentence, because "40%" reads
 * as a claim and "3 steps" reads as structure.
 */
export const FIGURE_PATTERNS = [
  PERCENT_RE,
  MULTIPLIER_RE,
  /\b\d+(?:\.\d+)?\s*(?:x|times)\b/gi,
  /\b\d[\d,]*(?:\.\d+)?\s*(?:ms|s|seconds|minutes|hours|days|weeks|months|years|k|m|bn|billion|million|thousand)\b/gi,
  /\b\d[\d,]*(?:\.\d+)?\b/g,
];

/** A bare four-digit year. "in 2025" is a date, not a statistic worth a call-out. */
const YEAR_ONLY = /^(?:19|20)\d{2}$/;

/** The single most call-out-worthy figure in a piece of text, or '' if there is none. */
export function extractFigure(text: string): string {
  for (const re of FIGURE_PATTERNS) {
    const all = String(text || '').match(new RegExp(re.source, re.flags)) || [];
    for (const hit of all) {
      const value = hit.trim();
      // Measured on real scripts: "Staying focused in 2025 feels harder" was being
      // read as a figure and given a counting stat call-out.
      if (YEAR_ONLY.test(value)) continue;
      return value;
    }
  }
  return '';
}

export function flagUnverifiedClaims(script: string, allowed = ''): string[] {
  const patterns = [
    PERCENT_RE,
    MULTIPLIER_RE,
    /\baccording to\b[^.!?]*/gi,
    /\b(?:a|the|one|recent)\s+(?:study|survey|report|benchmark)\b[^.!?]*/gi,
  ];
  const found = new Set<string>();
  for (const re of patterns) {
    for (const m of script.matchAll(re)) {
      const hit = m[0].trim();
      // Anything quoted verbatim from the source material is sourced, not invented.
      if (!allowed.toLowerCase().includes(hit.toLowerCase())) found.add(hit);
    }
  }
  return [...found];
}

/** A first line that is nothing but an intensifier. Checked against the sentence stripped of punctuation. */
const BARE_INTENSIFIER = /^(shocking|insane|crazy|unbelievable|wild|terrifying|mind-?blowing|wow|whoa|huge)$/i;
const CLICKBAIT_PHRASE = /you won'?t believe|this changes everything|nobody is talking about|stop scrolling|the truth about|here'?s why you/i;
/**
 * Words that promise an outcome rather than describe a capability. "fix" needs its
 * object attached: "manual fixes after every release" is the noun naming the problem,
 * not a claim about what anything does.
 */
const GUARANTEE = /\b(?:solves?|solved|eliminat(?:es|ed|ing)|guarantees?|guaranteed|never fails?|always works?|fix(?:es|ed|ing)?\s+(?:your|the|their|its|it|them|themselves|itself|these|those|broken|failing|every\w+|anything))\b/i;
const HEDGE = /\b(attempts?|tries|trying|proposes?|proposed|suggests?|designed to|meant to|may|might|aims? to)\b/i;
/** Words too common to prove a closing question is about anything in particular. */
const GENERIC_CLOSE_WORDS = new Set([
  'what', 'when', 'where', 'which', 'would', 'could', 'should', 'your', 'you', 'that', 'this', 'with',
  'will', 'next', 'have', 'they', 'them', 'their', 'from', 'into', 'than', 'then', 'more', 'most',
  'just', 'only', 'ever', 'still', 'about', 'after', 'before', 'because', 'going', 'make', 'made',
  'something', 'anything', 'everything', 'build', 'ship', 'create', 'try', 'think', 'know', 'else',
]);

/**
 * Flags the three weaknesses that survived human review of real scripts: a generic
 * dramatic opener, a guarantee where the tool only attempts, and a closing question
 * that would fit any video. Each maps to a constraint above, so this is the constraint
 * failing loudly in the render log at generation time rather than in a review later.
 *
 * Warn-only, like flagUnverifiedClaims and for the same reason: the material may
 * genuinely support the strong claim and no regex can read the material.
 */
export function flagCraftIssues(script: string, topic = ''): string[] {
  const sentences = (script.match(/[^.!?]+[.!?]*/g) ?? []).map((s) => s.trim()).filter(Boolean);
  if (!sentences.length) return [];
  const issues: string[] = [];
  const short = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}…` : s);

  const first = sentences[0];
  if (BARE_INTENSIFIER.test(first.replace(/[.!?,]+$/, '').trim()) || CLICKBAIT_PHRASE.test(first)) {
    issues.push(`generic opener: "${short(first)}"`);
  }

  for (const s of sentences) {
    const hit = GUARANTEE.exec(s);
    if (hit && !HEDGE.test(s)) issues.push(`overclaim "${hit[0]}": "${short(s)}"`);
  }

  const last = sentences[sentences.length - 1];
  if (last.endsWith('?')) {
    // A closing question that shares no vocabulary with the topic or with the script
    // it closes is not a question about this video.
    const said = `${topic} ${sentences.slice(0, -1).join(' ')}`.toLowerCase();
    const content = (last.toLowerCase().match(/[a-z']{4,}/g) ?? []).filter((w) => !GENERIC_CLOSE_WORDS.has(w));
    // Singular stem too: a close asking about "resources" is about the script that
    // spent its runtime on resource pressure.
    if (!content.some((w) => said.includes(w.replace(/s$/, '')))) {
      issues.push(`off-topic close: "${short(last)}"`);
    }
  }

  return issues;
}
