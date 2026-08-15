import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  checkAngleDrift, checkAngleRelevance, checkDuration, checkImagePromptRelevance, checkScriptQuality,
  checkSceneAudio, contentWords, MAX_WORD_RATIO, MIN_WORD_RATIO, storyProse,
} from '../src/content-studio/workflow/guardrails.js';
import { AgentRegistry } from '../src/content-studio/workflow/agentRegistry.js';
import { WorkflowCoordinator } from '../src/content-studio/workflow/workflowCoordinator.js';
import { StudioStore } from '../src/content-studio/store.js';
import { createProductionPackage, createStudioEpisode } from '../src/content-studio/domain/productionPackage.js';
import { targetWordCount } from '../src/utils/targetLength.js';
import type { ProductionPackage, ProductionScene } from '../src/content-studio/domain/types.js';
import type { StudioAgent } from '../src/content-studio/workflow/types.js';
import type { Project } from '../src/models/project.js';

const USER = 'u1';
const TOPIC = 'Playwright agent mode Playwright can now write and fix your failing tests';

// One sentence, fifteen words — ten of them is exactly the 150-word budget a 60s
// target asks for, which is the band the duration check is measured against.
const LINE = 'Playwright now watches the failing test suite and reports what changed inside the browser session.';

const scene = (order: number, over: Partial<ProductionScene> = {}): ProductionScene => ({
  id: `s${order}`, order, objective: LINE,
  dialogue: [{ speaker: 'NARRATOR', text: LINE }],
  imagePrompt: { positive: 'a Playwright test suite dashboard with one failing browser session' },
  ...over,
});

const scenes = (count: number, over: Partial<ProductionScene> = {}): ProductionScene[] =>
  Array.from({ length: count }, (_, i) => scene(i + 1, over));

describe('content-word overlap', () => {
  it('matches a plural against its singular and drops filler', () => {
    const words = contentWords('These broken tests will make everything better for your Playwright suite');
    expect(words.has('test')).toBe(true);
    expect(words.has('playwright')).toBe(true);
    // Stoplisted or too short to prove anything about the subject.
    for (const filler of ['these', 'will', 'make', 'everything', 'better', 'your']) {
      expect(words.has(filler)).toBe(false);
    }
  });
});

describe('idea → story: angle relevance', () => {
  it('passes an angle that is still about the topic the user typed', () => {
    expect(checkAngleRelevance(TOPIC, 'The Playwright agent that rewrites a broken suite overnight')).toEqual([]);
  });

  it('halts an angle that wandered onto a different subject', () => {
    const reasons = checkAngleRelevance(TOPIC, 'Why remote standups drain a whole morning');
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/shares no subject word/);
  });

  it('says nothing when there is no seed topic to drift from', () => {
    expect(checkAngleRelevance('', 'anything at all')).toEqual([]);
  });

  describe('with a second opinion on the suspicious ones', () => {
    const asked: string[] = [];
    const answer = (verdict: string) => async (prompt: string) => { asked.push(prompt); return verdict; };

    it('never asks about an angle the free check already vouched for', async () => {
      asked.length = 0;
      expect(await checkAngleDrift(TOPIC, 'The Playwright suite that rewrote itself', answer('UNRELATED'))).toEqual([]);
      expect(asked).toEqual([]);
    });

    it('clears a metaphor the free check could not read', async () => {
      // The real case: "The Data Drift Anomaly" for a topic about a flaky Friday
      // test. No shared word, still the same subject.
      asked.length = 0;
      expect(await checkAngleDrift(TOPIC, 'The Data Drift Anomaly', answer('RELATED'))).toEqual([]);
      expect(asked).toHaveLength(1);
      expect(asked[0]).toContain('The Data Drift Anomaly');
    });

    it('halts when the second opinion agrees it drifted', async () => {
      const reasons = await checkAngleDrift(TOPIC, 'Why remote standups drain a morning', answer('UNRELATED'));
      expect(reasons[0]).toMatch(/shares no subject word.*did not vouch for it/);
    });

    it('keeps the halt when the adjudicator is unavailable', async () => {
      const reasons = await checkAngleDrift(TOPIC, 'Why remote standups drain a morning', async () => { throw new Error('offline'); });
      expect(reasons).toHaveLength(1);
    });
  });
});

