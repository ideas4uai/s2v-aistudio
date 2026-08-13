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
  const perSceneFloor = Math.max(5, Math.round(perScene * 0.6));

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
    `Read aloud it must run about ${seconds} seconds — roughly ${words} words at ${WORDS_PER_SECOND} words per second — split across ${sceneLo}-${sceneHi} scenes of about ${perScene} words each.`,
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
  const instructions = [
    `Lead with the tension. Open on the specific problem, contradiction or consequence the subject creates — not on background, not on how important the area is.`,
    `Name the subject explicitly within the first two lines. Say what it actually is; do not talk around it in abstractions.`,
    `Show the mechanism. If the subject has named parts, stages or moving pieces, name them and show each one doing its job — a reveal that is mentioned once and dropped is wasted.`,
    `One idea per line, and every scene must move the argument forward. If a scene could be cut without loss, cut it and give its words to the others.`,
    `Alternate between the concrete and the consequence: a specific example, then what it means.`,
    `Close on a beat that lands — a reversal, a consequence, or a question the viewer will carry. Never a summary of what was just said.`,
    `Write for the ear. Short sentences, contractions, active voice, no subordinate clause stacking.`,
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
export function flagUnverifiedClaims(script: string, allowed = ''): string[] {
  const patterns = [
    // No trailing \b after `%`: it is a non-word character, so "40%." has no
    // boundary there and the match would silently never fire.
    /\b\d+(?:\.\d+)?\s*(?:%|percent\b)/gi,
    /\b\d+(?:\.\d+)?\s*x\s+(?:faster|slower|more|less|better|cheaper)\b/gi,
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
