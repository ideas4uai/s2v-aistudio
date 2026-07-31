import { saveProjectState } from '../../pipeline/orchestrator.js';
import { packageToProjectPayload, packageToScript } from '../handoff.js';
import type { AgentContext, AgentResult, StudioAgent } from '../workflow/types.js';

/**
 * Creates the Script2Video draft project and records the link back on the
 * package. Deliberately the thinnest stage: it persists a draft via the
 * pipeline's own saveProjectState (which already handles local vs Firestore)
 * and stops. Rendering stays entirely the user's call from the main dashboard.
 */
export const handoffAgent: StudioAgent = {
  stage: 'handoff',
  name: 'Handoff Agent',

  validate(context: AgentContext): string[] {
    const errors: string[] = [];
    if (!context.package.scenes.length) errors.push('The package has no scenes to render.');
    if (!packageToScript(context.package).trim()) errors.push('The package has no narration to render.');
    if (context.package.render.script2VideoProjectId) {
      errors.push(`Already handed off as project ${context.package.render.script2VideoProjectId}. Retry the stage only after clearing it.`);
    }
    return errors;
  },

  async execute(context: AgentContext): Promise<AgentResult> {
    const project = packageToProjectPayload(context.package, context.package.ownerId);
    project.scenes = [];
    await saveProjectState(project);

    return {
      package: {
        ...context.package,
        status: 'approved',
        render: {
          ...context.package.render,
          script2VideoProjectId: project.project_id,
          sentAt: new Date().toISOString(),
        },
      },
      message: `Created Script2Video project ${project.project_id}. Open it from the dashboard to render.`,
    };
  },
};
