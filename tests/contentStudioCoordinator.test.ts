import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AgentRegistry } from '../src/content-studio/workflow/agentRegistry.js';
import { WorkflowCoordinator } from '../src/content-studio/workflow/workflowCoordinator.js';
import { StudioStore } from '../src/content-studio/store.js';
import { createProductionPackage, createStudioEpisode } from '../src/content-studio/domain/productionPackage.js';
import type { StudioAgent } from '../src/content-studio/workflow/types.js';

const USER = 'u1';
let dir: string;

/** A stand-in for a real agent — no LLM, no network. */
function fakeAgent(overrides: Partial<StudioAgent> = {}): StudioAgent {
  return {
    stage: 'idea',
    name: 'Fake Agent',
    validate: () => [],
    execute: async (ctx) => ({ package: ctx.package, message: 'ok' }),
    ...overrides,
  } as StudioAgent;
}

async function seedEpisode() {
  const episode = createStudioEpisode(USER, 'Title', 'Topic');
  const pkg = createProductionPackage(episode.id, USER, episode.title);
  episode.productionPackageId = pkg.id;
  await StudioStore.save('contentStudioEpisodes', episode.id, episode);
  await StudioStore.save('contentStudioProductionPackages', pkg.id, pkg);
  return episode;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-coord-'));
  process.env.OUTPUTS_DIR = dir;
  process.env.DISABLE_FIRESTORE = 'true';
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.OUTPUTS_DIR;
  delete process.env.DISABLE_FIRESTORE;
});

describe('agent registration', () => {
  // 30s, not the default 5s. This one line pulls in the whole render pipeline —
  // agents/index imports the handoff agent, which imports the orchestrator — and
  // transforming that graph cold, while the rest of the suite runs in parallel,
  // has always been able to outlast 5s on a laptop. The assertion is about the
  // registry, never about how fast the import is, so the timeout was only ever
  // measuring the machine.
  it('registers an agent for every workflow stage', { timeout: 30_000 }, async () => {
    // The module registers on import; the original failure mode was an empty
    // registry, which made every run fail on its first stage.
    await import('../src/content-studio/agents/index.js');
    const { contentStudioAgentRegistry } = await import('../src/content-studio/workflow/agentRegistry.js');
    const { WORKFLOW_STAGES } = await import('../src/content-studio/domain/productionPackage.js');

    expect(contentStudioAgentRegistry.list().map((a) => a.stage).sort()).toEqual([...WORKFLOW_STAGES].sort());
  });
});

describe('WorkflowCoordinator', () => {
  it('runs a registered stage and advances the run', async () => {
    const registry = new AgentRegistry();
    registry.register(fakeAgent());
    const coordinator = new WorkflowCoordinator(registry);

    const run = await coordinator.start(USER, await seedEpisode());
    const after = await coordinator.runNext(USER, run.id);

    expect(after.stages.find((s) => s.stage === 'idea')?.status).toBe('completed');
    expect(after.stages.find((s) => s.stage === 'idea')?.attempts).toBe(1);
  });

  it('marks the stage failed — not stuck running — when no agent is registered', async () => {
    const coordinator = new WorkflowCoordinator(new AgentRegistry());
    const run = await coordinator.start(USER, await seedEpisode());

    const after = await coordinator.runNext(USER, run.id);

    // The original bug threw here, leaving the run persisted as `running`
    // with no way for retry to reach the stage.
    expect(after.status).toBe('failed');
    const stage = after.stages.find((s) => s.stage === 'idea');
    expect(stage?.status).toBe('failed');
    expect(stage?.error).toMatch(/No agent is registered/);
  });

  it('records a throwing agent as a failed stage that retry can re-queue', async () => {
    const registry = new AgentRegistry();
    registry.register(fakeAgent({ execute: async () => { throw new Error('boom'); } }));
    const coordinator = new WorkflowCoordinator(registry);

    const run = await coordinator.start(USER, await seedEpisode());
    const failed = await coordinator.runNext(USER, run.id);
    expect(failed.stages.find((s) => s.stage === 'idea')?.error).toBe('boom');

    const retried = await coordinator.retry(USER, run.id, 'idea');
    const stage = retried.stages.find((s) => s.stage === 'idea');
    expect(stage?.status).toBe('pending');
    expect(stage?.error).toBeUndefined();
  });

  it('rejects an agent whose output fails package validation', async () => {
    const registry = new AgentRegistry();
    registry.register(fakeAgent({
      execute: async (ctx) => ({ package: { ...ctx.package, story: { ...ctx.package.story, title: '' } }, message: 'bad' }),
    }));
    const coordinator = new WorkflowCoordinator(registry);

    const run = await coordinator.start(USER, await seedEpisode());
    const after = await coordinator.runNext(USER, run.id);

    expect(after.stages.find((s) => s.stage === 'idea')?.error).toMatch(/invalid package/);
  });

  it('halts on a stage that requires approval, then continues once approved', async () => {
    const registry = new AgentRegistry();
    registry.register(fakeAgent({ execute: async (ctx) => ({ package: ctx.package, message: 'gate', requiresApproval: true }) }));
    const coordinator = new WorkflowCoordinator(registry);

    const run = await coordinator.start(USER, await seedEpisode());
    const gated = await coordinator.runNext(USER, run.id);
    expect(gated.stages.find((s) => s.stage === 'idea')?.status).toBe('awaiting_approval');
    await expect(coordinator.runNext(USER, run.id)).rejects.toThrow(/Approve or skip/);

    const approved = await coordinator.approve(USER, run.id, 'idea');
    expect(approved.stages.find((s) => s.stage === 'idea')?.status).toBe('completed');
  });

  it('refuses to approve a stage that never asked to be approved', async () => {
    const registry = new AgentRegistry();
    registry.register(fakeAgent());
    const coordinator = new WorkflowCoordinator(registry);
    const run = await coordinator.start(USER, await seedEpisode());

    // Pending: the agent has not run, so there is no output to sign off. Approving
    // it anyway used to mark it complete and let the next stage read the emptiness
    // as its input — which is exactly how a halted run was walked past its halt.
    await expect(coordinator.approve(USER, run.id, 'story')).rejects.toThrow(/is pending, not awaiting approval/);

    // Completed: already signed off, nothing left to answer.
    await coordinator.runNext(USER, run.id);
    await expect(coordinator.approve(USER, run.id, 'idea')).rejects.toThrow(/is completed, not awaiting approval/);
    expect((await coordinator.get(USER, run.id))!.stages.find((s) => s.stage === 'story')?.status).toBe('pending');
  });

  it('refuses to approve a failed stage instead of signing off the failure', async () => {
    const registry = new AgentRegistry();
    registry.register(fakeAgent({ execute: async () => { throw new Error('boom'); } }));
    const coordinator = new WorkflowCoordinator(registry);
    const run = await coordinator.start(USER, await seedEpisode());
    await coordinator.runNext(USER, run.id);

    await expect(coordinator.approve(USER, run.id, 'idea')).rejects.toThrow(/is failed, not awaiting approval/);
    // Retry is the way out, and it still is.
    expect((await coordinator.retry(USER, run.id, 'idea')).stages.find((s) => s.stage === 'idea')?.status).toBe('pending');
  });

  it('refuses to mutate a run belonging to another user', async () => {
    const coordinator = new WorkflowCoordinator(new AgentRegistry());
    const run = await coordinator.start(USER, await seedEpisode());
    await expect(coordinator.runNext('someone-else', run.id)).rejects.toThrow(/not found/);
  });
});
