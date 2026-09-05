import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  buildScriptSections,
  buildScriptPrompt,
  flagUnverifiedClaims,
  flagCraftIssues,
  type ScriptBrief,
} from '../src/pipeline/agents/scriptPrompt.js';
import { normalizePlan, PLAN_FIELDS } from '../src/pipeline/agents/directorAgent.js';
import { buildKnowledgeContext } from '../src/content-studio/knowledgeContext.js';
import { targetWordCount } from '../src/utils/targetLength.js';

// The Script Agent's prompt is built, not written, so the four sections are
// assertable without an API key. That is the whole reason buildScriptSections is
// a pure function: "does a universe actually change the prompt" should be a test
// and not an opinion formed by reading generated output.

const generic: ScriptBrief = {
  topic: 'Playwright AI agents',
  targetSeconds: 60,
  hookStrategy: 'question',
  mode: 'shorts',
};

const doc = (over: Partial<any>): any => ({
  id: 'd1', userId: 'u1', title: 'Brand Bible', category: 'brand_bible',
  content: 'The series is dry, technical and never condescending. Episodes end on a question.',
  tags: [], relatedDocumentIds: [], version: 1,
  createdAt: '2026-01-01', updatedAt: '2026-01-01', ...over,
});

/** A universe-rich brief. The names are fixtures — the template never sees them in code. */
const withUniverse = (over: Partial<ScriptBrief> = {}): ScriptBrief => ({
  ...generic,
  brand: {
    name: 'Northwind Ops',
    world: 'A support desk inside a datacentre that never sleeps.',
    toneRules: 'Deadpan. Never explain the joke.',
    episodeStructure: 'Cold open, escalation, punchline, wordless reaction.',
  },
  cast: [
    { name: 'RAVI', role: 'SRE', personality: 'exhausted, precise', voiceStyle: 'clipped' },
    { name: 'MAYA', role: 'QA lead', personality: 'relentlessly cheerful', voiceStyle: 'warm' },
  ],
  knowledge: buildKnowledgeContext([doc({ universe: 'northwind-ops' })], ['brand_bible'], 'northwind-ops'),
  ...over,
});

describe('script prompt — universe present vs absent', () => {
  it('writes a different ROLE for a series than for a one-off', () => {
    const bare = buildScriptSections(generic).role;
    const rich = buildScriptSections(withUniverse()).role;

    expect(bare).toContain('experienced content writer');
    expect(bare).toContain('no established series voice');
    expect(bare).not.toContain('Northwind');

    // Not a relabel: the series role names the series, declares dialogue mode,
    // and subordinates the model's instincts to the knowledge base.
    expect(rich).toContain('Northwind Ops');
    expect(rich).toContain('spoken dialogue');
    expect(rich).toContain('knowledge base');
    expect(rich).not.toContain('experienced content writer');
  });

  it('adds cast, world, knowledge and locked-format constraints only when they exist', () => {
    const bare = buildScriptPrompt(generic);
    const rich = buildScriptPrompt(withUniverse());

    for (const block of ['## WORLD', '## CAST', 'KNOWLEDGE BASE']) {
      expect(bare).not.toContain(block);
      expect(rich).toContain(block);
    }
    expect(rich).toContain('RAVI');
    expect(rich).toContain('never condescending'); // pulled through buildKnowledgeContext

    const bareC = buildScriptSections(generic).constraints.join('\n');
    const richC = buildScriptSections(withUniverse()).constraints.join('\n');
    expect(bareC).not.toMatch(/Tone is locked|structure is locked/);
    expect(richC).toContain('Deadpan');
    expect(richC).toContain('Cold open');
  });

  it('gives the cast its dialogue instructions, and withholds them otherwise', () => {
    const bare = buildScriptSections(generic).instructions.join('\n');
    const rich = buildScriptSections(withUniverse()).instructions.join('\n');
    expect(rich).toContain('"NAME: line"');
    expect(bare).not.toContain('"NAME: line"');
  });

  it('drops back to the generic role when a knowledge base exists but is empty', () => {
    // The supported "no KB yet" state — buildKnowledgeContext returns '' and the
    // prompt must still be a complete brief, not a shell with a missing section.
    const brief = { ...generic, knowledge: buildKnowledgeContext([], ['brand_bible'], 'nobody') };
    const s = buildScriptSections(brief);
    expect(s.role).toContain('experienced content writer');
    expect(buildScriptPrompt(brief)).not.toContain('KNOWLEDGE BASE');
    expect(s.constraints.length).toBeGreaterThan(5);
  });
});

