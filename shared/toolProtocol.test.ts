import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { dataConfig, mapConfig, queryConfig, resultConfig, styleConfig, toolConfig } from './config';
import {
  addLayerDataSchema,
  clientToolRequestSchema,
  fitToolResult,
  fitToolResults,
  interruptName,
  parseClientToolResult,
  removeLayerDataSchema,
  runQueryDataSchema,
  setLayerLabelDataSchema,
  setLayerStyleDataSchema,
  setViewDataSchema,
  toolDescriptions,
  toolError,
  toolErrorCodeSchema,
  toolErrorSchema,
  toolInputSchemas,
  toolNameSchema,
  toolResultSchemas,
  type AddLayerData,
  type ClientToolResult,
  type RunQueryData,
  type ToolName,
  type ToolResultData
} from './toolProtocol';

const encoder = new TextEncoder();
const bytesOf = (value: object): number => encoder.encode(JSON.stringify(value)).length;

describe('toolError', () => {
  it('builds a failed result with the hint', () => {
    expect(toolError('TIMEOUT', 'too slow', 'filter')).toEqual({ ok: false, error: { code: 'TIMEOUT', message: 'too slow', hint: 'filter' } });
  });

  it('has no hint key when there is no hint', () => {
    expect(toolError('SQL_ERROR', 'bad')).toEqual({ ok: false, error: { code: 'SQL_ERROR', message: 'bad' } });
    expect('hint' in toolError('SQL_ERROR', 'bad').error).toBe(false);
  });

  it('is accepted by the error schema', () => {
    expect(toolErrorSchema.safeParse(toolError('NO_GEOMETRY', 'm', 'h').error).success).toBe(true);
  });
});

describe('toolErrorCodeSchema', () => {
  it('lists the eleven codes of the protocol', () => {
    expect(toolErrorCodeSchema.options).toHaveLength(12);
    expect(toolErrorCodeSchema.safeParse('NOPE').success).toBe(false);
  });
});

const validInputs: Record<ToolName, object> = {
  runQuery: { sql: 'SELECT 1' },
  addLayer: {
    name: '駅',
    sql: 'SELECT geom FROM stations',
    style: { type: 'single', color: '#ff0000' },
    label: { column: 'station_name' },
    replaceLayerId: 'L1',
    zoomTo: false
  },
  setLayerStyle: { layerId: 'L2', style: { type: 'categorized', column: 'operator_type' } },
  setLayerLabel: { layerId: 'L2', label: null },
  removeLayer: { layerId: 'L10' },
  setView: { target: { type: 'center', center: [139.7, 35.7], zoom: 10 } }
};

const toolNames = toolNameSchema.options;

