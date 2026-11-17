import { z } from 'zod';

/**
 * What a browser tool answers to the agent. The tool input schemas are added here later (Task 4.1).
 * Messages and hints are short English sentences: the model reads them.
 */

export const toolErrorCodeSchema = z.enum([
  'SQL_REJECTED',
  'SQL_ERROR',
  'TIMEOUT',
  'TOO_MANY_FEATURES',
  'NO_GEOMETRY',
  'MIXED_GEOMETRY',
  'UNKNOWN_COLUMN',
  'UNKNOWN_LAYER',
  'INVALID_STYLE',
  'ENGINE_UNAVAILABLE',
  'SESSION_RESET'
]);

export type ToolErrorCode = z.infer<typeof toolErrorCodeSchema>;

export const toolErrorSchema = z.strictObject({
  code: toolErrorCodeSchema,
  message: z.string(),
  hint: z.string().optional()
});

export type ToolError = z.infer<typeof toolErrorSchema>;

export type ClientToolResult<T> = { ok: true; data: T } | { ok: false; error: ToolError };

/** A failed result; `hint` is left out of the object when there is none. */
export function toolError(code: ToolErrorCode, message: string, hint?: string): { ok: false; error: ToolError } {
  return { ok: false, error: hint === undefined ? { code, message } : { code, message, hint } };
}
