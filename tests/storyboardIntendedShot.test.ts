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

  it('attributes the speaker of a dialogue line to the universe character', async () => {
    const scenes = await StoryboardAgent.expandVisuals(
      { topic: 'T', settings: {}, projectType: 'story_episode', universe } as any,
      plan,
      [{ narration: 'RAJ: Production is down.', visual: 'Raj at a monitor', order: 0 }],
    );
    expect((scenes[0] as any).character).toBe('RAJ');
  });
});