describe('story → storyboard: claims and craft as a hard gate', () => {
  it('passes clean prose', () => {
    expect(checkScriptQuality(`${LINE} It reruns the suite and shows the diff.`, TOPIC)).toEqual([]);
  });

  it('halts on an unsourced figure', () => {
    const reasons = checkScriptQuality('Teams cut their debugging time by 40% with this.', TOPIC);
    expect(reasons).toEqual(['unsourced claim: 40%']);
  });

  it('halts on a guarantee the material does not hedge', () => {
    const reasons = checkScriptQuality('Playwright solves flaky tests for good.', TOPIC);
    expect(reasons.join(' ')).toMatch(/overclaim "solves"/);
  });

  it('stays quiet when the figure came from the source material', () => {
    // Same warn-only contract flagUnverifiedClaims already has: a supplied number
    // is sourced, and promoting the check to a halt must not change that.
    expect(checkScriptQuality('Runs cut by 40% in the release notes.', TOPIC, 'the release notes report 40%')).toEqual([]);
  });

  it('reads the beats in the order they are told', () => {
    const prose = storyProse({ title: 'x', hookVariations: [], hook: 'A', conflict: 'B', cta: 'C' });
    expect(prose).toBe('A B C');
  });
});

describe('script → storyboard: duration mismatch', () => {
  const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ');

  it('derives its band from the padding planner, not from taste', () => {
    // 1 / (1.5 * 0.95) and 1 + 2 * 0.15 — stated here so a change to MAX_PAD_FACTOR
    // or TARGET_TOLERANCE moves the guardrail with it rather than silently diverging.
    expect(MIN_WORD_RATIO).toBeCloseTo(0.702, 3);
    expect(MAX_WORD_RATIO).toBeCloseTo(1.3, 3);
  });

  it('catches the real 60s / 103-word script that padding had to stretch', () => {
    expect(targetWordCount(60)).toBe(150);
    const reasons = checkDuration(words(103), 60);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/103 words against a 150-word budget for 60s \(69%\)/);
    expect(reasons[0]).toMatch(/hold every scene at its cap/);
  });

  it('passes a script written to its budget', () => {
    expect(checkDuration(words(150), 60)).toEqual([]);
    expect(checkDuration(words(106), 60)).toEqual([]); // just inside the floor
  });

  it('catches a script too long to fit, which padding cannot help at all', () => {
    expect(checkDuration(words(200), 60)[0]).toMatch(/overruns the target/);
  });
});

