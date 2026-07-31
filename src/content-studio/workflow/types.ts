import type { ProductionPackage, WorkflowStageName, WorkflowStageState } from '../domain/types.js';

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

export interface WorkflowRun {
  id: string;
  userId: string;
  episodeId: string;
  productionPackageId: string;
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