describe('toolInputSchemas', () => {
  it('has a schema and a description for each tool', () => {
    expect(Object.keys(toolInputSchemas).sort()).toEqual([...toolNames].sort());
    expect(Object.keys(toolDescriptions).sort()).toEqual([...toolNames].sort());
    expect(Object.keys(toolResultSchemas).sort()).toEqual([...toolNames].sort());
  });

  it.each(toolNames)('%s accepts a valid example', (tool) => {
    expect(toolInputSchemas[tool].safeParse(validInputs[tool]).success).toBe(true);
  });

  it('accepts addLayer with only the required fields', () => {
    expect(toolInputSchemas.addLayer.safeParse({ name: 'a', sql: 'SELECT 1' }).success).toBe(true);
  });

  it.each(toolNames)('%s rejects an unknown key', (tool) => {
    expect(toolInputSchemas[tool].safeParse({ ...validInputs[tool], extra: 1 }).success).toBe(false);
  });

  it.each(['l1', 'L', 'L1x', '1', 'L-1', ' L1', 'LL1'])('rejects the layer id %j', (layerId) => {
    expect(toolInputSchemas.removeLayer.safeParse({ layerId }).success).toBe(false);
    expect(toolInputSchemas.setLayerLabel.safeParse({ layerId, label: null }).success).toBe(false);
    expect(toolInputSchemas.addLayer.safeParse({ name: 'a', sql: 'SELECT 1', replaceLayerId: layerId }).success).toBe(false);
  });

  it('bounds the layer name', () => {
    const add = (name: string) => toolInputSchemas.addLayer.safeParse({ name, sql: 'SELECT 1' }).success;
    expect(add('あ'.repeat(toolConfig.maxLayerNameChars))).toBe(true);
    expect(add('あ'.repeat(toolConfig.maxLayerNameChars + 1))).toBe(false);
    expect(add('')).toBe(false);
  });

  it('bounds the SQL', () => {
    const run = (sql: string) => toolInputSchemas.runQuery.safeParse({ sql }).success;
    expect(run('x'.repeat(queryConfig.maxSqlChars))).toBe(true);
    expect(run('x'.repeat(queryConfig.maxSqlChars + 1))).toBe(false);
    expect(run('')).toBe(false);
    expect(toolInputSchemas.addLayer.safeParse({ name: 'a', sql: 'x'.repeat(queryConfig.maxSqlChars + 1) }).success).toBe(false);
  });

  it('rejects a bad style, label or target with the mapSpec schemas', () => {
    expect(toolInputSchemas.setLayerStyle.safeParse({ layerId: 'L1', style: { type: 'single', color: 'red' } }).success).toBe(false);
    expect(toolInputSchemas.setLayerLabel.safeParse({ layerId: 'L1', label: { size: 3 } }).success).toBe(false);
    expect(toolInputSchemas.setView.safeParse({ target: { type: 'layer' } }).success).toBe(false);
    expect(toolInputSchemas.setLayerStyle.safeParse({ layerId: 'L1' }).success).toBe(false);
  });

  it.each(toolNames)('%s describes every parameter in under 100 characters', (tool) => {
    const { properties } = z.toJSONSchema(toolInputSchemas[tool]);
    expect(properties).toBeDefined();
    for (const [name, property] of Object.entries(properties ?? {})) {
      const description = typeof property === 'object' ? property.description : undefined;
      expect(description, `${tool}.${name}`).toBeTruthy();
      expect(description?.length ?? 0, `${tool}.${name}`).toBeLessThan(100);
    }
  });

  it.each(toolNames)('describes %s in one or two short English sentences', (tool) => {
    const description = toolDescriptions[tool];
    expect(description.length).toBeLessThan(160);
    expect(description.match(/\./g)?.length ?? 0).toBeLessThanOrEqual(2);
  });
});

describe('clientToolRequestSchema', () => {
  it.each(toolNames)('accepts %s with its own input', (tool) => {
    const parsed = clientToolRequestSchema.safeParse({ tool, input: validInputs[tool] });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.tool).toBe(tool);
  });

  it('discriminates by tool: the input of another tool is rejected', () => {
    expect(clientToolRequestSchema.safeParse({ tool: 'removeLayer', input: validInputs.runQuery }).success).toBe(false);
    expect(clientToolRequestSchema.safeParse({ tool: 'runQuery', input: validInputs.removeLayer }).success).toBe(false);
    expect(clientToolRequestSchema.safeParse({ tool: 'unknownTool', input: {} }).success).toBe(false);
    expect(clientToolRequestSchema.safeParse({ tool: 'runQuery', input: validInputs.runQuery, extra: 1 }).success).toBe(false);
  });

  it('narrows the input type by tool', () => {
    const parsed = clientToolRequestSchema.parse({ tool: 'removeLayer', input: { layerId: 'L3' } });
    if (parsed.tool === 'removeLayer') expect(parsed.input.layerId).toBe('L3');
    else throw new Error('expected removeLayer');
  });
});

describe('interruptName', () => {
  it('is the fixed client:tool name', () => {
    expect(interruptName('runQuery')).toBe('client:runQuery');
    expect(interruptName('runQuery')).toBe(interruptName('runQuery'));
  });

  it('differs between tools', () => {
    expect(new Set(toolNames.map(interruptName)).size).toBe(toolNames.length);
  });
});

