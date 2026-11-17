import { z } from 'zod';
import { bboxSchema } from './catalog-schema.js';
import { clipDistinct, clipTexts } from './clip.js';
import { dataConfig, mapConfig, queryConfig, resultConfig, styleConfig, toolConfig } from './config.js';
import {
  appliedStyleSchema,
  columnTypeSchema,
  geometryFamilySchema,
  labelSpecSchema,
  layerIdPattern,
  styleSpecSchema,
  viewTargetSchema
} from './mapSpec.js';

/**
 * The protocol of the six tools the model calls: their input schemas, the interrupt the backend raises to hand a call
 * to the browser, the schemas of what the browser answers, and the size limits of those answers. The tools run in the
 * browser; the backend validates the input and the answer with the schemas here.
 * Descriptions, messages and hints are short English sentences: the model reads them.
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

/*
 * The tools. The model fills these in, so the schemas are small: a few fields, and free text only in `name` and `sql`.
 * Each `.describe()` is passed to the model as the parameter's description.
 */

export const toolNameSchema = z.enum(['runQuery', 'addLayer', 'setLayerStyle', 'setLayerLabel', 'removeLayer', 'setView']);

export type ToolName = z.infer<typeof toolNameSchema>;

const layerIdSchema = z
  .string()
  .max(styleConfig.maxLayerIdChars)
  .regex(layerIdPattern, 'A layer id looks like "L1".')
  .describe('Id of an existing layer, such as "L1".');

const sqlSchema = z.string().min(1).max(queryConfig.maxSqlChars);

const runQueryInputSchema = z.strictObject({
  sql: sqlSchema.describe('One SELECT or WITH statement over the views. Returns the values as rows.')
});

const addLayerInputSchema = z.strictObject({
  name: z.string().min(1).max(toolConfig.maxLayerNameChars).describe('Short layer name for the layer list.'),
  sql: sqlSchema.describe('One SELECT or WITH statement with exactly one geometry column named geom.'),
  style: styleSpecSchema.optional().describe('How to draw the layer. Left out: a single colour (or the replaced layer\'s style).'),
  label: labelSpecSchema.optional().describe('Labels from a column. Left out: no labels.'),
  replaceLayerId: layerIdSchema.optional().describe('Layer to replace. A style or label given here wins; else the old ones stay if they fit.'),
  zoomTo: z.boolean().optional().describe('Move the map to the layer. Left out: true.')
});

const setLayerStyleInputSchema = z.strictObject({
  layerId: layerIdSchema,
  style: styleSpecSchema.describe('The new style. It replaces the old one.')
});

const setLayerLabelInputSchema = z.strictObject({
  layerId: layerIdSchema,
  label: labelSpecSchema.nullable().describe('The labels, or null to remove them.')
});

const removeLayerInputSchema = z.strictObject({ layerId: layerIdSchema });

const setViewInputSchema = z.strictObject({
  target: viewTargetSchema.describe('Where to look: a layer, a bbox, a center and zoom, or a query for a place.')
});

export const toolInputSchemas = {
  runQuery: runQueryInputSchema,
  addLayer: addLayerInputSchema,
  setLayerStyle: setLayerStyleInputSchema,
  setLayerLabel: setLayerLabelInputSchema,
  removeLayer: removeLayerInputSchema,
  setView: setViewInputSchema
} satisfies Record<ToolName, z.ZodType>;

export const toolDescriptions = {
  runQuery:
    `Runs a SELECT query and returns up to ${queryConfig.maxRows} rows. Use it to look up values or check a result, not to draw.`,
  addLayer: 'Draws the result of a query on the map as a new layer. Use it to show data on the map.',
  setLayerStyle: 'Changes how an existing layer is coloured and sized. Use it for colours, classes and symbol sizes.',
  setLayerLabel: 'Shows or hides the labels of an existing layer. Use it to name the features on the map.',
  removeLayer: 'Removes a layer from the map. Use it when the user no longer wants the layer.',
  setView: 'Moves the map to a layer, a box, a point or a place found by a query.'
} satisfies Record<ToolName, string>;

