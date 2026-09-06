import { describe, it, expect } from 'vitest';
import {
  flagUnsourcedResults, isComparisonTopic, briefSourceMaterial,
  flagUnverifiedClaims, buildScriptSections, type ScriptBrief,
} from '../src/pipeline/agents/scriptPrompt.js';

/**
 * Narrated false confidence: a test result reported in prose that nobody measured.
 *
 * Every line below is verbatim from a real shipped script — topic "Pixel 11 Pro vs
 * iPhone 17 Pro vs Samsung S26 Ultra - SPEED TEST", generated with no benchmark, review
 * or source of any kind supplied. It reads as a review. It is a review of nothing.
 *
 * It passed every detector the pipeline had, because it cites no figures at all:
 * flagUnverifiedClaims returns [] on it. That is the whole reason this file exists — the
 * defect is structurally different from an invented number, and worse in one specific
 * way. A fabricated statistic invites checking; "fluid 4K rendering on one, jerky
 * buffering on another" does not.
 */

const REAL_SCRIPT = 'The most expensive phone just lost. Pixel 11 Pro, iPhone 17 Pro, Samsung S26 Ultra. '
  + 'New processors reset the hierarchy. Anticipation builds, then doubt creeps in. '
  + "It's not just about raw specs on paper. One line surges ahead, another lags, but the Electric Cyan holds. "
  + 'Shockingly, the iPhone 17 Pro opened apps slower, showing a crucial delay in multitasking. '
  + 'The winning phone beckons. A slight smirk. This isn\'t just about raw chip power. '
  + 'It\'s about superior optimization. Efficiency reigns. Some cores fire seamlessly; others grapple with friction. '
  + 'Fluid 4K rendering on one, jerky buffering on another. The performance gap is undeniable. '
  + 'A confident tap seals the verdict. Does this shock prove innovation wins over marketing budgets? '
  + 'Or is there a hidden cost to this victory?';

const TOPIC = 'Pixel 11 Pro vs iPhone 17 Pro vs Samsung S26 Ultra - SPEED TEST';

describe('the gap this detector fills', () => {
  it('is invisible to the numeric detector', () => {
    // Not a percentage, not a multiplier, not "according to", not "a recent study".
    // The script cites nothing, which is exactly how it got through.
    expect(flagUnverifiedClaims(REAL_SCRIPT, TOPIC)).toEqual([]);
  });

  it('catches every unearned result in the real script', () => {
    const flags = flagUnsourcedResults(REAL_SCRIPT, '');
    const joined = flags.join(' | ');
    expect(joined).toContain('The most expensive phone just lost');
    expect(joined).toContain('the iPhone 17 Pro opened apps slower');
    expect(joined).toContain('Fluid 4K rendering on one, jerky buffering on another');
    expect(joined).toContain('Some cores fire seamlessly; others grapple with friction');
    expect(joined).toContain('One line surges ahead, another lags');
    expect(joined).toContain('The performance gap is undeniable');
  });

  it('names what kind of claim each one is', () => {
    const flags = flagUnsourcedResults(REAL_SCRIPT, '');
    expect(flags.some((f) => f.startsWith('verdict:'))).toBe(true);
    expect(flags.some((f) => f.startsWith('measured outcome:'))).toBe(true);
    expect(flags.some((f) => f.startsWith('split result:'))).toBe(true);
  });
});

