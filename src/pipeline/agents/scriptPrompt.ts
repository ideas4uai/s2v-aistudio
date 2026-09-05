import {
  WORDS_PER_SECOND,
  countWords,
  targetWordCount,
  sceneCountRange,
  TARGET_TOLERANCE,
} from '../../utils/targetLength.js';
import { stripInternalLabel, hookStrategyBrief } from '../../utils/narration.js';

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
  /**
   * Display name of the language the narration must be spoken in ('Telugu'), from
   * languageName(). Absent means English.
   *
   * This field is the fix for a silent failure: the voice router picked the correct
   * Telugu model and this prompt then handed it English text, which Piper reads through
   * Telugu phonetics. Nothing downstream catches it — the WAV is valid and not silent,
   * so the quality gate passes and an unintelligible video ships as a success.
   */
  language?: string;
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
 * The first line's word budget.
 *
 * Short-form retention is decided in the first few seconds, and at the speech rate this
 * project already uses everywhere else, six words is about two and a half of them. The
 * number is here rather than in targetLength.ts because it is a craft rule about one
 * sentence, not a property of how long speech takes — the SECONDS are derived from the
 * shared constant so the two can never drift.
 */
export const HOOK_MAX_WORDS = 6;
export const hookMaxSeconds = (): number => Number((HOOK_MAX_WORDS / WORDS_PER_SECOND).toFixed(1));

/**
 * Subject matter where the entertainment grammar of a short — hook, curiosity gap,
 * payoff — is the wrong instrument.
 *
 * Matched against the topic and the supplied material rather than the finished script,
 * so the caution reaches the prompt before anything is written. Deliberately narrow:
 * these are words that in a topic line almost always mean real people were killed or
 * displaced. It will miss euphemistic topics — "The first day of Independent India" does
 * not contain one of these words, and the material it came with is what catches it —
 * which is why the post-hoc flag below exists as well.
 */
const SENSITIVE_TOPIC = /\b(genocide|holocaust|massacre|atrocit(?:y|ies)|partition|famine|ethnic cleansing|war crimes?|terroris[mt]|casualt(?:y|ies)|refugees?|displacement|displaced|massacred|mass graves?|slaver(?:y|ies)|lynch(?:ing|ings)?|assassinat(?:ion|ed)|bombing|shooting|suicides?|abuse|trafficking|epidemic|pandemic deaths?)\b/i;

/** Does this brief concern real human suffering? Topic plus everything handed in with it. */
export function isSensitiveSubject(...parts: (string | undefined)[]): boolean {
  return SENSITIVE_TOPIC.test(parts.filter(Boolean).join(' '));
}

/**
 * The material this brief was actually GIVEN about its subject.
 *
 * knowledge and notes only. The story spine is deliberately excluded: those beats were
 * generated upstream from the same empty starting point, so counting them as a source
 * would let the pipeline cite itself.
 */