describe('script prompt — target duration drives the brief', () => {
  // Found by content, not by position: the constraint list is ordered by importance and
  // gains entries (the language rule went in at the front), so an index is not a stable
  // way to name one.
  const constraint = (secs: number, match: RegExp) =>
    buildScriptSections({ ...generic, targetSeconds: secs }).constraints.find((c) => match.test(c))!;
  const budget = (secs: number) => constraint(secs, /Total spoken words/);

  it('asks for a word count proportional to the target, not a fixed one', () => {
    const thirty = budget(30);
    const sixty = budget(60);
    expect(thirty).not.toBe(sixty);
    // 30s -> 75 words, 60s -> 150, each with a +/-15% band.
    expect(thirty).toContain('64');
    expect(thirty).toContain('86');
    expect(sixty).toContain('128');
    expect(sixty).toContain('173');
  });

  it('states the runtime, word count and scene count in the OBJECTIVE for any custom value', () => {
    const o = buildScriptSections({ ...generic, targetSeconds: 42 }).objective;
    expect(o).toContain('42 seconds');
    expect(o).toContain(`${targetWordCount(42)} words`);
    expect(o).toMatch(/\d+-\d+ scenes/);
  });

  it('derives the per-scene floor from the budget instead of a fixed 20 words', () => {
    // The old prompt demanded 20+ words per scene at every target. At 30s/75
    // words that alone overshoots, which is how a 35s script became a 56s video.
    const perScene = (secs: number) => {
      const m = /under (\d+) words/.exec(constraint(secs, /under \d+ words/));
      return Number(m![1]);
    };
    expect(perScene(30)).toBeLessThan(perScene(180));
    expect(perScene(30) * 5).toBeLessThanOrEqual(targetWordCount(30));
  });
});

describe('script prompt — constraints', () => {
  it('bans invented figures, multi-topic drift and generic preamble in every brief', () => {
    for (const brief of [generic, withUniverse()]) {
      const c = buildScriptSections(brief).constraints.join('\n');
      expect(c).toMatch(/No statistics, percentages/);
      expect(c).toContain('One core concept');
      expect(c).toMatch(/No generic pain-point preamble/);
    }
  });

  it('forbids reordering beats only when beats were supplied', () => {
    const withBeats = buildScriptSections({ ...generic, spine: { Hook: 'Your tests write themselves now.' } });
    expect(withBeats.constraints.join('\n')).toContain('already approved');
    expect(buildScriptSections(generic).constraints.join('\n')).not.toContain('already approved');
    expect(buildScriptPrompt({ ...generic, spine: { Hook: 'x' } })).toContain('## STORY BEATS');
  });

  it('never hardcodes a brand, channel or character name in the template source', () => {
    // The DO-NOT, as a test: all specificity has to arrive as data. Anything
    // added here in future that names a real channel fails the build.
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/pipeline/agents/scriptPrompt.ts'), 'utf8');
    for (const name of ['AIQA', 'Universe of NULL', 'Nexus City', 'VEER', 'NOVA', 'BYTE']) {
      expect(src).not.toContain(name);
    }
  });
});

describe('script prompt — the weaknesses human review kept catching', () => {
  // Three recurring findings on real generated scripts: a bare dramatic opener, a
  // guaranteed-outcome claim where the tool only attempts one, and a closing question
  // that could sit on any video. Each is a constraint now, and each must apply to
  // every brief — they are craft rules, not series rules.
  const both = [generic, withUniverse()];

  it('bans guaranteed-outcome wording where the material only supports a capability', () => {
    for (const brief of both) {
      const c = buildScriptSections(brief).constraints.join('\n');
      expect(c).toMatch(/guaranteed outcome/i);
      expect(c).toMatch(/attempts to/);
      // The distinction has to be stated as two kinds of word, not as one example.
      expect(c).toMatch(/fixes, solves, eliminates/);
    }
  });

  it('bans the generic dramatic opener without asking for a weak one', () => {
    for (const brief of both) {
      const s = buildScriptSections(brief);
      const c = s.constraints.join('\n');
      expect(c).toMatch(/No generic dramatic opener/);
      expect(c).toContain('Shocking');
      // The overcorrection guard: still explicitly told to open hard.
      expect(c).toMatch(/Open hard/);
      expect(s.instructions.join('\n')).toMatch(/Lead with the tension/);
    }
  });

  it('requires the closing question to be about this script specifically', () => {
    for (const brief of both) {
      const i = buildScriptSections(brief).instructions.join('\n');
      expect(i).toMatch(/closing question has to be about the specific thing/);
      expect(i).toMatch(/would sit equally well on any video is not a close/);
    }
  });

  it('carries the retention principles into every brief', () => {
    for (const brief of both) {
      const i = buildScriptSections(brief).instructions.join('\n');
      expect(i).toMatch(/Front-load the payload/);       // value before setup
      expect(i).toMatch(/Pay off the opening/);           // no bait-and-switch
      expect(i).toMatch(/Vary sentence length/);          // spoken rhythm
      expect(i).toMatch(/would not be missed/);           // information density
    }
  });

  it('says plainly that these are craft rules, not a reach lever', () => {
    // The claim this file is not allowed to make, asserted so it cannot creep in.
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/pipeline/agents/scriptPrompt.ts'), 'utf8');
    expect(src).toMatch(/correlated\* with retention/);
    expect(src).toMatch(/not a lever on reach/);
  });
});

