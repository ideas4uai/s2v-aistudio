import { describe, expect, it } from 'vitest';
import { createWorkflowState } from '../src/content-studio/domain/productionPackage';
import { deriveWorkflowStatus, nextRunnableStage, updateStage } from '../src/content-studio/workflow/workflowState';

describe('Content Studio workflow state', () => {
  it('selects the next pending stage and identifies approval states', () => {
    const stages = createWorkflowState();
    expect(nextRunnableStage(stages)?.stage).toBe('idea');

    const awaitingApproval = updateStage(stages, 'idea', { status: 'awaiting_approval' });
    expect(deriveWorkflowStatus(awaitingApproval)).toBe('awaiting_approval');
  });

  it('marks a run complete only once every stage is settled', () => {
    const completed = createWorkflowState().map((stage) => ({ ...stage, status: 'completed' as const }));
    expect(deriveWorkflowStatus(completed)).toBe('completed');

    const failed = updateStage(completed, 'package', { status: 'failed' });
    expect(deriveWorkflowStatus(failed)).toBe('failed');
  });
});
