import type { WorkflowStageName, WorkflowStageState } from '../domain/types.js';
import type { WorkflowRunStatus } from './types.js';

export function nextRunnableStage(stages: WorkflowStageState[]): WorkflowStageState | undefined {
  return stages.find((stage) => stage.status === 'pending');
}

export function deriveWorkflowStatus(stages: WorkflowStageState[]): WorkflowRunStatus {
  if (stages.some((stage) => stage.status === 'failed')) return 'failed';
  if (stages.some((stage) => stage.status === 'awaiting_approval')) return 'awaiting_approval';
  if (stages.every((stage) => stage.status === 'completed' || stage.status === 'skipped')) return 'completed';
  return 'running';
}

export function updateStage(stages: WorkflowStageState[], stageName: WorkflowStageName, update: Partial<WorkflowStageState>): WorkflowStageState[] {
  return stages.map((stage) => stage.stage === stageName ? { ...stage, ...update } : stage);
}