describe('flagCraftIssues', () => {
  it('catches a bare dramatic opener but not a specific hard one', () => {
    expect(flagCraftIssues('Shocking. Your software tests are failing.')[0])
      .toMatch(/^generic opener/);
    expect(flagCraftIssues("You won't believe what this does.")[0]).toMatch(/^generic opener/);
    // The reviewer's own preferred opening: strong, specific, must stay clean.
    expect(flagCraftIssues('Your software tests are failing. Again. What if they could fix themselves?'))
      .not.toContainEqual(expect.stringMatching(/generic opener/));
  });

  it('catches a guarantee, and stays quiet on the hedged version of the same claim', () => {
    expect(flagCraftIssues('Playwright fixes your existing broken tests.')[0])
      .toMatch(/^overclaim "fixes your"/);
    expect(flagCraftIssues('The healer attempts a repair and proposes the fix for review.'))
      .toEqual([]);
    // Not tuned to one topic or one verb.
    expect(flagCraftIssues('This framework eliminates deployment downtime.')[0])
      .toMatch(/^overclaim "eliminates"/);
    // "fixes" as a noun names the problem; it claims nothing.
    expect(flagCraftIssues('Broken selectors mean endless manual fixes after every release.'))
      .toEqual([]);
  });

  it('catches a closing question that shares no vocabulary with the video', () => {
    const script = 'Playwright ships three agents. The planner drafts, the generator writes, the healer '
      + 'looks at what broke. What groundbreaking features will you ship next?';
    expect(flagCraftIssues(script, 'Playwright AI agents')[0]).toMatch(/^off-topic close/);

    const onTopic = script.replace(
      'What groundbreaking features will you ship next?', 'Would you let the healer touch your tests?');
    expect(flagCraftIssues(onTopic, 'Playwright AI agents')).toEqual([]);
  });

  it('stays quiet on a clean script and on one with no closing question', () => {
    expect(flagCraftIssues('The agent reads the page, then decides what to click.', 'browser agents'))
      .toEqual([]);
    expect(flagCraftIssues('')).toEqual([]);
  });
});

describe('flagUnverifiedClaims', () => {
  it('catches the shapes of claim a script was told not to invent', () => {
    expect(flagUnverifiedClaims('It cuts flake rates by 40%.')).toContain('40%');
    expect(flagUnverifiedClaims('It runs 3x faster than before.')).toContain('3x faster');
    expect(flagUnverifiedClaims('According to Gartner, teams ship weekly.')[0])
      .toMatch(/^According to Gartner/);
    expect(flagUnverifiedClaims('A recent study found the opposite.')[0]).toMatch(/recent study/);
  });

  it('stays quiet on a script that makes no numeric claim', () => {
    expect(flagUnverifiedClaims('The agent reads the page, then decides what to click.')).toEqual([]);
  });

  it('does not flag a figure that came from the source material', () => {
    // Warn-only and source-aware: a stat quoted from the brief is sourced.
    expect(flagUnverifiedClaims('Coverage sat at 40%.', 'The bible states coverage sat at 40%.')).toEqual([]);
  });
});

describe('flagCraftIssues — matching real generated closes', () => {
  it('accepts a close that reuses the script\'s vocabulary in another number', () => {
    // Real output: the script talks about "resource pressure", the close asks about
    // "resources". Same subject, different inflection — not an off-topic close.
    const script = 'Kubernetes evicts under resource pressure. The kubelet watches memory. '
      + 'Are your essential services protected when resources run thin?';
    expect(flagCraftIssues(script, 'Why Kubernetes evicts your pod at 3am')).toEqual([]);
  });
});

describe('flagCraftIssues — the control script the old prompt produced', () => {
  it('flags the self-repair guarantee the pre-change prompt reached for', () => {
    // Verbatim first line of a control generation on the prompt as it was.
    expect(flagCraftIssues('Ever wish your complex web tests could practically fix themselves?')[0])
      .toMatch(/^overclaim "fix themselves"/);
  });
});

