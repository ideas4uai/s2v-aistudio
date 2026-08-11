import { v4 as uuidv4 } from 'uuid';
import { StudioStore } from '../store.js';
import type { ProductionPackage, StudioEpisode, WorkflowStageName } from '../domain/types.js';
import { createWorkflowState, validateProductionPackage } from '../domain/productionPackage.js';
import { normalizeUniverse } from '../knowledgeContext.js';
import { contentStudioAgentRegistry, type AgentRegistry } from './agentRegistry.js';
import { deriveWorkflowStatus, nextRunnableStage, updateStage } from './workflowState.js';
import type { AgentLog, WorkflowRun } from './types.js';

const RUNS_COLLECTION = 'contentStudioWorkflowRuns';
const LOGS_COLLECTION = 'contentStudioAgentLogs';
const PACKAGES_COLLECTION = 'contentStudioProductionPackages';
const EPISODES_COLLECTION = 'contentStudioEpisodes';
const KNOWLEDGE_COLLECTION = 'contentStudioKnowledge';

export class WorkflowCoordinator {
  constructor(private readonly registry: AgentRegistry = contentStudioAgentRegistry) {}

  async start(userId: string, episode: StudioEpisode): Promise<WorkflowRun> {
    const now = new Date().toISOString();
    const run: WorkflowRun = {
      id: uuidv4(), userId, episodeId: episode.id, productionPackageId: episode.productionPackageId,
      status: 'pending', stages: createWorkflowState(), createdAt: now, updatedAt: now,
    };
    await StudioStore.save(RUNS_COLLECTION, run.id, run);
    return run;
  }

  async get(userId: string, runId: string): Promise<WorkflowRun | null> {
    const run = await StudioStore.get(RUNS_COLLECTION, runId) as WorkflowRun | null;
    return run?.userId === userId ? run : null;
  }

  async runNext(userId: string, runId: string): Promise<WorkflowRun> {
    const run = await this.requireRun(userId, runId);
    if (run.status === 'completed' || run.status === 'cancelled') return run;
    if (run.status === 'awaiting_approval') throw new Error('Approve or skip the current stage before resuming.');
    const next = nextRunnableStage(run.stages);
    if (!next) return this.saveRun({ ...run, status: deriveWorkflowStatus(run.stages), updatedAt: new Date().toISOString() });
    const agent = this.registry.get(next.stage);
    // Record this as a stage failure instead of throwing. Throwing here left the
    // run persisted as `running` with no agent to move it on, so retry could
    // never reach the stage — the run was stuck for good.
    if (!agent) return this.failStage(run, next.stage, `No agent is registered for the ${next.stage} stage.`);

    const startedAt = new Date().toISOString();
    let activeRun: WorkflowRun = { ...run, status: 'running', stages: updateStage(run.stages, next.stage, { status: 'running', attempts: next.attempts + 1, startedAt, error: undefined }), updatedAt: startedAt };
    activeRun = await this.saveRun(activeRun);
    await this.log(activeRun, next.stage, 'started', `${agent.name} started.`);

    const started = Date.now();
    try {
      const [productionPackage, knowledge] = await Promise.all([
        StudioStore.get(PACKAGES_COLLECTION, run.productionPackageId),
        StudioStore.list(KNOWLEDGE_COLLECTION, userId),
      ]);
      if (!productionPackage || (productionPackage as ProductionPackage).ownerId !== userId) throw new Error('Production package not found.');
      const packageValue = productionPackage as ProductionPackage;
      const context = {
        run: activeRun, stage: next.stage, package: packageValue,
        universe: normalizeUniverse(packageValue.universe),
        knowledge: (knowledge as any[]).filter((document) => document.userId === userId),
      };
      const validationErrors = agent.validate(context);
      if (validationErrors.length) throw new Error(validationErrors.join(' '));
      const result = await agent.execute(context);
      const elapsed = Date.now() - started;
      const completedAt = new Date().toISOString();
      const stageStatus = result.requiresApproval ? 'awaiting_approval' : 'completed';
      const stages = updateStage(activeRun.stages, next.stage, { status: stageStatus, completedAt });
      const updatedPackage = { ...result.package, id: packageValue.id, ownerId: userId, episodeId: run.episodeId, updatedAt: completedAt };
      // Validate what the agent produced, not just what it was handed — an agent
      // that returns a malformed package must fail its own stage rather than
      // persist damage the next stage inherits.
      const outputErrors = validateProductionPackage(updatedPackage);
      if (outputErrors.length) throw new Error(`${agent.name} produced an invalid package: ${outputErrors.join(' ')}`);
      await StudioStore.save(PACKAGES_COLLECTION, updatedPackage.id, updatedPackage);
      const updated = await this.saveRun({ ...activeRun, stages, status: deriveWorkflowStatus(stages), updatedAt: completedAt, completedAt: deriveWorkflowStatus(stages) === 'completed' ? completedAt : undefined });
      await this.log(updated, next.stage, stageStatus, result.message, undefined, { executionMs: elapsed, ...result.metrics });
      return updated;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown agent error.';
      const completedAt = new Date().toISOString();
      const stages = updateStage(activeRun.stages, next.stage, { status: 'failed', completedAt, error: errorMessage });
      const failed = await this.saveRun({ ...activeRun, stages, status: 'failed', updatedAt: completedAt });
      await this.log(failed, next.stage, 'failed', `${agent.name} failed.`, errorMessage, { executionMs: Date.now() - started });
      return failed;
    }
  }