const columns = [{ name: 'a', type: 'string' as const }];
const runQueryData: RunQueryData = { columns, rows: [{ a: 'x' }], rowCount: 1, truncated: false };
const applied = { type: 'single' as const, color: '#ff0000' };

const validData: Record<ToolName, object> = {
  runQuery: runQueryData,
  addLayer: { layerId: 'L1', name: 'n', featureCount: 3, geometryType: 'point', columns, bbox: [1, 2, 3, 4], applied, warnings: ['w'] },
  setLayerStyle: { layerId: 'L1', applied },
  setLayerLabel: { layerId: 'L1', label: { column: 'a' } },
  removeLayer: { removed: 'L1', remaining: ['L2'] },
  setView: { center: [139.7, 35.7], zoom: 9 }
};

describe('result data schemas', () => {
  it.each(toolNames)('%s accepts its valid result', (tool) => {
    expect(toolResultSchemas[tool].safeParse(validData[tool]).success).toBe(true);
  });

  it('accepts a label that was removed', () => {
    expect(setLayerLabelDataSchema.safeParse({ layerId: 'L1', label: null }).success).toBe(true);
  });

  it('rejects unknown keys, bad types and out-of-range values', () => {
    expect(runQueryDataSchema.safeParse({ ...runQueryData, extra: 1 }).success).toBe(false);
    expect(runQueryDataSchema.safeParse({ ...runQueryData, rows: [{ a: { nested: 1 } }] }).success).toBe(false);
    expect(runQueryDataSchema.safeParse({ ...runQueryData, rows: Array.from({ length: queryConfig.maxRows + 1 }, () => ({ a: 1 })) }).success).toBe(false);
    expect(setViewDataSchema.safeParse({ center: [200, 0], zoom: 3 }).success).toBe(false);
    expect(setViewDataSchema.safeParse({ center: [0, 0], zoom: styleConfig.zoom.max + 1 }).success).toBe(false);
    expect(addLayerDataSchema.safeParse({ ...validData.addLayer, geometryType: 'circle' }).success).toBe(false);
    expect(addLayerDataSchema.safeParse({ ...validData.addLayer, bbox: [3, 0, 1, 0] }).success).toBe(false);
    expect(setLayerStyleDataSchema.safeParse({ layerId: 'L1', applied: { type: 'single', color: 'red' } }).success).toBe(false);
  });

  it('accepts long lists and texts: bounding them is the job of fitToolResult', () => {
    const longName = 'x'.repeat(120);
    const wide = Array.from({ length: 80 }, (_, i) => ({ name: `${longName}${i}`, type: 'number' as const }));
    expect(addLayerDataSchema.safeParse({ ...validData.addLayer, name: longName, columns: wide, warnings: Array.from({ length: 9 }, () => longName) }).success).toBe(true);
    expect(removeLayerDataSchema.safeParse({ removed: 'L1', remaining: Array.from({ length: 500 }, () => 'L1') }).success).toBe(true);
  });
});

const longText = '長'.repeat(500);
const hugeApplied = {
  type: 'categorized' as const,
  column: 'a',
  categories: Array.from({ length: 400 }, (_, i) => ({ value: `${longText}${i}`, color: '#ff0000', count: i })),
  categoryCount: 400,
  other: null,
  nullCount: 0,
  warnings: Array.from({ length: 20 }, () => longText)
};
const hugeColumns = Array.from({ length: 80 }, (_, i) => ({ name: `${'列'.repeat(120)}${i}`, type: 'string' as const }));

function layerData(result: ClientToolResult<ToolResultData>): AddLayerData {
  if (result.ok && 'bbox' in result.data) return result.data;
  throw new Error('expected an addLayer result');
}

