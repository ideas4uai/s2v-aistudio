import type { ProductionPackage, UniverseId, WorkflowStageName, WorkflowStageState } from '../domain/types.js';

export type WorkflowRunStatus = 'pending' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';

export interface AgentMetrics {
  executionMs: number;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
  provider?: string;
}

export interface AgentLog {
  id: string;
  userId: string;
  workflowRunId: string;
  episodeId: string;
  packageId: string;
  stage: WorkflowStageName;
  status: 'started' | 'completed' | 'failed' | 'skipped' | 'awaiting_approval';
  message: string;
  error?: string;
  promptVersion?: string;
  metrics?: AgentMetrics;
  createdAt: string;
}

/**
 * How the run is being advanced. `manual` is the default and the original
 * behaviour — one stage per click. `automate` runs the stages back to back with a
 * drift check between each; it is recorded on the run so a page refresh, or the
 * click that clears the story approval gate, can pick the loop back up.
 */
export type WorkflowRunMode = 'manual' | 'automate';

export interface WorkflowRun {
  id: string;
  userId: string;
  episodeId: string;
  productionPackageId: string;
  /** Absent on runs created before automate mode existed — read as 'manual'. */
  mode?: WorkflowRunMode;
  status: WorkflowRunStatus;
  stages: WorkflowStageState[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface AgentContext {
  run: WorkflowRun;
  stage: WorkflowStageName;
  package: ProductionPackage;
  /** Normalized scope for `knowledge` — agents pass it to buildKnowledgeContext. */
  universe: UniverseId;
  knowledge: Array<Record<string, unknown>>;
}

export interface AgentResult {
  package: ProductionPackage;
  message: string;
  metrics?: Omit<AgentMetrics, 'executionMs'>;
  requiresApproval?: boolean;
}

export interface StudioAgent {
  readonly stage: WorkflowStageName;
  readonly name: string;
  validate(context: AgentContext): string[];
  execute(context: AgentContext): Promise<AgentResult>;
}
