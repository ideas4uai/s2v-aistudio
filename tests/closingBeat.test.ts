import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateText = vi.fn(async () => 'a prompt');
vi.mock('../src/services/aiService.js', () => ({ AIService: { generateText: (...args: any[]) => generateText(...args) } }));

const { StoryboardAgent } = await import('../src/pipeline/agents/storyboardAgent.js');

/**
 * The closing beat.
 *
 * Measured across four content types — education, software, AI explainer and kids —
 * every closing scene came back as filler regardless of topic. A CTA or conclusion names
 * no concrete thing, so the storyboard's "LITERAL representation of the narration" rule
 * has nothing to grip and the model falls back on atmosphere or a face against a blurred
 * background. That puts the weakest frame in the video on the beat where retention pays
 * out.
 *
 * Naming the failure was not enough on its own: told only what a closing shot IS, the
 * model produced a person with no object in frame and one A/B case came back worse. What
 * closed it was handing the closing prompt the earlier beats' own shots — the same
 * stage-cannot-see-the-previous-stage gap that runs through this pipeline.
 *
 * Measured after the fix: 0/3 grounded closing scenes before, 3/3 after.
 */

const plan = {} as any;
const project = { topic: 'Why your stack trace points at the wrong line', settings: {} } as any;
const promptsSent = () => generateText.mock.calls.map((call: any[]) => String(call[0]));

const DRAFTS = [
  { narration: 'Your stack trace is lying to you.', visual: 'a developer frowning at a red error log', order: 0 },
  { narration: 'It names where the error surfaced, not where it started.', visual: 'a finger tracing up a printed stack trace', order: 1 },
  { narration: 'Now you can pinpoint where the problem actually began.', visual: '', order: 2 },
];

beforeEach(() => generateText.mockClear());

describe('the closing beat is a distinct case', () => {
  it('hands the last scene the objects the earlier beats established', async () => {
    // The closing narration names nothing drawable. These are the only concrete nouns
    // available to it, and without them the model invents atmosphere.
    await StoryboardAgent.expandVisuals(project, plan, DRAFTS.map((d) => ({ ...d })));

    const closing = promptsSent()[2];
    expect(closing).toContain('CLOSING BEAT');
    expect(closing).toContain('WHAT THIS VIDEO HAS ALREADY SHOWN');
    expect(closing).toContain('a developer frowning at a red error log');
    expect(closing).toContain('a finger tracing up a printed stack trace');
  });

  it('names the bare reaction face as filler, not just atmosphere', async () => {
    // The first version of this rule banned sunrises and got a face against a blurred
    // background instead — same defect, different picture.
    await StoryboardAgent.expandVisuals(project, plan, DRAFTS.map((d) => ({ ...d })));

    const closing = promptsSent()[2];
    expect(closing).toContain('A face on its own is NOT a closing shot');
    expect(closing).toContain('sunrise');
    expect(closing).toMatch(/holding, touching or working with a specific object/);
  });

  it('leaves every other scene untouched', async () => {
    await StoryboardAgent.expandVisuals(project, plan, DRAFTS.map((d) => ({ ...d })));

    expect(promptsSent()[0]).not.toContain('CLOSING BEAT');
    expect(promptsSent()[1]).not.toContain('CLOSING BEAT');
  });

  it('says nothing about a closing beat when there is only one scene', async () => {
    // A single-scene project has no "earlier" to draw on, and the one scene is not a
    // conclusion to anything.
    await StoryboardAgent.expandVisuals(project, plan, [{ ...DRAFTS[0] }]);
    expect(promptsSent()[0]).not.toContain('CLOSING BEAT');
  });

  it('falls back to narration when an earlier beat named no shot', async () => {
    const drafts = [
      { narration: 'Your stack trace is lying to you.', visual: '', order: 0 },
      { narration: 'Now you can pinpoint where it began.', visual: '', order: 1 },
    ];
    await StoryboardAgent.expandVisuals(project, plan, drafts);
    expect(promptsSent()[1]).toContain('Your stack trace is lying to you.');
  });
});
