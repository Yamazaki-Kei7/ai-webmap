import { llmModeEnvName, parseLlmMode, type LlmMode } from './llm-mode.js';

/** Read once at start-up: an invalid value stops the backend from loading, with a clear message. */
export const llmMode: LlmMode = parseLlmMode(process.env[llmModeEnvName]);
