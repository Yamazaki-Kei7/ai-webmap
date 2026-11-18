import { z } from 'zod';

/**
 * Which model the local agent uses. Backend only: `shared/` is bundled into the browser.
 * On a deployed app the variable is never set, so the mode is `bedrock`.
 */
export const llmModeEnvName = 'AGENT_LOCAL_MODEL';

export const llmModes = ['bedrock', 'canned'] as const;
export const defaultLlmMode = 'bedrock';

const llmModeSchema = z.enum(llmModes);
export type LlmMode = z.infer<typeof llmModeSchema>;

/** Unset gives the default; any other unknown value is an error, never a silent default. */
export function parseLlmMode(raw: string | undefined): LlmMode {
  if (raw === undefined) return defaultLlmMode;
  const parsed = llmModeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${llmModeEnvName} must be one of ${llmModes.join(', ')} (got "${raw}"); unset it for ${defaultLlmMode}.`);
  }
  return parsed.data;
}