export type ToolInputs = { [Name in ToolName]: z.infer<(typeof toolInputSchemas)[Name]> };

/** What the backend raises as the interrupt reason, and the browser executes: discriminated by `tool`. */
export const clientToolRequestSchema = z.discriminatedUnion('tool', [
  z.strictObject({ tool: z.literal('runQuery'), input: runQueryInputSchema }),
  z.strictObject({ tool: z.literal('addLayer'), input: addLayerInputSchema }),
  z.strictObject({ tool: z.literal('setLayerStyle'), input: setLayerStyleInputSchema }),
  z.strictObject({ tool: z.literal('setLayerLabel'), input: setLayerLabelInputSchema }),
  z.strictObject({ tool: z.literal('removeLayer'), input: removeLayerInputSchema }),
  z.strictObject({ tool: z.literal('setView'), input: setViewInputSchema })
]);

export type ClientToolRequest = z.infer<typeof clientToolRequestSchema>;

export type ToolInput = ClientToolRequest['input'];

const interruptPrefix = 'client:';

/** The fixed name of the interrupt of a tool. */
export function interruptName(tool: ToolName): string {
  return `${interruptPrefix}${tool}`;
}

/*
 * What the model receives when a tool succeeds. The schemas check the structure only: a list or text that is too long
 * is not a reason to reject an answer (the layer may already be on the map), `fitToolResult` cuts it.
 */

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

const bytesOf = (value: object): number => utf8Bytes(JSON.stringify(value));

const jsonValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const resultColumnsSchema = z.array(z.strictObject({ name: z.string(), type: columnTypeSchema }));

const columnCountSchema = z.number().int().nonnegative().optional();

const longitudeLatitudeSchema = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);

export const runQueryDataSchema = z.strictObject({
  columns: resultColumnsSchema,
  /** How many columns the query had, when the list was cut to `toolConfig.maxQueryColumns`. */
  columnCount: columnCountSchema,
  rows: z.array(z.record(z.string(), jsonValueSchema)).max(queryConfig.maxRows),
  /** The number of rows the query returned (before any were dropped to fit the size limit). */
  rowCount: z.number().int().nonnegative(),
  truncated: z.boolean()
});

export const addLayerDataSchema = z.strictObject({
  layerId: z.string().max(styleConfig.maxLayerIdChars),
  name: z.string(),
  featureCount: z.number().int().nonnegative(),
  geometryType: geometryFamilySchema,
  /** The first columns (`mapConfig.summaryMaxColumns`; a name too long to use is left out). */
  columns: resultColumnsSchema,
  /** How many columns the layer has (set when the answer is fitted). */
  columnCount: columnCountSchema,
  bbox: bboxSchema,
  applied: appliedStyleSchema,
  warnings: z.array(z.string()).optional()
});

export const setLayerStyleDataSchema = z.strictObject({
  layerId: z.string().max(styleConfig.maxLayerIdChars),
  applied: appliedStyleSchema,
  warnings: z.array(z.string()).optional()
});

export const setLayerLabelDataSchema = z.strictObject({
  layerId: z.string().max(styleConfig.maxLayerIdChars),
  label: labelSpecSchema.nullable()
});

export const removeLayerDataSchema = z.strictObject({
  removed: z.string().max(styleConfig.maxLayerIdChars),
  remaining: z.array(z.string().max(styleConfig.maxLayerIdChars))
});

export const setViewDataSchema = z.strictObject({
  center: longitudeLatitudeSchema,
  zoom: z.number().min(styleConfig.zoom.min).max(styleConfig.zoom.max)
});