describe('storyboard → voice: image-prompt relevance', () => {
  it('passes prompts that name what their scene says', () => {
    expect(checkImagePromptRelevance(scenes(10), TOPIC)).toEqual([]);
  });

  it('halts a storyboard of fully generic prompts — the Playwright drift shape', () => {
    // The original bug: a script about one named tool, illustrated with abstraction.
    const generic = scenes(10, { imagePrompt: { positive: 'abstract swirling gradient, glowing particles, futuristic mood' } });
    const reasons = checkImagePromptRelevance(generic, TOPIC);
    expect(reasons).toHaveLength(10);
    expect(reasons[0]).toMatch(/scene 1's image prompt is about nothing the scene says/);
  });

  it('halts a storyboard with no image prompts at all', () => {
    expect(checkImagePromptRelevance(scenes(6, { imagePrompt: undefined }), TOPIC)[0]).toMatch(/has no image prompt/);
  });

  it('tolerates one atmospheric shot in an otherwise anchored storyboard', () => {
    // Halting a whole render over a single establishing frame would make automate
    // mode unusable, so the threshold is a third of the storyboard, not one scene.
    const mixed = scenes(10);
    mixed[3].imagePrompt = { positive: 'abstract swirling gradient, glowing particles' };
    expect(checkImagePromptRelevance(mixed, TOPIC)).toEqual([]);
  });

  it('accepts an appearance-led prompt that names the scene\'s own character', () => {
    // Real Storyboard Agent output: the prompt is a description of a person and
    // quotes none of the narration. Three-letter names are why this is matched
    // whole rather than through the four-letter content-word rule.
    const cast = scenes(4, {
      characters: ['RAJ'],
      dialogue: [{ speaker: 'RAJ', text: 'Not again.' }],
      imagePrompt: { positive: 'Raj (Indian male, 34, beard, black polo shirt) glares at a monitor' },
    });
    expect(checkImagePromptRelevance(cast, TOPIC)).toEqual([]);
  });

  it('still halts an appearance-led prompt for someone the scene never cast', () => {
    const cast = scenes(4, {
      characters: ['RAJ'],
      dialogue: [{ speaker: 'RAJ', text: 'Not again.' }],
      imagePrompt: { positive: 'a serene mountain landscape at golden hour' },
    });
    expect(checkImagePromptRelevance(cast, TOPIC)).toHaveLength(4);
  });

  it('exempts a wordless beat, which has no narration to illustrate', () => {
    // Both silent scenes of a real six-scene storyboard were flagged for this: the
    // reaction beats carry no dialogue, so only the episode title was left to match
    // against, and a picture of a character matches almost no title.
    const silent = scenes(4, { characters: ['NARRATOR'], dialogue: [], imagePrompt: { positive: 'Wide over-shoulder shot of Arjun, messy hair, black hoodie' } });
    expect(checkImagePromptRelevance(silent, TOPIC)).toEqual([]);

    // A silent scene with no prompt at all is still a problem — nothing to render.
    const blank = scenes(4, { dialogue: [], imagePrompt: undefined });
    expect(checkImagePromptRelevance(blank, TOPIC)).toHaveLength(4);
  });

  it('does not fire on the real Playwright storyboard, which named its subject', () => {
    // Honest calibration against the actual prompts from that episode: they DID say
    // tests, dashboards and Playwright — they rendered stock illustration anyway.
    // Lexical overlap cannot see that, and the entity-image sourcing work is what
    // fixed it. This check catches the vacuous prompt, which those were not.
    const real = ['a test suite dashboard filled with multiple red failing indicators',
      "a glowing red 'X' test icon hovering over a laptop",
      'outdated, broken tests scattered across a desk',
      'a majestic, glowing Playwright-style logo rising over a city']
      .map((positive, i) => scene(i + 1, { imagePrompt: { positive } }));
    expect(checkImagePromptRelevance(real, TOPIC)).toEqual([]);
  });
});

describe('voice → render: audio before the stitch', () => {
  it('halts a render whose scenes have no narration audio', async () => {
    const project = { scenes: [{ scene_id: 'a', order: 1, narration_text: LINE }] } as unknown as Project;
    expect((await checkSceneAudio(project))[0]).toMatch(/no narration audio/);
  });

  it('halts a render with no scenes rather than stitching nothing', async () => {
    expect(await checkSceneAudio({ scenes: [] } as unknown as Project)).toHaveLength(1);
  });
});

describe('automate mode', () => {
  let dir: string;

  /** The happy path must never need the adjudicator; calling it here is a failure. */
  const NEVER_ASKED = async () => { throw new Error('the adjudicator should not have been asked'); };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-auto-'));
    process.env.OUTPUTS_DIR = dir;
    process.env.DISABLE_FIRESTORE = 'true';
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.OUTPUTS_DIR;
    delete process.env.DISABLE_FIRESTORE;
  });

  async function seedEpisode() {
    const episode = createStudioEpisode(USER, 'Playwright agent mode', 'Playwright can now write and fix your failing tests');
    const pkg = createProductionPackage(episode.id, USER, episode.title);
    episode.productionPackageId = pkg.id;
    await StudioStore.save('contentStudioEpisodes', episode.id, episode);
    await StudioStore.save('contentStudioProductionPackages', pkg.id, pkg);
    return episode;
  }

  /** Agents with no LLM behind them: each writes the fields its guardrail reads. */
  function registry(overrides: Partial<Record<string, Partial<StudioAgent>>> = {}, ran: string[] = []) {
    const registryValue = new AgentRegistry();
    const make = (stage: string, execute: StudioAgent['execute'], extra: Partial<StudioAgent> = {}): StudioAgent => {
      // Overrides merge first, so the call tracker wraps whichever execute wins —
      // it is what proves a later stage was never reached after a halt.
      const agent = { stage, name: `${stage} agent`, validate: () => [], execute, ...extra, ...overrides[stage] } as StudioAgent;
      return { ...agent, execute: async (ctx) => { ran.push(stage); return agent.execute(ctx); } };
    };

    registryValue.register(make('idea', async (ctx) => ({
      package: { ...ctx.package, story: { ...ctx.package.story, title: 'The Playwright agent that rewrites a broken suite' } },
      message: 'idea',
    })));
    registryValue.register(make('story', async (ctx) => ({
      package: {
        ...ctx.package,
        story: { ...ctx.package.story, hook: LINE, conflict: 'The suite went red overnight.', cta: 'Watch the rerun.' },
      },
      message: 'story',
      requiresApproval: true,
    })));
    registryValue.register(make('package', async (ctx) => ({
      package: { ...ctx.package, scenes: scenes(10) }, message: 'package',
    })));
    registryValue.register(make('handoff', async (ctx) => ({
      package: { ...ctx.package, render: { ...ctx.package.render, script2VideoProjectId: 'p-42' } }, message: 'handoff',
    })));
    return registryValue;
  }

  it('runs every stage back to back and starts the render, with one approval in the middle', async () => {
    const ran: string[] = [];
    const rendered: string[] = [];
    const coordinator = new WorkflowCoordinator(registry({}, ran), NEVER_ASKED);
    const run = await coordinator.start(USER, await seedEpisode());

    // One click: runs idea, checks it, runs story, and stops at the approval gate.
    const gated = await coordinator.runAutomated(USER, run.id, (id) => rendered.push(id));
    expect(ran).toEqual(['idea', 'story']);
    expect(gated.mode).toBe('automate');
    expect(gated.status).toBe('awaiting_approval');
    expect(rendered).toEqual([]);

    // The human click. Everything after it is automatic again.
    await coordinator.approve(USER, run.id, 'story');
    const done = await coordinator.runAutomated(USER, run.id, (id) => rendered.push(id));

    expect(ran).toEqual(['idea', 'story', 'package', 'handoff']);
    expect(done.status).toBe('completed');
    expect(done.stages.every((s) => s.status === 'completed')).toBe(true);
    expect(rendered).toEqual(['p-42']);
  });

  it('halts on the idea guardrail without running or paying for a single later stage', async () => {
    const ran: string[] = [];
    const rendered: string[] = [];
    const coordinator = new WorkflowCoordinator(registry({
      idea: {
        execute: async (ctx) => ({
          package: { ...ctx.package, story: { ...ctx.package.story, title: 'Why remote standups drain a whole morning' } },
          message: 'drifted',
        }),
      },
    }, ran), async () => 'UNRELATED');
    const run = await coordinator.start(USER, await seedEpisode());

    const halted = await coordinator.runAutomated(USER, run.id, (id) => rendered.push(id));

    expect(halted.status).toBe('failed');
    const stage = halted.stages.find((s) => s.stage === 'idea');
    expect(stage?.status).toBe('failed');
    expect(stage?.error).toMatch(/Automate halted after the idea stage: the angle .* shares no subject word/);
    // Cost containment: the story, package and handoff agents were never called, so
    // no script, image prompt or render budget was spent after the halt.
    expect(ran).toEqual(['idea']);
    expect(rendered).toEqual([]);
    expect(halted.stages.filter((s) => s.status === 'pending').map((s) => s.stage)).toEqual(['story', 'package', 'handoff']);
  });

  it('halts on the package guardrail before the handoff creates a render project', async () => {
    const ran: string[] = [];
    const rendered: string[] = [];
    const coordinator = new WorkflowCoordinator(registry({
      // A script a third of its budget, illustrated with abstraction — both historical
      // failures at once, caught before anything downstream is asked to render them.
      package: {
        execute: async (ctx) => ({
          package: { ...ctx.package, scenes: scenes(3, { imagePrompt: { positive: 'abstract swirling gradient, glowing particles' } }) },
          message: 'thin',
        }),
      },
    }, ran), NEVER_ASKED);
    const run = await coordinator.start(USER, await seedEpisode());

    await coordinator.runAutomated(USER, run.id);
    await coordinator.approve(USER, run.id, 'story');
    const halted = await coordinator.runAutomated(USER, run.id, (id) => rendered.push(id));

    const stage = halted.stages.find((s) => s.stage === 'package');
    expect(stage?.status).toBe('failed');
    expect(stage?.error).toMatch(/45 words against a 150-word budget/);
    expect(stage?.error).toMatch(/image prompt is about nothing the scene says/);
    expect(ran).not.toContain('handoff');
    expect(rendered).toEqual([]);

    // The halt leaves the run inspectable and retryable exactly like any other
    // stage failure — no second failure format to learn.
    const retried = await coordinator.retry(USER, run.id, 'package');
    expect(retried.stages.find((s) => s.stage === 'package')?.status).toBe('pending');
  });

  it('refuses to resume over a halt that is still standing', async () => {
    const ran: string[] = [];
    const coordinator = new WorkflowCoordinator(registry({
      idea: { execute: async (ctx) => ({ package: { ...ctx.package, story: { ...ctx.package.story, title: 'Why remote standups drain a whole morning' } }, message: 'drifted' }) },
    }, ran), async () => 'UNRELATED');
    const run = await coordinator.start(USER, await seedEpisode());
    await coordinator.runAutomated(USER, run.id);

    // Pressing Automate again must not step over the failed stage onto the next
    // pending one — the halt is only a halt while it is in the way.
    await expect(coordinator.runAutomated(USER, run.id)).rejects.toThrow(/idea stage failed — retry or skip/);
    expect(ran).toEqual(['idea']);

    // Retrying clears it, and the run picks up from the stage that failed.
    await coordinator.retry(USER, run.id, 'idea');
    await coordinator.runAutomated(USER, run.id);
    expect(ran).toEqual(['idea', 'idea']);
  });

  it('leaves a manual run alone', async () => {
    const coordinator = new WorkflowCoordinator(registry(), NEVER_ASKED);
    const run = await coordinator.start(USER, await seedEpisode());
    const after = await coordinator.runNext(USER, run.id);

    // No mode, no guardrail: run-next behaves exactly as it did before automate
    // existed, including advancing past an angle a guardrail would have stopped.
    expect(after.mode).toBeUndefined();
    expect(after.stages.find((s) => s.stage === 'idea')?.status).toBe('completed');
  });
});

/** The package the happy path builds, kept honest against the real validator. */
describe('fixture sanity', () => {
  it('is a 150-word script, which is exactly a 60s budget', () => {
    const pkg = { scenes: scenes(10) } as ProductionPackage;
    const words = pkg.scenes.flatMap((s) => s.dialogue.map((l) => l.text)).join(' ').split(/\s+/).length;
    expect(words).toBe(targetWordCount(60));
  });
});
