import { describe, it, expect } from 'vitest';
import {
  buildScriptSections, flagCraftIssues, flagSensitiveClaims, flagHookLength, adjectiveStack,
  flagUnverifiedClaims, extendedMetaphor,
  isSensitiveSubject, HOOK_MAX_WORDS, hookMaxSeconds,
} from '../src/pipeline/agents/scriptPrompt.js';
import { WORDS_PER_SECOND } from '../src/utils/targetLength.js';

/**
 * Three craft constraints and one editorial one, each added because four real scripts
 * shipped with the same defect and the existing constraints passed all four.
 *
 * The scripts below are quoted verbatim from those renders. They are the regression
 * cases: a change that stops flagging them has undone the reason this file exists.
 */

const SELENIUM = 'That web automation tool you rely on? It might actually be hindering your progress. '
  + 'Modern web applications are dynamic, intricate, constantly evolving. The traditional automation landscape simply cannot keep pace. '
  + 'It often cuts boilerplate code by up to 50% for modern web apps. Think of Selenium as a robust, customizable classic car. '
  + 'Playwright, conversely, is a sleek electric vehicle. Considering your project’s specific needs, where do you start? '
  + 'Which automation journey aligns with your true finish line?';

const RAG = 'Why do powerful AI models sometimes invent facts or give outdated answers? '
  + 'First, it retrieves only the most relevant, up-to-date facts from your knowledge base. '
  + 'Then, it augments the language model’s answer, grounding it in truth. '
  + 'RAG transforms AI from a source of confusion into a beacon of clarity.';

const INDEPENDENCE = 'Did you know India’s first independence day wasn’t entirely a celebration of unbridled joy? '
  + 'Amidst freedom’s jubilation, over 15 million people were displaced, and violence erupted. '
  + 'What profound lessons does this complex, powerful birth hold for India’s continuous journey forward?';

const brief = (over: any = {}) => ({ topic: 'Playwright', targetSeconds: 40, ...over });
const constraintsFor = (over: any = {}) => buildScriptSections(brief(over)).constraints.join('\n');

describe('the hook budget is derived, not invented', () => {
  it('states the same seconds the shared speech rate implies', () => {
    expect(hookMaxSeconds()).toBe(Number((HOOK_MAX_WORDS / WORDS_PER_SECOND).toFixed(1)));
    // Six words at 2.5 words/second. If either constant moves, this moves with it.
    expect(constraintsFor()).toContain(`at most ${HOOK_MAX_WORDS} words`);
    expect(constraintsFor()).toContain(`${hookMaxSeconds()} seconds spoken`);
  });

  it('flags an opener longer than the budget, with its measured duration', () => {
    const issues = flagHookLength('Why do powerful AI models sometimes invent facts or give outdated answers? It happens.');
    expect(issues.some((i) => /long opener \(12 words, 4\.8s\)/.test(i))).toBe(true);
  });

  it('leaves a short opener alone', () => {
    expect(flagHookLength('AI models invent facts. Here is why that happens.')).toEqual([]);
    // A fragment has no hook to be too long for.
    expect(flagHookLength('One very long single sentence that goes on and on forever.')).toEqual([]);
  });

  it('does not replace the existing generic-opener rule, which still fires', () => {
    // Both constraints are present and both detectors run: short AND specific.
    const c = constraintsFor();
    expect(c).toContain('No generic dramatic opener');
    expect(c).toMatch(/at most 6 words/);
    const issues = flagCraftIssues('Shocking. Your tests are broken and nobody noticed at all.', 'tests');
    expect(issues.some((i) => i.startsWith('generic opener'))).toBe(true);
  });
});

describe('stacked adjectives standing in for a fact', () => {
  it('catches the real one', () => {
    expect(adjectiveStack('Modern web applications are dynamic, intricate, constantly evolving.'))
      .toBe('intricate, constantly evolving');
    expect(flagCraftIssues(SELENIUM, 'Playwright').some((i) => i.startsWith('stacked adjectives'))).toBe(true);
  });

  it('leaves a real list of substance alone', () => {
    // From the RAG script. Three comma-separated parts, but they carry content — this
    // is the false positive the connective exclusion and the length test exist for.
    expect(adjectiveStack('First, it retrieves only the most relevant, up-to-date facts from your knowledge base.')).toBe('');
    expect(flagCraftIssues(RAG, 'RAG').join()).not.toMatch(/stacked adjectives/);
  });

  it('is not fooled by a parenthetical connective', () => {
    // "Playwright, conversely, is a sleek electric vehicle" is a bad sentence, but not
    // for a reason that has anything to do with the word "conversely".
    expect(adjectiveStack('Playwright, conversely, is a sleek electric vehicle.')).toBe('');
  });

  it('is not fooled by an appositive definition', () => {
    // Found on the first regeneration run against the new prompt. "X, or Y, does Z" is
    // one of the most common ways to introduce a term, and it is not an adjective stack.
    expect(adjectiveStack('Retrieval-Augmented Generation, or RAG, solves this key problem.')).toBe('');
    expect(adjectiveStack('Playwright, or PW, ships its own browser.')).toBe('');
  });

  it('still catches a stack that opens a sentence', () => {
    expect(adjectiveStack('Dynamic, intricate, constantly evolving.')).toBe('intricate, constantly evolving');
  });

  it('needs two modifiers, not one', () => {
    expect(adjectiveStack('The build is fast, and the tests pass every time.')).toBe('');
  });

  it('asks for the fact the adjectives replaced', () => {
    const c = constraintsFor();
    expect(c).toMatch(/stacked adjectives/i);
    expect(c).toMatch(/dynamic, intricate, constantly evolving/);
    expect(c).toMatch(/If you cannot say what the comparison teaches, delete it/);
  });
});

