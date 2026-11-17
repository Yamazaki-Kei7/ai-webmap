import type { JSONValue } from '@aws-blocks/bb-agent';
import { promptExamples } from '../shared/promptExamples.js';
import type { ToolInputs, ToolName } from '../shared/toolProtocol.js';

/**
 * The inputs the canned model (local E2E, no Bedrock) gives each tool: valid ones, so the canned round trip goes through
 * the real validation and the SQL guard. Taken from the prompt examples where there is one; the other two are written here.
 */
const writtenExamples: Partial<{ [Name in ToolName]: ToolInputs[Name] }> = {
  setLayerLabel: { layerId: 'L1', label: { column: 'station_name' } },
  removeLayer: { layerId: 'L1' }
};

function promptExampleInput(tool: ToolName): ToolInputs[ToolName] | undefined {
  for (const example of promptExamples) {
    const call = example.calls.find((candidate) => candidate.tool === tool);
    if (call) return call.input;
  }
  return undefined;
}

/**
 * The canned provider fills every field of the schema with a placeholder, optional ones too, and the example wins only
 * for the fields it names. An optional field whose placeholder ("sample") the schema rejects must be named as well, or
 * the call fails validation before the handler runs (the model's call is dropped with no interrupt): `replaceLayerId` must
 * look like "L1", and a label's colours must be hex colours.
 */
const placeholderFixes: Partial<{ [Name in ToolName]: Record<string, JSONValue> }> = {
  addLayer: { replaceLayerId: 'L1', label: { column: 'station_name' } }
};

export function cannedExample(tool: ToolName): Record<string, JSONValue> {
  const input = promptExampleInput(tool) ?? writtenExamples[tool];
  if (input === undefined) throw new Error(`No canned example for the tool ${tool}.`);
  return { ...input, ...placeholderFixes[tool] };
}