describe('fitToolResult: layer answers', () => {
  const maxBytes = resultConfig.maxToolResultBytes;
  const added: ClientToolResult<ToolResultData> = {
    ok: true,
    data: {
      layerId: 'L9999',
      name: 'あ'.repeat(200),
      featureCount: 100000,
      geometryType: 'polygon',
      columns: [...hugeColumns, ...Array.from({ length: 40 }, (_, i) => ({ name: `c${i}`, type: 'number' as const }))],
      bbox: [-180, -90, 180, 90],
      applied: hugeApplied,
      warnings: Array.from({ length: 9 }, () => longText)
    }
  };

  it('fits an addLayer answer with a 120-character computed column name and long applied texts, and does not reject it', () => {
    const raw = JSON.stringify(added);
    expect(parseClientToolResult(raw, addLayerDataSchema).ok).toBe(true);
    const fitted = fitToolResult(added);
    expect(bytesOf(fitted)).toBeLessThanOrEqual(maxBytes);
    const data = layerData(fitted);
    expect(data.layerId).toBe('L9999');
    expect(fitted.ok).toBe(true);
  });

  it('cuts to the caps of the map summary: columns, column names, warnings, categories, texts', () => {
    const data = layerData(fitToolResult(added));
    expect(data.columns.length).toBeLessThanOrEqual(mapConfig.summaryMaxColumns);
    for (const { name } of data.columns) expect(name.length).toBeLessThanOrEqual(mapConfig.summaryMaxColumnNameChars);
    expect(data.columnCount).toBe(120);
    expect(data.name.endsWith('…')).toBe(true);
    expect(Array.from(data.name)).toHaveLength(toolConfig.maxLayerNameChars);
    expect(data.warnings).toHaveLength(mapConfig.summaryMaxWarnings);
    for (const warning of data.warnings ?? []) expect(Array.from(warning).length).toBeLessThanOrEqual(mapConfig.summaryMaxWarningChars);
    if (data.applied.type !== 'categorized') throw new Error('expected categorized');
    expect(data.applied.categories.length).toBeLessThanOrEqual(dataConfig.classification.maxCategories);
    expect(data.applied.categoryCount).toBe(400);
    for (const { value } of data.applied.categories) expect(Array.from(value).length).toBeLessThanOrEqual(mapConfig.summaryMaxStringChars);
    expect(data.applied.warnings).toHaveLength(mapConfig.summaryMaxWarnings);
  });

  it('cuts category values the way the map summary does: distinct, with #n', () => {
    const prefix = '長'.repeat(mapConfig.summaryMaxStringChars + 5);
    const categories = ['a', 'b', 'c'].map((tail, i) => ({ value: `${prefix}${tail}`, color: '#ff0000', count: i }));
    const answer: ClientToolResult<ToolResultData> = {
      ok: true,
      data: { layerId: 'L2', applied: { type: 'categorized', column: 'k', categories, categoryCount: 3, other: null, nullCount: 0, warnings: [] } }
    };
    const fitted = fitToolResult(answer);
    const applied = fitted.ok && 'applied' in fitted.data ? fitted.data.applied : undefined;
    const values = applied?.type === 'categorized' ? applied.categories.map(({ value }) => value) : [];
    expect(new Set(values).size).toBe(3);
    expect(values.every((value) => value.includes('#'))).toBe(true);
  });

  it('keeps the columns a model can use and says how many there are', () => {
    const data = layerData(fitToolResult(added));
    expect(data.columns.map(({ name }) => name).slice(0, 3)).toEqual(['c0', 'c1', 'c2']);
  });

  it('shrinks further (categories, then columns, then warnings) when the caps are not enough, and stays ok', () => {
    const base = layerData(fitToolResult(added));
    const small = bytesOf({ ok: true, data: { ...base, columns: [], warnings: [], applied: { ...hugeApplied, categories: [], warnings: [] } } });
    const tight = fitToolResult(added, small + 400);
    expect(tight.ok).toBe(true);
    expect(layerData(tight).columns).toEqual([]);
    expect(layerData(tight).layerId).toBe('L9999');
    const tightest = layerData(fitToolResult(added, 10));
    expect(tightest.columns).toEqual([]);
    expect(tightest.warnings).toEqual([]);
  });

  it('fits a setLayerStyle answer the same way', () => {
    const styled: ClientToolResult<ToolResultData> = { ok: true, data: { layerId: 'L2', applied: hugeApplied, warnings: [longText] } };
    const fitted = fitToolResult(styled);
    expect(bytesOf(fitted)).toBeLessThanOrEqual(maxBytes);
    expect(fitted.ok && 'applied' in fitted.data && fitted.data.layerId === 'L2').toBe(true);
    const tight = fitToolResult(styled, 150);
    expect(tight.ok && 'applied' in tight.data && tight.data.warnings).toEqual([]);
  });

  it('leaves a small single-colour answer as it is', () => {
    const answer: ClientToolResult<ToolResultData> = { ok: true, data: { layerId: 'L2', applied: { type: 'single', color: '#ff0000' } } };
    expect(fitToolResult(answer)).toEqual(answer);
  });

  it('cuts the list of remaining layers', () => {
    const answer: ClientToolResult<ToolResultData> = { ok: true, data: { removed: 'L1', remaining: Array.from({ length: 500 }, (_, i) => `L${i}`) } };
    const fitted = fitToolResult(answer);
    expect(fitted.ok && 'remaining' in fitted.data && fitted.data.remaining.length).toBe(toolConfig.maxResultLayers);
  });

  it('keeps every other answer within one tool result in its worst case', () => {
    const label: ClientToolResult<ToolResultData> = {
      ok: true,
      data: { layerId: 'L9999', label: { column: '列'.repeat(styleConfig.maxColumnChars), size: 12, color: '#000000', haloColor: '#ffffff', haloWidth: 1, minZoom: 22 } }
    };
    const removed: ClientToolResult<ToolResultData> = {
      ok: true,
      data: { removed: 'L9999', remaining: Array.from({ length: toolConfig.maxResultLayers }, (_, i) => `L${10000 + i}`) }
    };
    for (const result of [label, removed]) expect(bytesOf(fitToolResult(result))).toBeLessThanOrEqual(maxBytes);
  });
});