describe('the question bookend', () => {
  it('flags a script that opens and closes on a question', () => {
    expect(flagCraftIssues(SELENIUM, 'Playwright').some((i) => i.startsWith('question bookend'))).toBe(true);
    expect(flagCraftIssues(INDEPENDENCE, 'India independence').some((i) => i.startsWith('question bookend'))).toBe(true);
  });

  it('does not flag a script that opens on a question and closes on a statement', () => {
    // The RAG script really does this, and it is the shape the constraint asks for.
    expect(flagCraftIssues(RAG, 'RAG').join()).not.toMatch(/question bookend/);
  });

  it('does not flag a one-sentence script against itself', () => {
    expect(flagCraftIssues('Is this thing on?', 'thing').join()).not.toMatch(/question bookend/);
  });

  it('flags the category-question shapes', () => {
    for (const close of [
      'So what does this mean for developers?',
      'Where do you start?',
      'What profound lessons does this hold?',
      'How do we uphold responsibility here?',
    ]) {
      expect(flagCraftIssues(`Playwright ships a browser. ${close}`, 'Playwright').some((i) => i.startsWith('formulaic close')))
        .toBe(true);
    }
  });

  it('leaves a specific closing question alone — the previously verified case', () => {
    // This close was accepted by human review and must stay accepted: the new rule
    // targets genericness, not questions.
    const script = 'Playwright can now heal your broken selectors automatically when a test fails. '
      + 'Would you trust AI to fix your tests?';
    const issues = flagCraftIssues(script, 'Playwright self-healing tests');
    expect(issues.join()).not.toMatch(/formulaic close|off-topic close|question bookend/);
  });

  it('keeps the existing off-topic-close rule working', () => {
    const issues = flagCraftIssues('Playwright ships its own browser build. What will you cook tonight?', 'Playwright');
    expect(issues.some((i) => i.startsWith('off-topic close'))).toBe(true);
  });
});

describe('serious subject matter', () => {
  it('recognises it from the topic or the material handed in', () => {
    expect(isSensitiveSubject('The Partition of India')).toBe(true);
    expect(isSensitiveSubject('The first day of Independent India')).toBe(false);
    // The euphemistic topic is caught by what came with it, which is the point of
    // matching the material and not the topic alone.
    expect(isSensitiveSubject('The first day of Independent India', 'millions of refugees crossed the new border')).toBe(true);
    expect(isSensitiveSubject('What is RAG?', 'retrieval augmented generation')).toBe(false);
  });

  it('adds a constraint that pushes toward hedging, never toward a number', () => {
    const c = constraintsFor({ topic: 'The Partition of India' });
    expect(c).toMatch(/real people who were killed, displaced or harmed/);
    expect(c).toMatch(/estimates differ/);
    expect(c).toMatch(/Never state a death toll as a flat fact/);
    // It must not license the figures the existing constraint forbids.
    expect(c).toMatch(/No statistics, percentages, benchmark figures/);
  });

  it('is absent for an ordinary technical topic', () => {
    expect(constraintsFor({ topic: 'What is RAG?' })).not.toMatch(/real people who were killed/);
  });

  it('flags an unhedged casualty figure for human fact-check', () => {
    const flags = flagSensitiveClaims(INDEPENDENCE);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatch(/needs a human fact-check/);
    expect(flags[0]).toMatch(/15 million people were displaced/);
  });

  it('leaves a hedged figure alone — that is what it is asking for', () => {
    expect(flagSensitiveClaims('Historians estimate that between ten and twenty million people were displaced.')).toEqual([]);
    expect(flagSensitiveClaims('Estimates of how many died vary widely and remain disputed.')).toEqual([]);
  });

  it('says nothing about a script with no casualty claim', () => {
    expect(flagSensitiveClaims(RAG)).toEqual([]);
    expect(flagSensitiveClaims(SELENIUM)).toEqual([]);
  });
});

