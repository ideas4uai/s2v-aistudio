import type { StudioAgent } from './types.js';
import type { WorkflowStageName } from '../domain/types.js';

/** Agents register once and are resolved only by the workflow coordinator. */
export class AgentRegistry {
  private readonly agents = new Map<WorkflowStageName, StudioAgent>();

  register(agent: StudioAgent): void {
    if (this.agents.has(agent.stage)) throw new Error(`An agent is already registered for ${agent.stage}.`);
    this.agents.set(agent.stage, agent);
  }

  get(stage: WorkflowStageName): StudioAgent | undefined {
    return this.agents.get(stage);
  }

  list(): StudioAgent[] {
    return [...this.agents.values()];
  }
}

export const contentStudioAgentRegistry = new AgentRegistry();