  async retry(userId: string, runId: string, stage: WorkflowStageName): Promise<WorkflowRun> {
    // A completed run may still be retried — that is how a stage gets
    // regenerated — but a cancelled one must not be mutated at all.
    const run = await this.requireRun(userId, runId, { allowCompleted: true });
    const stages = updateStage(run.stages, stage, { status: 'pending', error: undefined, completedAt: undefined });
    const updated = await this.saveRun({ ...run, stages, status: deriveWorkflowStatus(stages), updatedAt: new Date().toISOString() });
    await this.log(updated, stage, 'started', 'Stage queued for retry.');
    return updated;
  }

  async skip(userId: string, runId: string, stage: WorkflowStageName): Promise<WorkflowRun> {
    const run = await this.requireRun(userId, runId);
    const stages = updateStage(run.stages, stage, { status: 'skipped', completedAt: new Date().toISOString(), error: undefined });
    const updated = await this.saveRun({ ...run, stages, status: deriveWorkflowStatus(stages), updatedAt: new Date().toISOString() });
    await this.log(updated, stage, 'skipped', 'Stage skipped by user.');
    return updated;
  }

  async approve(userId: string, runId: string, stage: WorkflowStageName): Promise<WorkflowRun> {
    const run = await this.requireRun(userId, runId);
    const stages = updateStage(run.stages, stage, { status: 'completed', completedAt: new Date().toISOString() });
    const updated = await this.saveRun({ ...run, stages, status: deriveWorkflowStatus(stages), updatedAt: new Date().toISOString() });
    await this.log(updated, stage, 'completed', 'Stage approved by user.');
    return updated;
  }

  private async requireRun(userId: string, runId: string, options: { allowCompleted?: boolean } = {}): Promise<WorkflowRun> {
    const run = await this.get(userId, runId);
    if (!run) throw new Error('Workflow run not found.');
    if (run.status === 'cancelled') throw new Error('This workflow run was cancelled.');
    if (run.status === 'completed' && !options.allowCompleted) throw new Error('This workflow run is already complete.');
    return run;
  }

  /** Persist a stage failure so the run stays visible and retryable. */
  private async failStage(run: WorkflowRun, stage: WorkflowStageName, error: string): Promise<WorkflowRun> {
    const completedAt = new Date().toISOString();
    const stages = updateStage(run.stages, stage, { status: 'failed', completedAt, error });
    const failed = await this.saveRun({ ...run, stages, status: 'failed', updatedAt: completedAt });
    await this.log(failed, stage, 'failed', error, error);
    return failed;
  }

  private async saveRun(run: WorkflowRun): Promise<WorkflowRun> {
    await StudioStore.save(RUNS_COLLECTION, run.id, run);
    return run;
  }

  private async log(run: WorkflowRun, stage: WorkflowStageName, status: AgentLog['status'], message: string, error?: string, metrics?: AgentLog['metrics']): Promise<void> {
    const log: AgentLog = { id: uuidv4(), userId: run.userId, workflowRunId: run.id, episodeId: run.episodeId, packageId: run.productionPackageId, stage, status, message, error, metrics, createdAt: new Date().toISOString() };
    await StudioStore.save(LOGS_COLLECTION, log.id, log);
  }
}

export const contentStudioWorkflowCoordinator = new WorkflowCoordinator();