describe('the new constraints compose with the old ones', () => {
  it('leaves every previously verified constraint in place', () => {
    const c = constraintsFor();
    for (const existing of [
      'No statistics, percentages, benchmark figures',
      'Do not claim anything about the subject you were not given',
      'No generic dramatic opener',
      'One core concept for the whole script',
      'No generic pain-point preamble',
      'Plain speakable prose only',
    ]) {
      expect(c).toContain(existing);
    }
  });

  it('still flags the unsourced figure in the real Selenium script', () => {
    // The percentage was always caught. It is warn-only, which is why it still shipped.
    expect(flagCraftIssues(SELENIUM, 'Playwright').length).toBeGreaterThan(0);
  });
});

/**
 * A second real script, reported after the constraints were written and found to walk
 * past two of them. Both gaps are fixed here; the script is the regression case.
 */
const AI_AGENTS = `What if AI agents hacking our systems was already happening? `
  + `Recent breakthroughs in AI autonomy allow advanced agents to learn and adapt. `
  + `But autonomous AI agents can discover new exploits two hundred times faster. `
  + `Imagine a sophisticated digital child navigating an infinite house. `
  + `It's not malicious, just ceaselessly exploring. `
  + `It finds every unlocked door, every hidden switch, every weak point. `
  + `This profound shift is already upon us.`;
const AI_TOPIC = 'AI agents are starting to act autonomously and hack real systems';

describe('a spoken multiplier is still a statistic', () => {
  it('catches the number spelled the way a narrator says it', () => {
    // The pattern knew "200x faster" and not "two hundred times faster", which is the
    // form a model writing for the ear reaches for.
    expect(flagUnverifiedClaims(AI_AGENTS, '')).toContain('two hundred times faster');
  });

  it('still catches the digit forms it always did', () => {
    expect(flagUnverifiedClaims('It runs 10x faster than before.', '')).toContain('10x faster');
    expect(flagUnverifiedClaims('Tests get 3 times slower with that plugin.', '')).toContain('3 times slower');
    expect(flagUnverifiedClaims('A 40% drop in flakes.', '')).toContain('40%');
  });

  it('leaves a number that is not a comparison alone', () => {
    // "three stages" is structure, not a claim. Flagging it would make the warning noise.
    expect(flagUnverifiedClaims('RAG has three stages you should know.', '')).toEqual([]);
    expect(flagUnverifiedClaims('It ships two browser builds.', '')).toEqual([]);
  });

  it('treats a figure quoted from the material as sourced', () => {
    expect(flagUnverifiedClaims(AI_AGENTS, 'benchmark: two hundred times faster on this corpus')).toEqual([]);
  });
});

describe('a metaphor that outstays the subject', () => {
  it('catches the new shape, which the adjective rule never could', () => {
    // Structurally nothing like "dynamic, intricate, constantly evolving" — no comma
    // stack at all — and equally decorative.
    expect(adjectiveStack('Imagine a sophisticated digital child navigating an infinite house.')).toBe('');
    const issues = extendedMetaphor(AI_AGENTS, AI_TOPIC);
    expect(issues).toHaveLength(1);
    // 4 in this abridged fixture: the closing line does not name the subject either.
    expect(issues[0]).toMatch(/\d+ sentences without naming the subject/);
    expect(issues[0]).toMatch(/digital child/);
  });

  it('generalises to the original car metaphor it was not built against', () => {
    const selenium = 'Think of Selenium as a robust, customizable classic car. '
      + 'It needs constant manual tuning to perform optimally. '
      + 'Playwright, conversely, is a sleek electric vehicle. '
      + 'Integrated and optimized for today’s high-speed demands. '
      + 'A different machine entirely.';
    expect(extendedMetaphor(selenium, 'Selenium vs Playwright: where to start?').length).toBeGreaterThan(0);
  });

  it('leaves an analogy that lands and returns to the subject alone', () => {
    // The RAG library analogy really does explain retrieval, and the script comes
    // straight back to RAG. No rule here is allowed to call that a defect.
    const rag = 'Enter RAG: Retrieval-Augmented Generation. '
      + 'It’s like giving an AI instant access to a vast, perfectly indexed library. '
      + 'First, RAG retrieves the most relevant facts from your knowledge base. '
      + 'Then it augments the answer, grounding it in truth.';
    expect(extendedMetaphor(rag, 'What is RAG (Retrieval-Augmented Generation)?')).toEqual([]);
  });

  it('says nothing about prose with no comparison in it', () => {
    const plain = 'Database indexes can slow some queries. They introduce a processing overhead. '
      + 'Every insert must also update the index.';
    expect(extendedMetaphor(plain, 'Why database indexes make some queries slower')).toEqual([]);
  });

  it('needs a topic to have something to be off', () => {
    expect(extendedMetaphor(AI_AGENTS, '')).toEqual([]);
  });
});
