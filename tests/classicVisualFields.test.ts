import { describe, it, expect, vi, beforeEach } from 'vitest';

// Segmentation and visual expansion both go through AIService.generateText;
// the task tag is the only thing that tells them apart.
const generateText = vi.fn(async (_prompt: string, opts?: any) =>
  opts?.task === 'segmentation'
    ? JSON.stringify({ scenes: [{ narration: 'one', visual: 'v1', duration: 4 }, { narration: 'two', visual: 'v2', duration: 4 }] })
    : 'an expanded prompt');
vi.mock('../src/services/aiService.js', () => ({ AIService: { generateText: (...args: any[]) => generateText(...args) } }));

let loadedProject: any;
vi.mock('../src/pipeline/orchestrator.js', () => ({
  loadProject: async () => loadedProject,
  saveProjectState: async () => {},
  runPipeline: async () => {},
  runScenePipeline: async () => {},
}));

const { StoryboardAgent, pickMotion } = await import('../src/pipeline/agents/storyboardAgent.js');
const { generateScenes } = await import('../src/controllers/projectController.js');

const promptsSent = () => generateText.mock.calls.map((call: any[]) => String(call[0]));
const expand = (project: any, plan: any = {}, drafts: any[] = [{ narration: 'n', visual: 'v', order: 0 }]) =>
  StoryboardAgent.expandVisuals(project, plan, drafts);

beforeEach(() => generateText.mockClear());

describe('style tail', () => {
  it("uses the user's Visual Style pick from the plan when there is no universe", async () => {
    // plan.visual_style is set from project.settings.visualStyle by the
    // controller; the agent used to ignore the argument entirely.
    await expand({ topic: 'T', settings: {} }, { visual_style: 'anime' });
    expect(promptsSent()[0]).toContain('anime / 2D animation style');
    expect(promptsSent()[0]).not.toContain('photorealistic');
  });

  it('maps every Visual Style slug the UI offers to a phrase', async () => {
    for (const slug of ['cinematic', 'anime', '3d', 'watercolor', 'cyberpunk']) {
      generateText.mockClear();
      await expand({ topic: 'T', settings: {} }, { visual_style: slug });
      // The raw slug must never reach the prompt on its own — '3d' and
      // 'watercolor' mean nothing to an image model as bare words.
      expect(promptsSent()[0]).not.toContain(`${slug}, 9:16 vertical`);
    }
  });

  it("keeps the universe's art style winning over the plan", async () => {
    // Regression guard for story episodes: the universe locks the look.
    await expand(
      { topic: 'T', settings: {}, universe: { artStyle: 'Premium Pixar-style 3D illustration', characters: [] } },
      { visual_style: 'cyberpunk' },
    );
    expect(promptsSent()[0]).toContain('Premium Pixar-style 3D illustration');
    expect(promptsSent()[0]).not.toContain('cyberpunk neon aesthetic');
  });

  it('passes a free-form DirectorAgent style through verbatim', async () => {
    await expand({ topic: 'T', settings: {} }, { visual_style: 'Clean, well-lit, professional' });
    expect(promptsSent()[0]).toContain('Clean, well-lit, professional');
  });
});

describe('orientation', () => {
  it('asks for landscape when the project renders 16:9', async () => {
    await expand({ topic: 'T', settings: { aspectRatio: '16:9' } });
    expect(promptsSent()[0]).toContain('16:9 landscape');
    expect(promptsSent()[0]).not.toContain('9:16 vertical');
  });

  it('stays vertical for 9:16 and for projects with no aspect ratio set', async () => {
    for (const settings of [{ aspectRatio: '9:16' }, {}]) {
      generateText.mockClear();
      await expand({ topic: 'T', settings });
      expect(promptsSent()[0]).toContain('9:16 vertical');
    }
  });
});