export const toolResultSchemas = {
  runQuery: runQueryDataSchema,
  addLayer: addLayerDataSchema,
  setLayerStyle: setLayerStyleDataSchema,
  setLayerLabel: setLayerLabelDataSchema,
  removeLayer: removeLayerDataSchema,
  setView: setViewDataSchema
} satisfies Record<ToolName, z.ZodType>;

export type RunQueryData = z.infer<typeof runQueryDataSchema>;
export type AddLayerData = z.infer<typeof addLayerDataSchema>;
export type SetLayerStyleData = z.infer<typeof setLayerStyleDataSchema>;

export type ToolResultData = { [Name in ToolName]: z.infer<(typeof toolResultSchemas)[Name]> }[ToolName];

const invalidResultMessage = 'The browser returned an invalid result.';

/**
 * Reads the browser's answer (`JSON.stringify` of a `ClientToolResult`). A well-formed error is passed on as sent; anything
 * else that is not a result with data of `dataSchema` is an `ENGINE_UNAVAILABLE` error. Never throws.
 */
export function parseClientToolResult<T>(raw: string, dataSchema: z.ZodType<T>): ClientToolResult<T> {
  const resultSchema = z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), data: dataSchema }),
    z.strictObject({ ok: z.literal(false), error: toolErrorSchema })
  ]);
  try {
    const result = resultSchema.safeParse(JSON.parse(raw));
    if (result.success) return result.data;
  } catch {
    // Not JSON: the same error as a result of the wrong shape.
  }
  return toolError('ENGINE_UNAVAILABLE', invalidResultMessage);
}

/*
 * Size limits. The answer is stored twice in one row of the conversation store (measured limit about 200 KB), so every
 * result is kept within `resultConfig.maxToolResultBytes` and all the results of one response within `maxTotalResultBytes`.
 * The caps of columns, warnings and texts are the ones of the map summary (`mapConfig.summary*`), so the model sees
 * a layer the same way in the answer and in `<map_state>`.
 */

const ellipsis = '…';

/** Cuts a text to `maxChars` characters (code points), ending in "…". */
function truncateText(text: string, maxChars: number): string {
  const chars = Array.from(text);
  return chars.length <= maxChars ? text : `${chars.slice(0, Math.max(maxChars - 1, 0)).join('')}${ellipsis}`;
}

/** The largest `n` in `low..high` for which `fits(n)` holds (`fits` is true up to some point, then false), or `low - 1` when none does. */
function largestFitting(low: number, high: number, fits: (n: number) => boolean): number {
  let best = low - 1;
  let from = low;
  let to = high;
  while (from <= to) {
    const middle = Math.floor((from + to) / 2);
    if (fits(middle)) {
      best = middle;
      from = middle + 1;
    } else {
      to = middle - 1;
    }
  }
  return best;
}

type OkResult<T> = { ok: true; data: T };

type ResultColumn = RunQueryData['columns'][number];

/** The columns that are listed: a name too long to use as a column is left out, not cut (a cut name would not be a column), and at most `maxColumns` are kept. */
const listedColumns = (columns: readonly ResultColumn[], maxColumns: number): ResultColumn[] =>
  columns.filter(({ name }) => name.length <= mapConfig.summaryMaxColumnNameChars).slice(0, maxColumns);

const clippedWarnings = (warnings: readonly string[]): string[] =>
  warnings.slice(0, mapConfig.summaryMaxWarnings).map((warning) => truncateText(warning, mapConfig.summaryMaxWarningChars));

/** The category values are cut the way `<map_state>` cuts them (`shared/clip.ts`), so the same value reads the same. */
function clippedApplied(applied: AddLayerData['applied']): AddLayerData['applied'] {
  if (applied.type !== 'categorized') return applied;
  const shown = clipTexts(applied.categories.map(({ value }) => value), mapConfig.summaryMaxStringChars);
  return {
    ...applied,
    categories: applied.categories
      .slice(0, dataConfig.classification.maxCategories)
      .map((category) => ({ ...category, value: shown.get(category.value) ?? category.value })),
    warnings: clippedWarnings(applied.warnings)
  };
}