describe('fitToolResult: runQuery columns', () => {
  it('keeps at most the query column limit, in the columns and in every row, and says how many there were', () => {
    const names = Array.from({ length: 45 }, (_, i) => `c${i}`);
    const result: ClientToolResult<ToolResultData> = {
      ok: true,
      data: {
        columns: names.map((name) => ({ name, type: 'number' as const })),
        rows: [Object.fromEntries(names.map((name, i) => [name, i]))],
        rowCount: 1,
        truncated: false
      }
    };
    const data = dataOf(fitToolResult(result));
    expect(data.columns).toHaveLength(toolConfig.maxQueryColumns);
    expect(Object.keys(data.rows[0])).toHaveLength(toolConfig.maxQueryColumns);
    expect(data.columnCount).toBe(45);
  });

  it('keeps cut names apart: two long columns with one shared prefix keep both values', () => {
    const first = `CASE WHEN passengers_per_day > 100000 THEN 1 ELSE 0 END`;
    const second = `CASE WHEN passengers_per_day > 100000 THEN 2 ELSE 0 END`;
    const result: ClientToolResult<ToolResultData> = {
      ok: true,
      data: { columns: [{ name: first, type: 'number' }, { name: second, type: 'number' }], rows: [{ [first]: 1, [second]: 2 }], rowCount: 1, truncated: false }
    };
    const data = dataOf(fitToolResult(result));
    const [a, b] = data.columns.map(({ name }) => name);
    expect(a).not.toBe(b);
    expect(Object.values(data.rows[0]).sort()).toEqual([1, 2]);
    expect(data.rows[0][a]).toBe(1);
    expect(data.rows[0][b]).toBe(2);
  });

  it('cuts a long column name in the columns and in the rows alike', () => {
    const name = 'CASE WHEN '.repeat(30);
    const result: ClientToolResult<ToolResultData> = {
      ok: true,
      data: { columns: [{ name, type: 'string' }], rows: [{ [name]: 'a' }], rowCount: 1, truncated: false }
    };
    const data = dataOf(fitToolResult(result));
    expect(data.columns[0].name.length).toBeLessThanOrEqual(mapConfig.summaryMaxColumnNameChars);
    expect(Object.keys(data.rows[0])).toEqual([data.columns[0].name]);
    expect(data.rows[0][data.columns[0].name]).toBe('a');
  });
});