describe('scene_type', () => {
  const drafts = [
    { narration: 'a', visual: 'v', order: 0 },
    { narration: 'b', visual: 'v', order: 1 },
    { narration: 'c', visual: 'v', order: 2 },
  ];

  it('never writes narrative hook/build/cta into the render field', async () => {
    const scenes = await expand({ topic: 'T', settings: {} }, {}, drafts);
    for (const s of scenes as any[]) {
      expect(['hook', 'build', 'cta']).not.toContain(s.scene_type);
      expect(s.scene_type).toBe('default');
    }
  });

  it("keeps the user's chosen render scene_type when scenes are regenerated", async () => {
    const project = { topic: 'T', settings: {}, scenes: [{ order: 1, scene_type: 'grid' }] };
    const scenes = await expand(project, {}, drafts);
    expect((scenes[1] as any).scene_type).toBe('grid');
    expect((scenes[0] as any).scene_type).toBe('default');
  });

  it('drops a legacy narrative value found on an existing scene', async () => {
    const project = { topic: 'T', settings: {}, scenes: [{ order: 0, scene_type: 'hook' }] };
    const scenes = await expand(project, {}, drafts);
    expect((scenes[0] as any).scene_type).toBe('default');
  });
});

describe('pickMotion', () => {
  it("honours the user's Cinematic Effect for every scene", () => {
    const project = { settings: { motionEffect: 'pan_left' } } as any;
    expect([0, 1, 2].map(i => pickMotion(project, i))).toEqual(['pan_left', 'pan_left', 'pan_left']);
  });

  it('alternates when nothing is chosen', () => {
    expect(pickMotion({ settings: {} } as any, 0)).toBe('zoom_in');
    expect(pickMotion({ settings: {} } as any, 1)).toBe('pan_right');
  });

  it('only ever picks a motion the renderer implements', () => {
    const project = { settings: { motionEffect: 'random' } } as any;
    for (let i = 0; i < 40; i++) {
      expect(['zoom_in', 'zoom_out', 'pan_right', 'pan_left']).toContain(pickMotion(project, i));
    }
  });
});

describe('generateScenes scene remap', () => {
  const run = async (project: any) => {
    loadedProject = project;
    const res: any = { json: vi.fn(), status: vi.fn(() => res) };
    await generateScenes({ params: { id: 'p1' }, body: {} } as any, res);
    expect(res.status).not.toHaveBeenCalled();
    return project;
  };

  // 100+ chars so the controller treats it as a manual script (skips
  // DirectorAgent), but with no "Visual Prompt" line so it still goes through
  // segmentation + StoryboardAgent and hits the remap under test.
  const script = 'A narration line long enough to count as a manual script for the controller, with no visual prompt sections at all.';

  it('carries motion_instruction through the remap instead of losing it to zoom_in', async () => {
    // renderService falls back to a hardcoded 'zoom_in' when the visual has no
    // motion_instruction, which silently discarded the Cinematic Effect.
    const project = await run({ id: 'p1', topic: 'T', script, settings: { motionEffect: 'zoom_out' } });
    expect(project.scenes.length).toBeGreaterThan(0);
    for (const s of project.scenes) expect(s.visuals[0].motion_instruction).toBe('zoom_out');
  });

  it('keeps a cache_key field on the remapped visual', async () => {
    const project = await run({ id: 'p1', topic: 'T', script, settings: {} });
    expect(project.scenes[0].visuals[0]).toHaveProperty('cache_key');
  });

  it('does not stamp narrative scene types onto the saved scenes', async () => {
    const project = await run({ id: 'p1', topic: 'T', script, settings: {} });
    for (const s of project.scenes) expect(['hook', 'build', 'cta']).not.toContain(s.scene_type);
  });

  it('honours the Cinematic Effect on the visual-prompt fast path too', async () => {
    const fastScript = 'Narration: hello there this is a reasonably long manual script line\nVisual Prompt: a wide shot of a desk\nDuration: 4';
    const project = await run({ id: 'p1', topic: 'T', script: fastScript, settings: { motionEffect: 'pan_left' } });
    expect(project.scenes[0].visuals[0].motion_instruction).toBe('pan_left');
  });
});