const withWarnings = (warnings: readonly string[] | undefined): { warnings?: string[] } => (warnings === undefined ? {} : { warnings: clippedWarnings(warnings) });

const boundAddLayer = (data: AddLayerData): AddLayerData => ({
  ...data,
  name: truncateText(data.name, toolConfig.maxLayerNameChars),
  columns: listedColumns(data.columns, mapConfig.summaryMaxColumns),
  columnCount: data.columnCount ?? data.columns.length,
  applied: clippedApplied(data.applied),
  ...withWarnings(data.warnings)
});

const boundSetLayerStyle = (data: SetLayerStyleData): SetLayerStyleData => ({
  ...data,
  applied: clippedApplied(data.applied),
  ...withWarnings(data.warnings)
});

/** At most `maxQueryColumns` columns, in the columns and in every row; a name that is too long is cut, and the cut names stay apart (in both). */
function boundRunQuery(data: RunQueryData): RunQueryData {
  const kept = data.columns.slice(0, toolConfig.maxQueryColumns);
  const shown = clipDistinct(kept.map(({ name }) => name), mapConfig.summaryMaxColumnNameChars);
  const unchanged = kept.length === data.columns.length && kept.every(({ name }, i) => name === shown[i]);
  if (unchanged) return data;
  return {
    ...data,
    columns: kept.map(({ type }, i) => ({ name: shown[i], type })),
    columnCount: data.columnCount ?? data.columns.length,
    rows: data.rows.map((row) => Object.fromEntries(kept.map(({ name }, i) => [shown[i], row[name] ?? null])))
  };
}

function boundData(data: ToolResultData): ToolResultData {
  if ('rows' in data) return boundRunQuery(data);
  if ('bbox' in data) return boundAddLayer(data);
  if ('applied' in data) return boundSetLayerStyle(data);
  if ('remaining' in data) return { ...data, remaining: data.remaining.slice(0, toolConfig.maxResultLayers) };
  return data;
}

function fitRunQuery(data: RunQueryData, maxBytes: number): OkResult<RunQueryData> {
  const withRows = (rows: RunQueryData['rows']): OkResult<RunQueryData> => ({ ok: true, data: { ...data, rows, truncated: true } });
  const fits = (result: OkResult<RunQueryData>): boolean => bytesOf(result) <= maxBytes;

  const keptRows = largestFitting(1, data.rows.length - 1, (n) => fits(withRows(data.rows.slice(0, n))));
  if (keptRows >= 1) return withRows(data.rows.slice(0, keptRows));

  // Not even one row fits: keep the first row and cut its long texts.
  const [first] = data.rows;
  if (first === undefined) return withRows([]);
  const cutRow = (maxChars: number): RunQueryData['rows'] => [
    Object.fromEntries(Object.entries(first).map(([key, value]) => [key, typeof value === 'string' ? truncateText(value, maxChars) : value]))
  ];
  const longest = Math.max(1, ...Object.values(first).map((value) => (typeof value === 'string' ? Array.from(value).length : 0)));
  const maxChars = largestFitting(1, longest, (n) => fits(withRows(cutRow(n))));
  return withRows(maxChars >= 1 ? cutRow(maxChars) : []);
}

/**
 * The layer answers (`addLayer`, `setLayerStyle`) are bounded by the caps above; if one is still too large, the parts the
 * model needs least go, one by one: the categories beyond a few, the column list, the warnings. The answer stays an `ok`
 * result with the layer id: the layer is on the map.
 */