describe('parseClientToolResult', () => {
  const invalid = toolError('ENGINE_UNAVAILABLE', 'The browser returned an invalid result.');

  it('returns a valid ok result', () => {
    const result: ClientToolResult<RunQueryData> = { ok: true, data: runQueryData };
    expect(parseClientToolResult(JSON.stringify(result), runQueryDataSchema)).toEqual(result);
  });

  it('passes a well-formed error through as sent, SESSION_RESET included', () => {
    for (const error of [toolError('SQL_ERROR', 'no such column', 'use a'), toolError('SESSION_RESET', 'reset')]) {
      expect(parseClientToolResult(JSON.stringify(error), runQueryDataSchema)).toEqual(error);
    }
  });

  it.each([
    ['not JSON', 'not json'],
    ['empty text', ''],
    ['null', 'null'],
    ['a number', '42'],
    ['an array', '[]'],
    ['no ok', '{"data":{}}'],
    ['ok true without data', '{"ok":true}'],
    ['ok false without error', '{"ok":false}'],
    ['an unknown error code', '{"ok":false,"error":{"code":"NOPE","message":"m"}}'],
    ['an error without a message', '{"ok":false,"error":{"code":"TIMEOUT"}}'],
    ['an extra key', `{"ok":true,"data":${JSON.stringify(runQueryData)},"extra":1}`],
    ['data of the wrong shape', '{"ok":true,"data":{"rows":1}}'],
    ['data of another tool', `{"ok":true,"data":${JSON.stringify(validData.setView)}}`]
  ])('turns %s into ENGINE_UNAVAILABLE', (_name, raw) => {
    expect(parseClientToolResult(raw, runQueryDataSchema)).toEqual(invalid);
  });

  it('infers the data type from the schema', () => {
    const result = parseClientToolResult(JSON.stringify({ ok: true, data: validData.setView }), setViewDataSchema);
    if (result.ok) expect(result.data.zoom).toBe(9);
    else throw new Error('expected ok');
  });
});

const row = (text: string, n: number): RunQueryData['rows'][number] => ({ id: n, text, flag: true, none: null });

function runQueryResult(rows: RunQueryData['rows'], truncated = false): ClientToolResult<ToolResultData> {
  return {
    ok: true,
    data: {
      columns: [{ name: 'id', type: 'number' }, { name: 'text', type: 'string' }, { name: 'flag', type: 'boolean' }, { name: 'none', type: 'other' }],
      rows,
      rowCount: rows.length,
      truncated
    }
  };
}

function dataOf(result: ClientToolResult<ToolResultData>): RunQueryData {
  if (result.ok && 'rows' in result.data) return result.data;
  throw new Error('expected a runQuery result');
}