export function briefSourceMaterial(brief: ScriptBrief): string {
  return [brief.knowledge, brief.notes?.join(' ')].filter(Boolean).join(' ').trim();
}

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
  const hookSeconds = hookMaxSeconds();

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
    `Write the complete spoken script for a ${format} about "${stripInternalLabel(brief.topic)}".`,
    `Read aloud it must run about ${seconds} seconds — roughly ${words} words at ${WORDS_PER_SECOND} words per second — split across ${sceneLo}-${sceneHi} scenes averaging ${perScene} words.`,
    // "about N words each" was read as "N words every time", and the scripts came
    // back with every scene inside a two-word band. Each scene is one shot, so
    // uniform scenes are uniform shot lengths: measured stdev of 0.48s on a 6.18s
    // mean, against 1.44s on 3.76s for the video that shipped. The cut rhythm is
    // written here, not in the renderer, so the variation has to be asked for.
    `Average, not quota: vary scene length deliberately. Some beats should land in ${Math.max(3, Math.round(perScene * 0.45))}-${Math.round(perScene * 0.7)} words and others in ${Math.round(perScene * 1.2)}-${Math.round(perScene * 1.6)}. A short beat after a long one is heard as a cut; a run of equal-length scenes reads as a slideshow however good the writing is. At least two scenes must be markedly shorter than the rest.`,
  ];
  // Was `Open on a hook of this kind: ${hookStrategy}` — which puts the raw slug
  // in the model's context as a usable word. A shipped upload opens on the caption
  // "Shocking. Your software": the adjective came from the setting, not the writer.
  // hookStrategyBrief describes the move instead of naming it.
  const hookBrief = hookStrategyBrief(brief.hookStrategy);
  if (hookBrief) objectiveParts.push(hookBrief);
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
  const language = clean(brief.language) || 'English';
  const constraints = [
    // First, ahead of every craft rule: those rules are about how a sentence is built,
    // and this is about which language it is built in. A model that gets this wrong
    // produces output no downstream check can detect as wrong.
    language === 'English'
      ? `Write every spoken word in English.`
      : `Write every spoken word in ${language}, using ${language}'s own script. Not English. Not ${language} transliterated into the Latin alphabet — the speech engine reads the characters you write, so Latin letters are pronounced as ${language} letters and the result is unintelligible. Product names, company names and technical terms with no ${language} equivalent stay in their original form; everything around them is ${language}.`,
    `Total spoken words across ALL scenes: between ${wordLo} and ${wordHi}. Count them before answering. Under is better than over.`,
    `No scene's narration may be under ${perSceneFloor} words${cast.length ? ', except at most one wordless reaction beat' : ''}.`,
    `No statistics, percentages, benchmark figures, dates, study citations or named research unless they appear verbatim in the material above. If you want to reach for a number, use a concrete example instead. An invented figure is worse than no figure.`,
    `Do not claim anything about the subject you were not given. No capability, no adoption, no comparison you cannot point at in the brief.`,
    `Match every claim to the strength the material supports. Words that promise a guaranteed outcome — fixes, solves, eliminates, guarantees, always, automatically, never fails — are for outcomes the material above states are guaranteed. Everywhere else, describe the capability as it is: attempts to, proposes, is designed to, helps. "It repairs your tests" and "it proposes a repair you review" are different products; write the one you were actually given.`,
    // The general form of three separate leaks: every value in this prompt is
    // metadata describing the script, and the model kept treating some of them as
    // words for the script. "CRAFT1 - Playwright..." produced the spoken line
    // "CRAFT1 gives Playwright a vital healing touch"; the hookStrategy slug
    // produced "Shocking. Your software". Stripping known labels handles the cases
    // we have seen; this handles the ones we have not.
    `Everything above describes the script — it is not material to quote. Project titles, identifiers, codes, setting names and section labels are how this job was filed, not things the subject is. Never speak a label, a slug or an internal name, and never treat one as a product, person, company or feature. If a title carries a prefix or code you cannot explain from the material, it is filing, so ignore it.`,
    `No generic dramatic opener. A first line that is a bare intensifier — "Shocking." "Insane." "You won't believe this." "This changes everything." — would fit any video on any subject, and a viewer reads it as bait before hearing the second line. Open hard, but let the force come from the specific thing at stake rather than from adjectives about it.`,
    // Three real scripts opened at 11, 12 and 14 words. Whatever the first line is
    // doing, it is doing it after the point most viewers have already decided.
    `First line: at most ${HOOK_MAX_WORDS} words — about ${hookSeconds} seconds spoken — and those words must carry the subject or the tension, not set up for it. "Why do powerful AI models sometimes invent facts or give outdated answers?" spends twelve words arriving at a question; "AI models invent facts." spends four and has already landed. This is a cap on the FIRST sentence only; the second can breathe.`,
    // The measured failure. Every example below is lifted from a real generated script.
    `No stacked adjectives and no decorative comparison. Three modifiers in a row — "dynamic, intricate, constantly evolving" — is the shape of a sentence written before deciding what to say; put the one specific fact it is standing in for in its place. A comparison earns its keep only when the thing compared to does the explaining: "a sleek electric vehicle, integrated and optimized for today's high-speed demands" tells a viewer nothing about software, while "it ships its own browser, so there is no driver version to match" says the thing the metaphor was gesturing at. If you cannot say what the comparison teaches, delete it and state the fact.`,
    // The existing close constraint already requires the question be on-topic, and all
    // four real scripts passed it — they were on-topic AND interchangeable. This is the
    // structural half: a question at both ends is a template a regular viewer can predict.
    `Do not bookend with questions. If the first line is a question, the last must not be. Vary the close by what the content actually supports — the consequence stated flat, the single fact worth remembering, a specific next step, or a question naming something only this script showed. "What does this mean for us?", "Where do you start?", "What lessons does this hold?" are questions about the category, not about the thing, and they fit any script on any subject.`,
    `One core concept for the whole script. Covering three ideas shallowly is the failure mode; depth on one is the goal.`,
    `No generic pain-point preamble — "developers everywhere struggle with…", "we've all been there" — unless that struggle is literally the subject.`,
    `Plain speakable prose only: no emoji, no hashtags, no markdown, no bracketed stage directions, no URLs, no spelled-out symbols.`,
  ];
  // A serious subject gets a different instrument, not a louder one. This ADDS caution
  // and never licenses a number: the existing no-invented-figures constraint still
  // stands, and this pushes the other way — toward saying the figure is disputed rather
  // than toward saying it more confidently.
  if (isSensitiveSubject(brief.topic, brief.knowledge, brief.notes?.join(' '), Object.values(brief.spine ?? {}).join(' '))) {
    constraints.push(
      `This subject involves real people who were killed, displaced or harmed. Drop the entertainment grammar: no curiosity-gap hook, no reveal held back for effect, no metaphor that makes suffering into an image — "independence arrived like a painful, necessary surgery" turns a million deaths into a figure of speech. Be plain, specific and measured. Where the material gives a casualty or displacement figure, say who estimates it and that estimates differ; where it gives none, say the scale is disputed rather than choosing a number. Never state a death toll as a flat fact. Under-claiming here costs nothing; over-claiming is the whole risk.`,
    );
  }
  // A comparison with nothing to compare from.
  //
  // The failure this prevents, measured on a real script: asked for a three-phone speed
  // test with no benchmark supplied, the agent wrote "the iPhone 17 Pro opened apps
  // slower", "fluid 4K rendering on one, jerky buffering on another" and "the
  // performance gap is undeniable" — a test report for a test nobody ran. Every existing
  // detector passed it, because it cites no numbers at all.
  //
  // Telling it not to invent results is only half the instruction: a model with a
  // comparison format and no content will narrate tension instead, which is the same
  // hole with better prose. So this says what to write INSTEAD.
  if (isComparisonTopic(brief.topic) && !briefSourceMaterial(brief)) {
    constraints.push(
      `This is a comparison and you have been given no benchmark, test, review or source for it. You therefore do not know the result, and you must not write one. Inventing a winner is the obvious version of this mistake; narrating one is the version that slips through — "one surges ahead, another lags", "smooth on one, jerky on another", "the gap is undeniable" all report a finding nobody made, and a viewer cannot tell them from a finding that exists.`,
      `Write the useful thing you actually have instead: name the specific dimension that decides this comparison, say what would have to be measured to settle it, and explain why that measurement is the one that matters rather than the spec everyone quotes. "Sustained performance after fifteen minutes is what separates these, because every one of them wins a thirty-second benchmark" is honest, concrete and more useful than a fabricated verdict. Name the trade-off, never the winner.`,
      `Your first line makes a promise and this script must keep it within its own runtime. If the hook says something lost, the body says what and why; if you cannot say that, the hook must be about the question rather than about an answer you do not have. Decide the payoff first and write the hook last so the hook promises exactly what the body delivers — a hook that outruns its script is the single most common way short-form content loses the viewer it just won.`,
    );
  }

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
/**
 * Numbers a script says out loud. A narrator reads "200x" as "two hundred times", and a
 * model writing FOR the ear spells it that way — which is how "discover new exploits two
 * hundred times faster" walked past a pattern that only knew digits.
 */
