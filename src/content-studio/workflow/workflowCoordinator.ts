import { v4 as uuidv4 } from 'uuid';
import { StudioStore, KNOWLEDGE_COLLECTION } from '../store.js';
import type { ProductionPackage, StudioEpisode, WorkflowStageName } from '../domain/types.js';
import { createWorkflowState, validateProductionPackage } from '../domain/productionPackage.js';
import { normalizeUniverse } from '../knowledgeContext.js';
import { packageToProjectPayload, packageToScript } from '../handoff.js';
import { resolveUniverse } from '../universeLink.js';
import { targetLengthSeconds } from '../../utils/targetLength.js';
import { contentStudioAgentRegistry, type AgentRegistry } from './agentRegistry.js';
import {
  checkAngleDrift, checkDuration, checkImagePromptRelevance, checkScriptQuality, storyProse,
} from './guardrails.js';
import { generateText } from '../../services/text/index.js';
import { deriveWorkflowStatus, nextRunnableStage, updateStage } from './workflowState.js';
import type { AgentLog, WorkflowRun } from './types.js';

const RUNS_COLLECTION = 'contentStudioWorkflowRuns';
const LOGS_COLLECTION = 'contentStudioAgentLogs';
const PACKAGES_COLLECTION = 'contentStudioProductionPackages';
const EPISODES_COLLECTION = 'contentStudioEpisodes';


export class WorkflowCoordinator {
  /**
   * @param adjudicate Second opinion for the one guardrail a word count cannot
   *   settle. Injected so the tests never reach the network — and so the only
   *   model call the guardrail layer can make is visible in one place.
   */
  constructor(
    private readonly registry: AgentRegistry = contentStudioAgentRegistry,
    private readonly adjudicate: (prompt: string) => Promise<string> =
      (prompt) => generateText(prompt, { task: 'planning' }),
  ) {}

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

  /**
   * Runs every remaining stage back to back, checking for drift between each.
   *
   * The stages themselves go through runNext, unchanged — an automated stage and a
   * hand-clicked one are the same code path, so manual mode cannot regress from
   * anything here. All this adds is the loop and the check between iterations.
   *
   * Stops at exactly three things:
   *   - a stage that failed (runNext already recorded why),
   *   - the story approval gate, which automate mode does NOT bypass. A human
   *     approving the story beats is the one judgement no check here replaces, and
   *     it sits immediately before the first stage that spends image budget. Four
   *     stages plus a render for one click instead of five.
   *   - a guardrail, which marks the stage that produced the drift as failed so the
   *     existing Retry button re-runs precisely the stage at fault.
   *
   * @param startRender Invoked with the handed-off project id once every stage has
   *   passed. Injected rather than imported so the coordinator keeps no dependency
   *   on the renderer — and so a test can assert it was never reached.
   */
  async runAutomated(userId: string, runId: string, startRender?: (projectId: string) => void): Promise<WorkflowRun> {
    let run = await this.requireRun(userId, runId, { allowCompleted: true });
    // Resuming past a stage that is still failed would be the one thing automate
    // mode must never do — the halt is only a halt while it is in the way.
    const broken = run.stages.find((stage) => stage.status === 'failed');
    if (broken) throw new Error(`The ${broken.stage} stage failed — retry or skip it before resuming. ${broken.error ?? ''}`.trim());
    if (run.mode !== 'automate') run = await this.saveRun({ ...run, mode: 'automate', updatedAt: new Date().toISOString() });

    // Bounded by the stage count: runNext always leaves the stage it ran in a
    // terminal state, so this can only spin if that stops being true.
    for (let remaining = run.stages.length; remaining > 0; remaining--) {
      const next = nextRunnableStage(run.stages);
      if (!next) break;

      run = await this.runNext(userId, runId);
      if (run.stages.find((stage) => stage.stage === next.stage)?.status !== 'completed') return run;

      const reasons = await this.guardStage(run, next.stage);
      if (reasons.length) {
        return this.failStage(run, next.stage, `Automate halted after the ${next.stage} stage: ${reasons.join('; ')}`);
      }
    }

    if (run.status === 'completed' && startRender) {
      const productionPackage = await StudioStore.get(PACKAGES_COLLECTION, run.productionPackageId) as ProductionPackage | null;
      const projectId = productionPackage?.render.script2VideoProjectId;
      // Handoff deliberately stops at a draft because rendering is the user's call.
      // Pressing Automate is that call, made once for the whole run.
      if (projectId) startRender(projectId);
    }
    return run;
  }

  /**
   * The drift checks for the transition out of `stage`. Empty means carry on.
   *
   * Nothing runs after `handoff`: that stage only creates the draft project, and the
   * render's own pre-stitch audio check and terminal quality gate take over there.
   */
  private async guardStage(run: WorkflowRun, stage: WorkflowStageName): Promise<string[]> {
    const productionPackage = await StudioStore.get(PACKAGES_COLLECTION, run.productionPackageId) as ProductionPackage | null;
    if (!productionPackage) return ['the production package went missing between stages'];
    const seed = await this.seedTopic(run);

    if (stage === 'idea') return checkAngleDrift(seed, productionPackage.story.title, this.adjudicate);

    // The beats, not the finished narration — this is the earliest text that says what
    // the episode claims, and failing here saves the package stage's four model calls.
    if (stage === 'story') return checkScriptQuality(storyProse(productionPackage.story), `${productionPackage.story.title} ${seed}`);

    if (stage === 'package') {
      const script = packageToScript(productionPackage);
      // Measured against the budget the render will actually use: same mapper, so the
      // guardrail cannot disagree with the project the handoff is about to create.
      const universe = await resolveUniverse(productionPackage.ownerId, productionPackage.universe);
      const project = packageToProjectPayload(productionPackage, productionPackage.ownerId, universe);
      return [
        ...checkScriptQuality(script, `${productionPackage.story.title} ${seed}`),
        ...checkDuration(script, targetLengthSeconds(project.settings?.targetLength)),
        ...checkImagePromptRelevance(productionPackage.scenes, `${productionPackage.story.title} ${seed}`),
      ];
    }

    return [];
  }

  /** What the user actually typed when they created the episode. */
  private async seedTopic(run: WorkflowRun): Promise<string> {
    const episode = await StudioStore.get(EPISODES_COLLECTION, run.episodeId) as StudioEpisode | null;
    return `${episode?.title ?? ''} ${episode?.topic ?? ''}`.trim();
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
    // Approval is an answer to a question the stage asked. Without this, approving a
    // stage that never paused marked it complete anyway — so a stage that had failed,
    // or one that had not run at all, could be signed off with output nobody wrote,
    // and the stage after it would then read that empty output as its input.
    const current = run.stages.find((state) => state.stage === stage);
    if (current?.status !== 'awaiting_approval') {
      throw new Error(`The ${stage} stage is ${current?.status ?? 'not part of this run'}, not awaiting approval — there is nothing to approve.`);
    }
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