function shrinkLayerData<T extends AddLayerData | SetLayerStyleData>(data: T, maxBytes: number): OkResult<T> {
  const steps: ((data: T) => T)[] = [
    (value) =>
      value.applied.type === 'categorized'
        ? { ...value, applied: { ...value.applied, categories: value.applied.categories.slice(0, mapConfig.summaryShrunkCategories) } }
        : value,
    (value) => ('columns' in value ? { ...value, columns: [] } : value),
    (value) => ({ ...value, warnings: [] })
  ];
  let current = data;
  for (const step of steps) {
    if (bytesOf({ ok: true, data: current }) <= maxBytes) break;
    current = step(current);
  }
  return { ok: true, data: current };
}

function fitError(result: { ok: false; error: ToolError }, maxBytes: number): ClientToolResult<ToolResultData> {
  const { error } = result;
  const cut = (maxChars: number): ClientToolResult<ToolResultData> => ({
    ok: false,
    error: {
      ...error,
      message: truncateText(error.message, maxChars),
      ...(error.hint === undefined ? {} : { hint: truncateText(error.hint, maxChars) })
    }
  });
  const longest = Math.max(1, Array.from(error.message).length, Array.from(error.hint ?? '').length);
  return cut(Math.max(1, largestFitting(1, longest, (n) => bytesOf(cut(n)) <= maxBytes)));
}

/**
 * Bounds one result: the caps on its lists and texts (see above), then the byte limit `maxBytes` (UTF-8 bytes of its
 * JSON). A `runQuery` result drops rows from the end (the columns stay, `truncated` becomes true, `rowCount` is
 * unchanged) and, when one row is still too large, cuts its long texts with "…". An error gets a shorter message and
 * hint. The other results are small after the caps, and the layer answers shrink further only if they must.
 */
export function fitToolResult(
  result: ClientToolResult<ToolResultData>,
  maxBytes: number = resultConfig.maxToolResultBytes
): ClientToolResult<ToolResultData> {
  if (!result.ok) return bytesOf(result) <= maxBytes ? result : fitError(result, maxBytes);
  const data = boundData(result.data);
  if (bytesOf({ ok: true, data }) <= maxBytes) return { ok: true, data };
  if ('rows' in data) return fitRunQuery(data, maxBytes);
  if ('bbox' in data) return shrinkLayerData(data, maxBytes);
  if ('applied' in data) return shrinkLayerData(data, maxBytes);
  return { ok: true, data };
}

const rowsOf = (result: ClientToolResult<ToolResultData>): number => (result.ok && 'rows' in result.data ? result.data.rows.length : 0);

/**
 * Keeps every result within `maxEachBytes` and all of them within `maxTotalBytes`. When the sum is still over, the
 * `runQuery` results shrink to the same share of their size (so the larger ones lose more bytes), the largest share
 * that fits. Only `runQuery` results shrink here: the other results are small after `fitToolResult` (a layer answer is
 * about 2-3 KiB), so they alone pass the total only with more than about 20 results in one response, far more than a turn
 * makes; then they are returned as they are, over the total.
 */
export function fitToolResults(
  results: readonly ClientToolResult<ToolResultData>[],
  maxTotalBytes: number = resultConfig.maxTotalResultBytes,
  maxEachBytes: number = resultConfig.maxToolResultBytes
): ClientToolResult<ToolResultData>[] {
  const fitted = results.map((result) => fitToolResult(result, maxEachBytes));
  const sizes = fitted.map(bytesOf);
  const totalOf = (list: readonly ClientToolResult<ToolResultData>[]): number => list.reduce((sum, result) => sum + bytesOf(result), 0);
  if (totalOf(fitted) <= maxTotalBytes) return fitted;

  const shareScale = 1000;
  const scaled = (share: number): ClientToolResult<ToolResultData>[] =>
    fitted.map((result, index) => (rowsOf(result) > 0 ? fitToolResult(result, Math.floor((sizes[index] * share) / shareScale)) : result));
  const share = largestFitting(0, shareScale, (n) => totalOf(scaled(n)) <= maxTotalBytes);
  return scaled(Math.max(share, 0));
}