const NUMBER_WORD = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|dozens?|scores?)';
const COMPARATIVE = '(?:faster|slower|more|less|better|cheaper|quicker|higher|lower|greater|bigger|smaller|stronger|weaker|worse|longer|shorter)';
export const MULTIPLIER_RE = new RegExp(
  `\\b(?:\\d[\\d,]*(?:\\.\\d+)?|${NUMBER_WORD}(?:[\\s-]+${NUMBER_WORD})*)\\s*(?:x|times|fold|-fold)\\s+${COMPARATIVE}\\b`,
  'gi',
);

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
/**
 * Closing frames that ask about the category rather than about the thing.
 *
 * A supplement to the on-topic check below, not a replacement: these shapes pass that
 * check whenever they happen to reuse a topic word, which is exactly how "What profound
 * lessons does this hold for India's journey?" got through.
 */
const GENERIC_CLOSE_SHAPE = /\b(?:what does (?:this|that|it) mean for|where do (?:you|we) (?:start|begin|go)|what (?:profound |real |deeper )?lessons?|how do we (?:uphold|ensure|balance|navigate)|what(?:'s| is) next for|are (?:you|we) ready for|only time will tell|the future of \w+ (?:is|remains))\b/i;

/**
 * A run of comma-separated modifiers standing in for a fact — "dynamic, intricate,
 * constantly evolving". Returns the run for the message, or '' when the sentence is
 * doing something else.
 *
 * Three or more comma-separated segments where at least two are one or two words long,
 * ignoring the connectives that legitimately sit in commas. Without that exclusion
 * "Playwright, conversely, is a sleek electric vehicle" trips it, and the reason it is
 * a bad sentence has nothing to do with the word "conversely".
 */
const COMMA_CONNECTIVE = /^(?:conversely|however|therefore|instead|meanwhile|first|second|third|then|finally|next|though|although|yet|still|so|and|but|or|for example|of course|in fact|in short|after all|again|now|today|here|there|too|also|indeed|rather|otherwise)$/i;

export function adjectiveStack(sentence: string): string {
  const parts = sentence.replace(/[.!?]+$/, '').split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 3) return '';
  const modifiers = parts.filter((p) => {
    const words = p.split(/\s+/).filter(Boolean);
    // Strictly lowercase, no trailing capitals. A stack of adjectives is lowercase;
    // anything with a capital inside it is a name or an acronym, which is how the
    // appositive "Retrieval-Augmented Generation, or RAG, solves this" was being read
    // as three modifiers on a first regeneration run.
    return words.length <= 2 && !COMMA_CONNECTIVE.test(p) && /^[a-z][a-z' -]*$/.test(p);
  });
  return modifiers.length >= 2 ? modifiers.join(', ') : '';
}

/**
 * A comparison frame: the sentence that hands the subject over to something else.
 */
const COMPARISON_FRAME = /\b(?:think of \w+ as|imagine (?:a|an|the)\b|it'?s like|its like|like (?:a|an) \w+ (?:that|who|navigating|walking|driving)|picture (?:a|an)\b|is (?:a|the) (?:sleek|shiny|humble|digital|virtual) )/i;

/** Words from the topic worth matching on, stemmed crudely so "retrieval" reaches "retrieves". */
const topicStems = (topic: string): string[] =>
  (topic.toLowerCase().match(/[a-z]{5,}/g) ?? []).map((w) => w.slice(0, 6));

const mentionsSubject = (sentence: string, stems: string[]): boolean => {
  const lower = sentence.toLowerCase();
  return stems.some((s) => lower.includes(s));
};

/**
 * A metaphor that runs on after the subject has left the room.
 *
 * A regex cannot judge whether a comparison teaches anything — "like a perfectly indexed
 * library" genuinely explains retrieval, and no pattern separates it from "a digital
 * child navigating an infinite house" by looking at the words. What IS measurable is how
 * long the script stays inside the vehicle: an analogy that earns its place lands and
 * returns to the subject, while a decorative one keeps going.
 *
 * So this counts consecutive sentences after a comparison frame that never name the
 * subject. Two or more and the script is describing the metaphor rather than the thing.
 * Warn-only, like everything else here.
 */
export function extendedMetaphor(script: string, topic = ''): string[] {
  const sentences = (script.match(/[^.!?]+[.!?]*/g) ?? []).map((s) => s.trim()).filter(Boolean);
  const stems = topicStems(topic);
  if (!stems.length) return [];
  const out: string[] = [];
  for (let i = 0; i < sentences.length; i++) {
    if (!COMPARISON_FRAME.test(sentences[i])) continue;
    let run = 0;
    for (let j = i + 1; j < sentences.length && !mentionsSubject(sentences[j], stems); j++) run++;
    if (run >= 2) {
      const shown = sentences[i].length > 60 ? `${sentences[i].slice(0, 57)}…` : sentences[i];
      out.push(`extended metaphor (${run + 1} sentences without naming the subject): "${shown}"`);
    }
    i += run;
  }
  return out;
}

/**
 * A casualty or displacement figure stated as flat fact.
 *
 * Warn-only and deliberately one-directional: it asks for a human to check a number, and
 * can never produce or sharpen one. A script that already hedges — "estimates range",
 * "historians disagree" — is left alone, because that is the thing it is asking for.
 */
const CASUALTY_FIGURE = /\b(?:\d[\d,.]*|one|two|three|several|many|millions?|thousands?|hundreds?|countless)\s+(?:\w+\s+){0,2}(?:people\s+)?(?:died|killed|dead|deaths|murdered|massacred|displaced|refugees|casualties|victims|perished|slaughtered)\b/i;
const SOURCED = /\b(?:estimat\w+|approximat\w+|roughly|around|between|historians|scholars|sources|disputed|contested|varies|vary|range[sd]?|according to|thought to|believed to|as many as|at least|some say|no agreed|unknown)\b/i;

/**
 * Words that turn a sentence into a reported measurement.
 *
 * Comparatives only — "faster", not "fast". A script may call a phone fast without
 * claiming to have timed it; saying one is FASTER than another is a result.
 *
 * Wider than the COMPARATIVE list MULTIPLIER_RE uses: that one only has to survive a
 * number in front of it ("three times faster"), while this one has to catch a bare
 * sensory claim like "snappier" or "crisper" standing on its own.
 */
const RESULT_COMPARATIVE = 'slower|faster|quicker|smoother|better|worse|higher|lower|longer|shorter|hotter|cooler|brighter|dimmer|louder|sharper|crisper|snappier|laggier|heavier|lighter';

/**
 * Sentence shapes that state a comparative outcome as observed.
 *
 * Each one is lifted from the script this detector was written for. They are not
 * decorative language — every one of them tells the viewer a test happened and reports
 * what it found.
 */
const UNSOURCED_RESULT_PATTERNS: Array<{ re: RegExp; kind: string }> = [
  // "the iPhone 17 Pro opened apps slower" -- a verb and then a comparative.
  { re: new RegExp(String.raw`\b\w+(?:ed|s)\b(?:\s+\w+){0,3}\s+\b(?:${COMPARATIVE})\b`, 'gi'), kind: 'measured outcome' },
  // "faster than", the explicit form.
  { re: new RegExp(String.raw`\b(?:${COMPARATIVE})\s+than\b`, 'gi'), kind: 'measured outcome' },
  // "Fluid 4K rendering on one, jerky buffering on another."
  { re: /\bon one\b[^.!?]*\bon (?:another|the other)\b/gi, kind: 'split result' },
  // "Some cores fire seamlessly; others grapple with friction."
  { re: /\bsome\b[^.!?]{0,60}?\bothers\b/gi, kind: 'split result' },
  // "One line surges ahead, another lags."
  { re: /\bone\b[^.!?]{0,60}?\banother\b[^.!?]{0,40}?\b(?:lags?|trails?|stumbles?|falters?|struggles?)\b/gi, kind: 'split result' },
  // "The most expensive phone just lost." / "innovation wins"
  { re: /\b(?:just\s+)?(?:lost|won|wins|beat|beats|outperforms?|outperformed|edges?\s+out|takes?\s+the\s+(?:win|crown|lead|top\s+spot))\b/gi, kind: 'verdict' },
  // "The performance gap is undeniable." / "the winner is"
  { re: /\bthe\s+(?:\w+\s+){0,2}gap\s+is\b/gi, kind: 'verdict' },
  { re: /\bthe\s+(?:winner|loser|champion|verdict)\s+(?:is|was)\b/gi, kind: 'verdict' },
];

/** Comparison-format topics: "A vs B", "A or B", a speed test, a showdown. */
export function isComparisonTopic(topic = ''): boolean {
  return /\bvs\.?\b|\bversus\b|\bcompared? (?:to|with)\b|\bshowdown\b|\bspeed test\b|\bhead[- ]to[- ]head\b|\bwhich (?:is|one)\b/i.test(topic);
}

/**
 * Confident narration of a test result nobody ran.
 *
 * ── Why this is not flagUnverifiedClaims ──────────────────────────────────────
 * That detector catches figures: percentages, multipliers, "according to", "a recent
 * study". Run against the script this one was written for it returns NOTHING, because
 * the script cites no numbers at all. It says "the iPhone 17 Pro opened apps slower",
 * "fluid 4K rendering on one, jerky buffering on another", "the performance gap is
 * undeniable" — a benchmark reported in prose. A viewer cannot tell that from a
 * benchmark that happened, which is exactly what makes it worse than a made-up number:
 * a number invites checking and this does not.
 *
 * ── Why it is not flagCraftIssues either ──────────────────────────────────────
 * Craft issues are about writing that is bad on its face — stacked adjectives, a
 * metaphor doing the explaining, a close that fits any video. These sentences are well
 * written. The defect is not the prose, it is that the prose asserts a finding.
 *
 * ── The mechanism ─────────────────────────────────────────────────────────────
 * Two conditions, and BOTH are required, which is what keeps legitimate comparison
 * content untouched:
 *
 *   1. the sentence states a comparative outcome (the patterns above), and
 *   2. the material handed to the writer does not contain it.
 *
 * `supplied` is the brief's own source material — the knowledge block, the caller's
 * notes, the approved story beats — NOT the whole prompt. Passing the prompt would
 * mean the constraints that name these very words count as a source for them.
 *
 * A script given real test data quotes it, so the phrase appears in `supplied` and
 * nothing is flagged. A script given nothing invents the result, and there is nowhere
 * for the phrase to have come from.
 */
export function flagUnsourcedResults(script: string, supplied = ''): string[] {
  const haystack = supplied.toLowerCase();
  // A source that says nothing cannot support anything; the empty string must not
  // become a substring match that clears every claim.
  const sourced = (phrase: string) => haystack.length > 0 && haystack.includes(phrase.toLowerCase());

  const sentences = (script.match(/[^.!?]+[.!?]*/g) ?? []).map((s) => s.trim()).filter(Boolean);
  const found: string[] = [];
  const seen = new Set<string>();

  for (const sentence of sentences) {
    // A question does not assert a finding. "Does innovation win over marketing?" is
    // the script wondering aloud; "innovation wins" is the script reporting. Only the
    // second is the defect, and without this the closing question of almost every
    // comparison script flags.
    if (sentence.endsWith('?')) continue;
    for (const { re, kind } of UNSOURCED_RESULT_PATTERNS) {
      re.lastIndex = 0;
      const hit = re.exec(sentence);
      if (!hit) continue;
      if (sourced(hit[0]) || sourced(sentence)) continue;
      const label = sentence.length > 70 ? `${sentence.slice(0, 67)}…` : sentence;
      if (seen.has(label)) continue;
      seen.add(label);
      found.push(`${kind}: "${label}"`);
      break;
    }
  }
  return found;
}

/**
 * A spoken opening line longer than the hook budget.
 *
 * Separate from flagCraftIssues, and deliberately not part of it, because
 * checkScriptQuality treats those issues as a HARD GATE on the story stage — and what
 * it gates is `storyProse(story)`, the approved beats joined together, which is not a
 * spoken opening line and has no reason to fit in six words. Blocking a stage on a
 * length preference would stall the automate flow on scripts that are merely less
 * punchy than ideal. This runs where the script is actually written, as a warning.
 */
export function flagHookLength(script: string): string[] {
  const sentences = (script.match(/[^.!?]+[.!?]*/g) ?? []).map((s) => s.trim()).filter(Boolean);
  // One sentence is a fragment, not a script with a hook.
  if (sentences.length < 2) return [];
  const first = sentences[0];
  const words = countWords(first);
  if (words <= HOOK_MAX_WORDS) return [];
  const shown = first.length > 60 ? `${first.slice(0, 57)}…` : first;
  return [`long opener (${words} words, ${(words / WORDS_PER_SECOND).toFixed(1)}s): "${shown}"`];
}

/** Figures about human suffering that no one has been asked to check. */
export function flagSensitiveClaims(script: string): string[] {
  const sentences = (script.match(/[^.!?]+[.!?]*/g) ?? []).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (const s of sentences) {
    if (CASUALTY_FIGURE.test(s) && !SOURCED.test(s)) {
      out.push(`unhedged casualty figure — needs a human fact-check: "${s.length > 70 ? `${s.slice(0, 67)}…` : s}"`);
    }
  }
  return out;
}

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
    const stack = adjectiveStack(s);
    if (stack) issues.push(`stacked adjectives (${stack}): "${short(s)}"`);
  }
  issues.push(...extendedMetaphor(script, topic));

  for (const s of sentences) {
    const hit = GUARANTEE.exec(s);
    if (hit && !HEDGE.test(s)) issues.push(`overclaim "${hit[0]}": "${short(s)}"`);
  }

  const last = sentences[sentences.length - 1];
  // The structural half of the close rule. The on-topic check below already passed on
  // all four real scripts — they were on-topic AND interchangeable — because sharing a
  // word with the topic is a low bar. A question at both ends is the template itself.
  if (sentences.length > 1 && first.endsWith('?') && last.endsWith('?')) {
    issues.push(`question bookend: opens "${short(first)}" and closes "${short(last)}"`);
  }
  if (last.endsWith('?') && GENERIC_CLOSE_SHAPE.test(last)) {
    issues.push(`formulaic close: "${short(last)}"`);
  }
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
