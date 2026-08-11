import { contentStudioAgentRegistry } from '../workflow/agentRegistry.js';
import { handoffAgent } from './handoffAgent.js';
import { ideaAgent } from './ideaAgent.js';
import { packageAgent } from './packageAgent.js';
import { storyAgent } from './storyAgent.js';

// Importing this module registers every stage agent. The route file imports it
// for that side effect — without it the coordinator has an empty registry and
// every run fails on its first stage.
let registered = false;

export function registerContentStudioAgents(): void {
  if (registered) return;
  for (const agent of [ideaAgent, storyAgent, packageAgent, handoffAgent]) {
    contentStudioAgentRegistry.register(agent);
  }
  registered = true;
}

registerContentStudioAgents();