describe('fitToolResult', () => {
  const maxBytes = resultConfig.maxToolResultBytes;
  const manyRows = (text: string, count: number = queryConfig.maxRows) => Array.from({ length: count }, (_, n) => row(text, n));

  it('returns a result that fits as it is', () => {
    const result = runQueryResult(manyRows('a', 3));
    expect(fitToolResult(result)).toEqual(result);
  });

  it('keeps a result that is exactly at the limit, and drops a row when the limit is one byte lower', () => {
    const result = runQueryResult(manyRows('x'.repeat(100), 10));
    const exact = bytesOf(result);
    expect(fitToolResult(result, exact)).toEqual(result);
    const fitted = dataOf(fitToolResult(result, exact - 1));
    expect(fitted.rows).toHaveLength(9);
    expect(fitted.truncated).toBe(true);
    expect(fitted.rowCount).toBe(10);
  });

  it('drops rows from the end until it fits, and keeps the most rows that fit (CJK text, 3 bytes a character)', () => {
    const rows = manyRows('漢字'.repeat(200));
    const result = runQueryResult(rows);
    expect(bytesOf(result)).toBeGreaterThan(maxBytes);
    const fitted = fitToolResult(result);
    const data = dataOf(fitted);
    expect(bytesOf(fitted)).toBeLessThanOrEqual(maxBytes);
    expect(data.rows).toEqual(rows.slice(0, data.rows.length));
    expect(data.rows.length).toBeGreaterThan(0);
    expect(data.rows.length).toBeLessThan(rows.length);
    expect(data.truncated).toBe(true);
    expect(data.rowCount).toBe(rows.length);
    expect(data.columns).toEqual(dataOf(result).columns);
    expect(bytesOf(runQueryResult(rows.slice(0, data.rows.length + 1), true))).toBeGreaterThan(maxBytes);
  });

  it('counts the bytes of JSON escapes', () => {
    const rows = manyRows('"\\\n\t\u0001'.repeat(60));
    const fitted = fitToolResult(runQueryResult(rows));
    expect(bytesOf(fitted)).toBeLessThanOrEqual(maxBytes);
    expect(dataOf(fitted).rows.length).toBeLessThan(rows.length);
  });

  it('cuts the long texts of the first row when even one row is too large, ending in "…"', () => {
    const long = '長'.repeat(100_000);
    const fitted = fitToolResult(runQueryResult([row(long, 1), row('b', 2)]));
    const data = dataOf(fitted);
    expect(bytesOf(fitted)).toBeLessThanOrEqual(maxBytes);
    expect(data.rows).toHaveLength(1);
    const text = data.rows[0].text;
    expect(typeof text === 'string' && text.endsWith('…')).toBe(true);
    expect(data.rows[0].id).toBe(1);
    expect(data.truncated).toBe(true);
    expect(data.rowCount).toBe(2);
  });

  it('does not split a surrogate pair when it cuts a text', () => {
    const fitted = fitToolResult(runQueryResult([row('😀'.repeat(20_000), 1)]));
    const text = dataOf(fitted).rows[0].text;
    expect(typeof text === 'string' && text.isWellFormed()).toBe(true);
  });

  it('keeps just the columns when no row can fit', () => {
    const result = runQueryResult(manyRows('a', 5));
    const columnsOnly = bytesOf(runQueryResult([], true));
    const fitted = fitToolResult(result, columnsOnly);
    expect(dataOf(fitted).rows).toEqual([]);
    expect(dataOf(fitted).columns).toHaveLength(4);
    expect(dataOf(fitted).truncated).toBe(true);
    expect(dataOf(fitToolResult(result, 1)).rows).toEqual([]);
  });

  it('handles a single row whose texts are all short but whose columns are too wide', () => {
    const fitted = fitToolResult(runQueryResult([row('a', 1)]), 10);
    expect(dataOf(fitted).rows).toEqual([]);
  });

  it('leaves the results other than runQuery alone: they are bounded by their schemas', () => {
    const setView: ClientToolResult<ToolResultData> = { ok: true, data: { center: [1, 2], zoom: 3 } };
    expect(fitToolResult(setView, 5)).toEqual(setView);
    expect(bytesOf(setView)).toBeLessThan(maxBytes);
  });

  it('shortens an error that is too long, keeping the code', () => {
    const error = toolError('SQL_ERROR', '誤'.repeat(20_000), 'ヒント'.repeat(5_000));
    const fitted = fitToolResult(error);
    expect(bytesOf(fitted)).toBeLessThanOrEqual(maxBytes);
    expect(fitted.ok).toBe(false);
    if (!fitted.ok) {
      expect(fitted.error.code).toBe('SQL_ERROR');
      expect(fitted.error.message.endsWith('…')).toBe(true);
      expect(fitted.error.hint?.endsWith('…')).toBe(true);
    }
    const noHint = fitToolResult(toolError('TIMEOUT', 'x'.repeat(40_000)));
    expect(noHint.ok === false && 'hint' in noHint.error).toBe(false);
  });
});

