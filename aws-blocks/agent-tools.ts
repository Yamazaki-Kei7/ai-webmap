import type { z } from 'zod';
import { datasetIds } from '../shared/datasets.js';
import { validateSql } from '../shared/sqlGuard.js';
import {
  clientToolRequestSchema,
  interruptName,
  parseClientToolResult,
  toolError,
  toolResultSchemas,
  type ClientToolRequest,
  type ClientToolResult,
  type ToolInputs,
  type ToolName,
  type ToolResultData
} from '../shared/toolProtocol.js';

/**
 * What a tool does on the backend: the six tools run in the browser, so a handler only checks its input and hands the
 * call over with an interrupt. The browser answers with a JSON string, which is checked before the model sees it.
 */

/** The `interrupt` the Agent block gives a handler; it returns the browser's answer (a string). */
export type Interrupt = (params: { name: string; reason: ClientToolRequest }) => string;

/**
 * Per tool settings of the Agent block. Values from the datasets are data, not instructions: the block wraps the result
 * of a tool that carries them as untrusted data. `runQuery` returns rows; `addLayer` and `setLayerStyle` return the
 * categories and column names of the layer. The other results hold ids, numbers and the model's own style.
 */
export const toolSettings = {
  runQuery: { untrustedOutput: true },
  addLayer: { untrustedOutput: true },
  setLayerStyle: { untrustedOutput: true },
  setLayerLabel: { untrustedOutput: false },
  removeLayer: { untrustedOutput: false },
  setView: { untrustedOutput: false }
} as const satisfies Record<ToolName, { untrustedOutput: boolean }>;

/** The SQL a call carries, if any: the text the SQL guard must see before the browser does. */
function sqlOf(request: ClientToolRequest): string | undefined {
  switch (request.tool) {
    case 'runQuery':
    case 'addLayer':
      return request.input.sql;
    case 'setView':
      return request.input.target.type === 'query' ? request.input.target.sql : undefined;
    case 'setLayerStyle':
    case 'setLayerLabel':
    case 'removeLayer':
      return undefined;
  }
}

const invalidInputMessage = 'The input does not match the tool schema.';

/**
 * Runs one tool call. Never throws: every failure is a tool error for the model. Order matters: the handler is run again
 * from the top on every resume, so nothing with a side effect comes before `interrupt`, and `interrupt` is called once, last.
 * A call the SQL guard rejects is answered at once, without a round trip to the browser.
 */
export function runClientTool<Name extends ToolName>(name: Name, input: ToolInputs[Name], interrupt: Interrupt): ClientToolResult<ToolResultData> {
  const request = clientToolRequestSchema.safeParse({ tool: name, input });
  if (!request.success) return toolError('INVALID_INPUT', invalidInputMessage);

  const sql = sqlOf(request.data);
  if (sql !== undefined) {
    const guarded = validateSql(sql, datasetIds);
    if (!guarded.ok) return toolError('SQL_REJECTED', guarded.reason);
  }

  const raw = interrupt({ name: interruptName(request.data.tool), reason: request.data });
  const dataSchema: z.ZodType<ToolResultData> = toolResultSchemas[request.data.tool];
  return parseClientToolResult(raw, dataSchema);
}