describe('it must not neuter legitimate comparison content', () => {
  it('says nothing when the results were actually supplied', () => {
    // The same sentences, with the reviewer's own data behind them. A script quoting
    // real measurements is doing its job.
    const supplied = 'Reviewer bench notes: the most expensive phone just lost. '
      + 'The iPhone 17 Pro opened apps slower, showing a crucial delay in multitasking. '
      + 'Fluid 4K rendering on one, jerky buffering on another. '
      + 'Some cores fire seamlessly; others grapple with friction. '
      + 'One line surges ahead, another lags. The performance gap is undeniable.';
    expect(flagUnsourcedResults(REAL_SCRIPT, supplied)).toEqual([]);
  });

  it('does not read an empty source as permission', () => {
    // ''.includes(x) is false, but a naive containment check against an empty haystack
    // is one refactor away from clearing everything.
    expect(flagUnsourcedResults(REAL_SCRIPT, '').length).toBeGreaterThan(0);
  });

  it('leaves ordinary scripts alone', () => {
    // Four real scripts already used as fixtures elsewhere in the suite.
    const clean = [
      'That web automation tool you rely on? Modern web applications are dynamic, intricate, constantly evolving. Think of Selenium as a robust, customizable classic car.',
      'First, it retrieves only the most relevant, up-to-date facts from your knowledge base. Then, it augments the answer, grounding it in truth.',
      'A leaf is a factory running on light. Sunlight splits water inside the leaf and releases oxygen. So next time you water a plant, remember it eats light.',
      'AI models invent facts. Retrieval pulls the real document before the model answers.',
    ];
    for (const script of clean) expect(flagUnsourcedResults(script, '')).toEqual([]);
  });

  it('treats a question as wondering, not as reporting', () => {
    // "Does innovation win over marketing?" is the script asking. "Innovation wins" is
    // the script claiming. Without this the closing line of most comparisons flags.
    expect(flagUnsourcedResults('Does this prove innovation wins over marketing budgets?', '')).toEqual([]);
    expect(flagUnsourcedResults('Innovation wins over marketing budgets.', '')).not.toEqual([]);
  });
});

describe('the generative instruction', () => {
  const brief = (over: Partial<ScriptBrief> = {}): ScriptBrief => ({
    topic: TOPIC, targetSeconds: 60, mode: 'shorts', ...over,
  });

  it('recognises the comparison formats that trigger it', () => {
    for (const t of ['A vs B', 'iPhone versus Pixel', 'Pixel compared to Samsung', 'Phone showdown', 'S26 speed test', 'Which is better']) {
      expect(isComparisonTopic(t), t).toBe(true);
    }
    for (const t of ['How photosynthesis works', 'Why your tests keep breaking', '']) {
      expect(isComparisonTopic(t), t).toBe(false);
    }
  });

  it('tells the writer what to do INSTEAD, not only what to avoid', () => {
    // A model given a comparison format and no content narrates tension instead of
    // inventing a number. Prohibition alone leaves that hole open.
    const constraints = buildScriptSections(brief()).constraints.join('\n');
    expect(constraints).toContain('no benchmark, test, review or source');
    expect(constraints).toContain('what would have to be measured to settle it');
    expect(constraints).toContain('Name the trade-off, never the winner');
  });

  it('carries the hook-delivers-its-own-promise rule', () => {
    const constraints = buildScriptSections(brief()).constraints.join('\n');
    expect(constraints).toContain('first line makes a promise');
    expect(constraints).toContain('Decide the payoff first and write the hook last');
  });

  it('stays out of the way when the comparison has real material', () => {
    const withSource = buildScriptSections(brief({ knowledge: 'Bench data: sustained 3DMark loop, 20 min.' }));
    expect(withSource.constraints.join('\n')).not.toContain('no benchmark, test, review or source');
  });

  it('stays out of the way for non-comparison topics', () => {
    const other = buildScriptSections(brief({ topic: 'How photosynthesis feeds a plant' }));
    expect(other.constraints.join('\n')).not.toContain('Name the trade-off, never the winner');
  });

  it('counts knowledge and notes as source, but never the generated spine', () => {
    // The beats were produced upstream from the same empty start. Counting them would
    // let the pipeline cite itself.
    expect(briefSourceMaterial(brief({ knowledge: 'real doc' }))).toContain('real doc');
    expect(briefSourceMaterial(brief({ notes: ['caller note'] }))).toContain('caller note');
    expect(briefSourceMaterial(brief({ spine: { Hook: 'invented beat' } }))).toBe('');
  });
});