describe('fitToolResults', () => {
  const eachBytes = resultConfig.maxToolResultBytes;
  const totalBytes = resultConfig.maxTotalResultBytes;
  const rowsOfText = (text: string, count: number) => Array.from({ length: count }, (_, n) => row(text, n));
  const setView: ClientToolResult<ToolResultData> = { ok: true, data: { center: [1, 2], zoom: 3 } };

  it('returns results that fit as they are', () => {
    const results = [runQueryResult(rowsOfText('a', 2)), setView];
    expect(fitToolResults(results)).toEqual(results);
  });

  it('fits each result to the limit of one', () => {
    const fitted = fitToolResults([runQueryResult(rowsOfText('漢'.repeat(300), 50)), setView]);
    expect(bytesOf(fitted[0])).toBeLessThanOrEqual(eachBytes);
    expect(fitted[1]).toEqual(setView);
  });

  it('shrinks the runQuery results until the total fits, the larger ones more', () => {
    const results = [
      runQueryResult(rowsOfText('漢'.repeat(300), 50)),
      runQueryResult(rowsOfText('漢'.repeat(150), 50)),
      runQueryResult(rowsOfText('漢'.repeat(300), 50)),
      runQueryResult(rowsOfText('漢'.repeat(300), 50)),
      runQueryResult(rowsOfText('漢'.repeat(300), 50)),
      setView
    ];
    const fitted = fitToolResults(results, 30_000);
    const total = fitted.reduce((sum, result) => sum + bytesOf(result), 0);
    expect(total).toBeLessThanOrEqual(30_000);
    expect(fitted[5]).toEqual(setView);
    for (const result of fitted.slice(0, 5)) expect(dataOf(result).rows.length).toBeGreaterThan(0);
  });

  it('shrinks in proportion to the size: a result twice as large loses about twice the bytes', () => {
    const large = runQueryResult(rowsOfText('漢'.repeat(200), 50));
    const small = runQueryResult(rowsOfText('漢'.repeat(100), 50));
    const [fittedLarge, fittedSmall] = fitToolResults([large, small], 12_000, 100_000);
    const lostLarge = bytesOf(large) - bytesOf(fittedLarge);
    const lostSmall = bytesOf(small) - bytesOf(fittedSmall);
    expect(lostSmall).toBeGreaterThan(0);
    expect(lostLarge).toBeGreaterThan(1.5 * lostSmall);
    expect(lostLarge).toBeLessThan(2.5 * lostSmall);
  });

  it('fits many results into the default total', () => {
    const results = Array.from({ length: 12 }, () => runQueryResult(rowsOfText('漢字'.repeat(100), 50)));
    const fitted = fitToolResults(results);
    expect(fitted.reduce((sum, result) => sum + bytesOf(result), 0)).toBeLessThanOrEqual(totalBytes);
    for (const result of fitted) expect(bytesOf(result)).toBeLessThanOrEqual(eachBytes);
  });

  it('shrinks down to the columns when the total is lower than that', () => {
    const fitted = fitToolResults([runQueryResult(rowsOfText('a', 20)), runQueryResult(rowsOfText('a', 20))], 10);
    for (const result of fitted) expect(dataOf(result).rows).toEqual([]);
  });

  it('returns the other results as they are, over the total, when only they are left (they are a few KiB each after fitToolResult)', () => {
    const results = [setView, setView];
    expect(fitToolResults(results, 5)).toEqual(results);
    const layers: ClientToolResult<ToolResultData>[] = Array.from({ length: 5 }, () => ({ ok: true, data: { layerId: 'L1', applied: hugeApplied, warnings: [longText] } }));
    const fitted = fitToolResults(layers, 1_000);
    expect(fitted).toHaveLength(5);
    for (const result of fitted) expect(bytesOf(result)).toBeLessThanOrEqual(resultConfig.maxToolResultBytes);
  });

  it('takes the limits as arguments', () => {
    const fitted = fitToolResults([runQueryResult(rowsOfText('abcdefghij', 50))], 100_000, 1_000);
    expect(bytesOf(fitted[0])).toBeLessThanOrEqual(1_000);
  });
});
