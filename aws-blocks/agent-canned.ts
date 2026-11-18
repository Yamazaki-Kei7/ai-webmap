import type { JSONValue } from '@aws-blocks/bb-agent';
import { promptExamples } from '../shared/promptExamples.js';
import type { ToolInputs, ToolName } from '../shared/toolProtocol.js';

/**
 * The inputs the canned model (local E2E, no Bedrock) gives each tool: valid ones, so the canned round trip goes through
 * the real validation and the SQL guard. Every value comes from the prompt examples (`shared/promptExamples.ts`): the tools
 * the examples call are given their input as it is; the other two are built from the layer id and the label of the
 * `addLayer` examples, so no second copy of an example value is kept here.
 */
const exampleCalls = promptExamples.flatMap(({ calls }) => calls);

const addLayerInputs = exampleCalls.flatMap((call) => (call.tool === 'addLayer' ? [call.input] : []));

const replaceLayerId = addLayerInputs.find(({ replaceLayerId: id }) => id !== undefined)?.replaceLayerId;
const label = addLayerInputs.find(({ label: spec }) => spec !== undefined)?.label;
if (replaceLayerId === undefined || label === undefined || label === null) {
  throw new Error('The prompt examples need an addLayer call with replaceLayerId and one with a label: the canned inputs are built from them.');
}

const derivedExamples: Partial<{ [Name in ToolName]: ToolInputs[Name] }> = {
  setLayerLabel: { layerId: replaceLayerId, label },
  removeLayer: { layerId: replaceLayerId }
};

function promptExampleInput(tool: ToolName): ToolInputs[ToolName] | undefined {
  return exampleCalls.find((call) => call.tool === tool)?.input;
}

/**
 * The canned provider fills every field of the schema with a placeholder, optional ones too, and the example wins only
 * for the fields it names. An optional field whose placeholder ("sample") the schema rejects must be named as well, or
 * the call fails validation before the handler runs (the model's call is dropped with no interrupt): `replaceLayerId` must
 * look like "L1", and a label's colours must be hex colours.
 */
const placeholderFixes: Partial<{ [Name in ToolName]: Record<string, JSONValue> }> = {
  addLayer: { replaceLayerId, label }
};

export function cannedExample(tool: ToolName): Record<string, JSONValue> {
  const input = promptExampleInput(tool) ?? derivedExamples[tool];
  if (input === undefined) throw new Error(`No canned example for the tool ${tool}.`);
  return { ...input, ...placeholderFixes[tool] };
}