describe('director plan — the shapes the model actually returns', () => {
  // Captured from eight consecutive real DirectorAgent runs on one project. The
  // model answered `color_palette` as a list every single time (6 arrays, 2 objects),
  // and once each returned `pacing_notes` and `narrative_arc` as structures. The old
  // code returned `parsed as DirectorPlan` and handed those straight to `.trim()`.
  const fallback = {
    visual_style: 'Cinematic, high quality, 4k resolution',
    color_palette: 'Vibrant and contrasting colors',
    camera_language: 'Smooth pans and stable shots',
    pacing_notes: 'Moderate pacing, give time to read',
    overall_mood: 'Engaging and informative',
    narrative_arc: 'Hook the viewer, explain the concept, end with a call to action.',
  };

  it('flattens a palette answered as an array of hex codes', () => {
    const plan = normalizePlan({ color_palette: ['#FFD700', '#007FFF', '#FF4500', '#DC143C'] }, fallback);
    expect(plan.color_palette).toBe('#FFD700, #007FFF, #FF4500, #DC143C');
  });

  it('flattens a palette answered as a named object, keeping the names', () => {
    const plan = normalizePlan({
      color_palette: { warm_office_light: '#F8E7D1', monitor_blue_glow: '#87CEEB', emergency_red_alert: '#FF3333' },
    }, fallback);
    expect(plan.color_palette).toBe('warm office light: #F8E7D1; monitor blue glow: #87CEEB; emergency red alert: #FF3333');
  });

  it('flattens per-beat pacing notes, which is what the prompt asks for', () => {
    const plan = normalizePlan({
      pacing_notes: { 'hook_0-3s': 'Steady, medium-paced shot.', 'conflict_3-8s': 'Pacing accelerates with rapid cuts.' },
    }, fallback);
    expect(plan.pacing_notes).toBe('hook 0-3s: Steady, medium-paced shot.; conflict 3-8s: Pacing accelerates with rapid cuts.');
  });

  it('flattens a narrative arc answered as a list of beat objects', () => {
    const plan = normalizePlan({
      narrative_arc: [{ beat_description: 'A bright office.', scene_type_variety: 'Real world -> Character' }],
    }, fallback);
    expect(plan.narrative_arc).toContain('beat description: A bright office.');
    expect(typeof plan.narrative_arc).toBe('string');
  });

  it('gives every field back as a string, whatever it was handed', () => {
    // Including the shapes nobody has seen yet: a number, a null, a missing key, and
    // a response that is not an object at all.
    for (const parsed of [
      { visual_style: 42, color_palette: null, camera_language: [], pacing_notes: {}, overall_mood: true },
      'not json at all', null, [], undefined,
    ]) {
      const plan = normalizePlan(parsed, fallback);
      for (const field of PLAN_FIELDS) expect(typeof plan[field]).toBe('string');
    }
  });

  it('borrows the fallback per field, not all or nothing', () => {
    const plan = normalizePlan({ overall_mood: 'Wry and tense' }, fallback);
    expect(plan.overall_mood).toBe('Wry and tense');
    expect(plan.visual_style).toBe(fallback.visual_style);
  });

  it('survives the trip the crashing plan took, all the way into the prompt', () => {
    // This is the exact path that threw "(v ?? '').trim is not a function": the plan
    // goes into ScriptBrief.direction, and buildScriptSections calls clean() on it.
    const plan = normalizePlan({
      pacing_notes: { 'hook_0-3s': 'Steady shot.' },
      narrative_arc: [{ beat_description: 'A bright office.' }],
      overall_mood: 'Wry and tense',
    }, fallback);
    const brief: ScriptBrief = {
      ...generic,
      direction: { mood: plan.overall_mood, narrativeArc: plan.narrative_arc, pacing: plan.pacing_notes },
    };
    const objective = buildScriptSections(brief).objective;
    expect(objective).toContain('Wry and tense');
    expect(objective).toContain('hook 0-3s: Steady shot.');
    expect(objective).not.toContain('[object Object]');
  });

  it('still throws if a raw plan is ever handed straight to the prompt again', () => {
    // The guard is the boundary, not clean(). If someone reintroduces a bare cast,
    // this is the failure they will see — pinned so it stays a loud one.
    const raw = { direction: { mood: { vibe: 'wry' } } } as any;
    expect(() => buildScriptSections({ ...generic, ...raw })).toThrow(/trim is not a function/);
  });
});
