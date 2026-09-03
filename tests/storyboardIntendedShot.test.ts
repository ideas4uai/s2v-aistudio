import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateText = vi.fn(async () => 'a prompt');
vi.mock('../src/services/aiService.js', () => ({ AIService: { generateText: (...args: any[]) => generateText(...args) } }));

const { StoryboardAgent } = await import('../src/pipeline/agents/storyboardAgent.js');

const plan = {} as any;
const universe = {
  artStyle: 'Premium Pixar-style 3D illustration',
  characters: [{ id: 'raj', name: 'Raj', appearance: 'black polo, no glasses', colorPalette: 'black' }],
} as any;

const promptsSent = () => generateText.mock.calls.map((call: any[]) => String(call[0]));

beforeEach(() => generateText.mockClear());

describe('StoryboardAgent prompt construction', () => {
  it("carries the scriptwriter's intended shot into the expansion prompt", async () => {
    // A wordless beat has no narration at all, so the intended shot is the only
    // description of what belongs on screen. Dropping it silently lost visual
    // punchlines — e.g. the Production Monster appearing.
    await StoryboardAgent.expandVisuals(
      { topic: 'T', settings: {} } as any,
      plan,
      [{ narration: '', visual: 'a red glitching Production Monster consumes the dashboard', order: 0 }],
    );

    expect(promptsSent()[0]).toContain('a red glitching Production Monster consumes the dashboard');
  });

  it("uses the universe's art style instead of a hardcoded photorealistic tail", async () => {
    await StoryboardAgent.expandVisuals(
      { topic: 'T', settings: {}, universe } as any,
      plan,
      [{ narration: 'RAJ: Production is down.', visual: 'Raj at a monitor', order: 0 }],
    );

    const prompt = promptsSent()[0];
    expect(prompt).toContain('Premium Pixar-style 3D illustration');
    expect(prompt).not.toContain('photorealistic');
    expect(prompt).toContain('black polo, no glasses');
  });

  it('falls back to photorealism when neither the universe nor the plan supplies a style', async () => {
    // `plan` is {} here — with a plan.visual_style set, that wins instead.
    await StoryboardAgent.expandVisuals({ topic: 'T', settings: {} } as any, plan, [{ narration: 'n', visual: 'v', order: 0 }]);
    expect(promptsSent()[0]).toContain('photorealistic');
  });

  it('lets the script fix the framing instead of the positional rotation', async () => {
    // Scene 10 of a real 11-scene episode asked for a "Face-cam reaction". Index 9
    // lands on 'over-shoulder shot' in the rotation, and that is what the prompt was
    // told — so the shot came back as the back of a head. On that episode the rotation
    // set the opening words of all 11 prompts.
    const drafts = Array.from({ length: 10 }, (_, order) => ({ narration: `n${order}`, visual: 'v', order }));
    drafts[9] = { narration: 'So... what is left for the QA engineer?', visual: 'Face-cam reaction', order: 9 };

    await StoryboardAgent.expandVisuals({ topic: 'T', settings: {} } as any, plan, drafts);

    const tenth = promptsSent()[9];
    expect(tenth).toContain('SHOT TYPE FOR THIS SCENE: Face-cam');
    expect(tenth).not.toContain('SHOT TYPE FOR THIS SCENE: over-shoulder shot');
  });

  it('still rotates the shot type when the script names no framing', async () => {
    // The rotation is the fallback, not dead code: a beat that says nothing about
    // framing should still vary shot to shot rather than repeat one setup.
    const drafts = Array.from({ length: 3 }, (_, order) => ({ narration: 'n', visual: 'a server room', order }));
    await StoryboardAgent.expandVisuals({ topic: 'T', settings: {} } as any, plan, drafts);

    const sent = promptsSent();
    expect(sent[0]).toContain('SHOT TYPE FOR THIS SCENE: wide shot');
    expect(sent[1]).toContain('SHOT TYPE FOR THIS SCENE: medium shot');
    expect(sent[2]).toContain('SHOT TYPE FOR THIS SCENE: close-up');
  });

  it('tells the model to keep the beat physical and keep the people in it', async () => {
    // The failure these two rules answer: an "error screen" beat came back as an empty
    // red room, and a "you at laptop" beat came back as a robot arm with no human.
    await StoryboardAgent.expandVisuals(
      { topic: 'T', settings: {} } as any, plan,
      [{ narration: 'And then it found a bug.', visual: 'Red failure / error screen', order: 0 }],
    );
    const prompt = promptsSent()[0];
    expect(prompt).toMatch(/An empty red room is not a bug being found/);
    expect(prompt).toMatch(/a robot arm is not a stand-in for the human/);
  });

  it('attributes the speaker of a dialogue line to the universe character', async () => {
    const scenes = await StoryboardAgent.expandVisuals(
      { topic: 'T', settings: {}, projectType: 'story_episode', universe } as any,
      plan,
      [{ narration: 'RAJ: Production is down.', visual: 'Raj at a monitor', order: 0 }],
    );
    expect((scenes[0] as any).character).toBe('RAJ');
  });
});
