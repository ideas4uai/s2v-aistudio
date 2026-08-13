import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  buildScriptSections,
  buildScriptPrompt,
  flagUnverifiedClaims,
  type ScriptBrief,
} from '../src/pipeline/agents/scriptPrompt.js';
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
  const budget = (secs: number) => buildScriptSections({ ...generic, targetSeconds: secs }).constraints[0];

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
      const m = /under (\d+) words/.exec(buildScriptSections({ ...generic, targetSeconds: secs }).constraints[1]);
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
