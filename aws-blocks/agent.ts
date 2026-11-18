import { Agent } from '@aws-blocks/blocks';
import type { ModelConfig, ToolFactory } from '@aws-blocks/blocks';
import { catalog } from '../shared/catalog.js';
import { agentConfig, modelConfig } from '../shared/config.js';
import { buildSystemPrompt } from '../shared/prompt.js';
import { toolDescriptions, toolInputSchemas, type ToolName } from '../shared/toolProtocol.js';
import { cannedExample } from './agent-canned.js';
import { runClientTool, toolSettings } from './agent-tools.js';
import { llmMode } from './runtime-config.js';
import { scope } from './scope.js';

// The model: Bedrock when deployed, and locally when `AGENT_LOCAL_MODEL` is `bedrock`. With `canned` no local model
// is set, so the block uses its canned provider (no AWS call).
const bedrockModel: ModelConfig = { provider: 'bedrock', modelId: modelConfig.modelId };

/** What the six tools have in common: the description and the input schema the model sees, the settings and the canned example. */
function toolBase<Name extends ToolName>(name: Name) {
  return {
    description: toolDescriptions[name],
    parameters: toolInputSchemas[name],
    untrustedOutput: toolSettings[name].untrustedOutput,
    cannedExamples: cannedExample(name)
  };
}

/** Each handler hands the call to the browser (`agent-tools.ts`); the Realtime channel carries the interrupt there. */
function tools(tool: ToolFactory) {
  return {
    runQuery: tool({ ...toolBase('runQuery'), handler: async ({ input, interrupt }) => runClientTool('runQuery', input, interrupt) }),
    addLayer: tool({ ...toolBase('addLayer'), handler: async ({ input, interrupt }) => runClientTool('addLayer', input, interrupt) }),
    setLayerStyle: tool({ ...toolBase('setLayerStyle'), handler: async ({ input, interrupt }) => runClientTool('setLayerStyle', input, interrupt) }),
    setLayerLabel: tool({ ...toolBase('setLayerLabel'), handler: async ({ input, interrupt }) => runClientTool('setLayerLabel', input, interrupt) }),
    removeLayer: tool({ ...toolBase('removeLayer'), handler: async ({ input, interrupt }) => runClientTool('removeLayer', input, interrupt) }),
    setView: tool({ ...toolBase('setView'), handler: async ({ input, interrupt }) => runClientTool('setView', input, interrupt) })
  } satisfies Record<ToolName, ReturnType<ToolFactory>>;
}

export const agent = new Agent(scope, 'agent', {
  systemPrompt: buildSystemPrompt(catalog),
  model: { deployed: bedrockModel, ...(llmMode === 'bedrock' ? { local: bedrockModel } : {}) },
  tools,
  streamingMode: 'token',
  maxLlmCalls: agentConfig.maxLlmCalls,
  maxToolIterations: agentConfig.maxToolIterations
});
