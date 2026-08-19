import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { stripSpeakerPrefix, stripInternalLabel, hookStrategyBrief } from '../src/utils/narration.js';
import { buildScriptSections, type ScriptBrief } from '../src/pipeline/agents/scriptPrompt.js';

// Three leaks, two shapes of one bug: the pipeline hands the model its own
// metadata and hands the viewer the model's raw output, and neither boundary
// marked which strings were content.
//   - "RAVI: This staging" burned into a caption; "ARJUN: It's just a routine
//     refresh for" burned into an overlay.
//   - A project titled "CRAFT1 - Playwright can now heal your broken selectors"
//     produced the spoken line "CRAFT1 gives Playwright a vital healing touch".
//   - hookStrategy's slug produced the opening caption "Shocking. Your software"
//     on a video that shipped to YouTube.

describe('stripSpeakerPrefix — the output boundary', () => {
  it('removes the prefix that reached TTS, captions and overlays', () => {
    expect(stripSpeakerPrefix('RAVI: This staging environment data looks wrong.'))
      .toBe('This staging environment data looks wrong.');
    expect(stripSpeakerPrefix("ARJUN: It's just a routine refresh for a client."))
      .toBe("It's just a routine refresh for a client.");
  });

  it('handles every line of a multi-speaker scene', () => {
    expect(stripSpeakerPrefix('RAVI: Staging is down.\nPRIYA: Since when?'))
      .toBe('Staging is down.\nSince when?');
  });

  it('handles a name with a space or a full stop', () => {
    expect(stripSpeakerPrefix('DR RAO: The index is the problem.')).toBe('The index is the problem.');
    expect(stripSpeakerPrefix('MR. BYTE: Not quite.')).toBe('Not quite.');
  });

  it('leaves ordinary prose with a colon alone', () => {
    // The narrow rule matters: this is narration, not a prefix.
    const prose = 'One rule: never trust the cache.';
    expect(stripSpeakerPrefix(prose)).toBe(prose);
    const lower = 'remember: tests are code too.';
    expect(stripSpeakerPrefix(lower)).toBe(lower);
  });

  it('leaves a time and a ratio alone', () => {
    expect(stripSpeakerPrefix('At 3:30 the build failed.')).toBe('At 3:30 the build failed.');
  });

  it('is safe on empty and nullish input', () => {
    expect(stripSpeakerPrefix('')).toBe('');
    expect(stripSpeakerPrefix(null)).toBe('');
    expect(stripSpeakerPrefix(undefined)).toBe('');
  });
});

describe('stripInternalLabel — the input boundary', () => {
  it('drops the filing prefix that became a product name', () => {
    expect(stripInternalLabel('CRAFT1 - Playwright can now heal your broken selectors'))
      .toBe('Playwright can now heal your broken selectors');
    expect(stripInternalLabel('EP12: The staging refresh nobody announced'))
      .toBe('The staging refresh nobody announced');
    expect(stripInternalLabel('AUDIT-3 — Why your database index makes writes slower'))
      .toBe('Why your database index makes writes slower');
  });

  it('leaves a real title that happens to start with an acronym', () => {
    // Requiring a digit is what separates a naming convention from a subject.
    // Stripping these would be worse than leaving a label through.
    expect(stripInternalLabel('AI - the basics')).toBe('AI - the basics');
    expect(stripInternalLabel('SQL: a primer')).toBe('SQL: a primer');
    expect(stripInternalLabel('HTTP/2 explained')).toBe('HTTP/2 explained');
  });

  it('never strips a title down to nothing', () => {
    expect(stripInternalLabel('EP12 - ')).toBe('EP12 -');
    expect(stripInternalLabel('')).toBe('');
  });
});

describe('hookStrategyBrief — no slug reaches the model as a word', () => {
  it('never echoes the setting value back', () => {
    for (const slug of ['shocking', 'controversial', 'curiosity', 'storytelling']) {
      expect(hookStrategyBrief(slug).toLowerCase()).not.toContain(slug);
    }
  });

  it('says nothing at all for the default', () => {
    expect(hookStrategyBrief('default')).toBe('');
    expect(hookStrategyBrief('')).toBe('');
    expect(hookStrategyBrief(undefined)).toBe('');
  });

  it('still describes an unknown strategy without handing over the word to use', () => {
    expect(hookStrategyBrief('spicy')).toMatch(/without using that word/);
  });
});

describe('the prompt states the general rule, not just the three known cases', () => {
  const sections = buildScriptSections({
    topic: 'CRAFT1 - Playwright can now heal your broken selectors',
    targetSeconds: 45,
    hookStrategy: 'shocking',
  } as ScriptBrief);

  it('does not put the internal label in the objective', () => {
    expect(sections.objective).not.toContain('CRAFT1');
    expect(sections.objective).toContain('Playwright can now heal your broken selectors');
  });

  it('does not put the hook slug in the objective', () => {
    expect(sections.objective.toLowerCase()).not.toMatch(/hook of this kind: shocking/);
  });

  it('tells the model that metadata is filing, not material', () => {
    const all = sections.constraints.join('\n');
    expect(all).toMatch(/it is not material to quote/i);
    expect(all).toMatch(/never speak a label, a slug or an internal name/i);
  });
});

describe('the strip runs where all three consumers pass', () => {
  const orchestrator = fs.readFileSync(path.join(process.cwd(), 'src/pipeline/orchestrator.ts'), 'utf-8');

  it('sanitises inside processSingleScene, ahead of TTS, captions and overlays', () => {
    // Patching captionService alone would leave TTS and the overlay still
    // carrying the prefix — that is why this is not in any one consumer.
    const fnStart = orchestrator.indexOf('export async function processSingleScene');
    const call = orchestrator.indexOf('stripSpeakerPrefix(scene.narration_text)', fnStart);
    expect(call).toBeGreaterThan(fnStart);
    expect(call).toBeLessThan(orchestrator.indexOf('generateAudioHash(scene.narration_text'));
  });

  it('keeps caption_text in step with the narration it copies', () => {
    expect(orchestrator).toMatch(/caption_text\) \(scene as any\)\.caption_text = spoken/);
  });
});
