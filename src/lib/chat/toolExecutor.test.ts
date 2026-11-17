import { beforeEach, describe, expect, it } from 'vitest';
import { mapConfig, queryConfig, resultConfig, styleConfig, toolConfig } from '../../../shared/config';
import { appliedStyleSchema } from '../../../shared/mapSpec';
import { toolError, toolNameSchema, toolResultSchemas, type ClientToolRequest, type ClientToolResult, type ToolError, type ToolName, type ToolResultData } from '../../../shared/toolProtocol';
import type { GeoJsonFeature, JsonRow, LayerQueryResult, TableQueryResult } from '../duckdb/queryTypes';
import {
  addLayer,
  appliedOf,
  getLayer,
  layerIds,
  mapState,
  removeLayer,
  replaceLayer,
  resetMapState,
  setLabel,
  setStyle,
  summarizeForLlm
} from '../map/mapState.svelte';
import type { MapView } from './mapView';
import { answerToolRequest, createToolExecutor, type ToolExecutorDeps } from './toolExecutor';

const bytesOf = (value: object): number => new TextEncoder().encode(JSON.stringify(value)).length;

/** A point layer result as the engine would answer it: one feature per row, the columns of the first row. */
function layerData(rows: JsonRow[], bbox: LayerQueryResult['bbox'] = [139, 35, 140, 36]): LayerQueryResult {
  const features: GeoJsonFeature[] = rows.map((properties, id) => ({
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates: [bbox[0], bbox[1]] },
    properties
  }));
  const [first = {}] = rows;
  return {
    features: { type: 'FeatureCollection', features },
    geometryType: 'point',
    columns: Object.entries(first).map(([name, value]) => ({ name, type: typeof value === 'number' ? 'number' : 'string' })),
    featureCount: rows.length,
    bbox
  };
}

type FitCall = { bbox: LayerQueryResult['bbox']; padding: number; maxZoom: number; duration: number };

type Fakes = {
  deps: ToolExecutorDeps;
  layerSql: string[];
  tableSql: string[];
  fits: FitCall[];
  jumps: { center: [number, number]; zoom: number }[];
  /** What the next `queryLayer` answers. */
  layerAnswer: ClientToolResult<LayerQueryResult>;
  tableAnswer: ClientToolResult<TableQueryResult>;
  viewAfter: { center: [number, number]; zoom: number };
  fitError?: Error;
};

const stations = [
  { name: '東京', kind: 'JR', passengers: 100 },
  { name: '新宿', kind: 'JR', passengers: 300 },
  { name: '渋谷', kind: '私鉄', passengers: 200 }
];

function fakes(): Fakes {
  const viewAfter: Fakes['viewAfter'] = { center: [139.123456789, 35.987654321], zoom: 9.123456789 };
  const base = {
    layerSql: [],
    tableSql: [],
    fits: [],
    jumps: [],
    layerAnswer: { ok: true, data: layerData(stations) },
    tableAnswer: { ok: true, data: { columns: [{ name: 'n', type: 'number' }], rows: [{ n: 1 }, { n: 2 }], truncated: false } },
    viewAfter: viewAfter
  } satisfies Omit<Fakes, 'deps' | 'fitError'>;
  const state: Omit<Fakes, 'deps'> = base;
  const view: MapView = {
    fitBounds: async (bbox, options) => {
      if (state.fitError) throw state.fitError;
      state.fits.push({ bbox, ...options });
    },
    jumpTo: (center, zoom) => {
      state.jumps.push({ center, zoom });
    },
    getView: () => state.viewAfter
  };
  const deps: ToolExecutorDeps = {
    queryLayer: async (sql) => {
      state.layerSql.push(sql);
      return state.layerAnswer;
    },
    queryTable: async (sql) => {
      state.tableSql.push(sql);
      return state.tableAnswer;
    },
    map: { addLayer, replaceLayer, setStyle, setLabel, removeLayer, getLayer, layerIds, appliedOf },
    view
  };
  return Object.assign(state, { deps });
}

/** Runs a request and checks that the answer is a result of the tool's own schema when it is a success. */
async function run(state: Fakes, request: ClientToolRequest): Promise<ClientToolResult<ToolResultData>> {
  const result = await createToolExecutor(state.deps)(request);
  if (result.ok) expect(toolResultSchemas[request.tool].safeParse(result.data).success, JSON.stringify(result.data)).toBe(true);
  return result;
}

function failure(result: ClientToolResult<ToolResultData>): ToolError {
  if (result.ok) throw new Error('expected a failure');
  return result.error;
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json | undefined };

/** The data of a success as plain JSON, so that a test can read any field of it. */
function success(result: ClientToolResult<ToolResultData>): { [key: string]: Json | undefined } {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return JSON.parse(JSON.stringify(result.data));
}

const addRequest = (input: Partial<Extract<ClientToolRequest, { tool: 'addLayer' }>['input']> = {}): ClientToolRequest => ({
  tool: 'addLayer',
  input: { name: '駅', sql: 'SELECT * FROM stations', ...input }
});

describe('createToolExecutor', () => {
  let state: Fakes;

  beforeEach(() => {
    resetMapState();
    // Ids go on counting across a reset; the tests name layers by their number from 1.
    mapState.nextLayerSeq = 1;
    state = fakes();
  });

  describe('requests that are not valid', () => {
    it('answers INVALID_INPUT with the paths, and runs nothing', async () => {
      const execute = createToolExecutor(state.deps);
      const bad = [
        JSON.parse('{"tool":"dropTable","input":{}}'),
        JSON.parse('"runQuery"'),
        JSON.parse('null'),
        JSON.parse('{"tool":"runQuery","input":{"sql":"SELECT 1","extra":true}}'),
        JSON.parse('{"tool":"setView","input":{"target":{"type":"bbox","bbox":[1,2,3]}}}')
      ];
      for (const request of bad) {
        const error = failure(await execute(request));
        expect(error.code).toBe('INVALID_INPUT');
        expect(error.message).toContain('not valid at:');
        expect(error.message.length).toBeLessThan(200);
      }
      expect(state.tableSql).toEqual([]);
      expect(state.layerSql).toEqual([]);
      expect(state.fits).toEqual([]);
    });

    it('names the field of the mistake, and at most the configured number of paths', async () => {
      const execute = createToolExecutor(state.deps);
      const error = failure(await execute(JSON.parse('{"tool":"runQuery","input":{"sql":""}}')));
      expect(error.message).toContain('input.sql');
      const many = failure(await execute(JSON.parse(`{"tool":"addLayer","input":{${Array.from({ length: 12 }, (_, i) => `"k${i}":1`).join(',')}}}`)));
      expect(many.message.split(',').length).toBeLessThanOrEqual(toolConfig.maxIssuePaths);
    });
  });

  describe('runQuery', () => {
    it('answers the columns, the rows, the row count and truncated', async () => {
      const data = success(await run(state, { tool: 'runQuery', input: { sql: 'SELECT n FROM t' } }));
      expect(data).toEqual({ columns: [{ name: 'n', type: 'number' }], rows: [{ n: 1 }, { n: 2 }], rowCount: 2, truncated: false });
      expect(state.tableSql).toEqual(['SELECT n FROM t']);
    });

    it('keeps rowCount of the rows the engine returned when it says truncated', async () => {
      const rows = Array.from({ length: queryConfig.maxRows }, (_, n) => ({ n }));
      state.tableAnswer = { ok: true, data: { columns: [{ name: 'n', type: 'number' }], rows, truncated: true } };
      const data = success(await run(state, { tool: 'runQuery', input: { sql: 'SELECT n FROM t' } }));
      expect(data.rowCount).toBe(queryConfig.maxRows);
      expect(data.truncated).toBe(true);
    });

    it('fits rows with long CJK texts to the size limit, keeping the columns and the row count', async () => {
      const rows = Array.from({ length: queryConfig.maxRows }, (_, n) => ({ n, text: `${'漢字'.repeat(300)}${n}` }));
      state.tableAnswer = {
        ok: true,
        data: { columns: [{ name: 'n', type: 'number' }, { name: 'text', type: 'string' }], rows, truncated: false }
      };
      const result = await run(state, { tool: 'runQuery', input: { sql: 'SELECT n, text FROM t' } });
      expect(bytesOf(result)).toBeLessThanOrEqual(resultConfig.maxToolResultBytes);
      const data = success(result);
      expect(data.truncated).toBe(true);
      expect(data.rowCount).toBe(queryConfig.maxRows);
      expect(Array.isArray(data.rows) && data.rows.length < queryConfig.maxRows).toBe(true);
      expect(data.columns).toHaveLength(2);
    });

    it.each([
      toolError('SQL_REJECTED', 'Only SELECT is allowed.'),
      toolError('SQL_ERROR', 'Binder Error: column "x" not found.', 'Check the column names in the catalog.'),
      toolError('TIMEOUT', 'The query took longer than 30 s.', 'Filter, aggregate or simplify the query.'),
      toolError('SESSION_RESET', 'The data engine was restarted; run the query again.')
    ])('passes the engine failure $error.code on as it is', async (answer) => {
      state.tableAnswer = answer;
      expect(await run(state, { tool: 'runQuery', input: { sql: 'SELECT 1' } })).toEqual(answer);
    });
  });

  describe('addLayer', () => {
    it('adds the layer, moves the map to its box and answers the layer facts', async () => {
      const data = success(await run(state, addRequest({ style: { type: 'graduated', column: 'passengers', method: 'quantile', classes: 3 } })));
      expect(data).toMatchObject({
        layerId: 'L1',
        name: '駅',
        featureCount: 3,
        geometryType: 'point',
        columns: [
          { name: 'name', type: 'string' },
          { name: 'kind', type: 'string' },
          { name: 'passengers', type: 'number' }
        ],
        bbox: [139, 35, 140, 36]
      });
      expect(data.applied).toMatchObject({ type: 'graduated' });
      expect(data.warnings).toBeUndefined();
      expect(mapState.layers.map((layer) => layer.id)).toEqual(['L1']);
      expect(state.fits).toEqual([{ bbox: [139, 35, 140, 36], padding: mapConfig.fitPaddingPx, maxZoom: mapConfig.fitMaxZoom, duration: mapConfig.fitDurationMs }]);
    });

    it('moves the map when zoomTo is true or left out, and not when it is false', async () => {
      await run(state, addRequest({ zoomTo: true }));
      await run(state, addRequest());
      expect(state.fits).toHaveLength(2);
      await run(state, addRequest({ zoomTo: false }));
      expect(state.fits).toHaveLength(2);
      expect(mapState.layers).toHaveLength(3);
    });

    it('does not move the map for a layer with no feature', async () => {
      state.layerAnswer = { ok: true, data: layerData([], [0, 0, 0, 0]) };
      const data = success(await run(state, addRequest()));
      expect(data.featureCount).toBe(0);
      expect(state.fits).toEqual([]);
    });

    it('still answers the layer when the camera cannot move', async () => {
      state.fitError = new Error('map is gone https://example.com/x?sig=secret');
      const data = success(await run(state, addRequest()));
      expect(data.layerId).toBe('L1');
    });

    it.each([
      toolError('SQL_REJECTED', 'Only SELECT is allowed.'),
      toolError('SQL_ERROR', 'Binder Error: column "x" not found.'),
      toolError('TIMEOUT', 'The query took longer than 30 s.'),
      toolError('TOO_MANY_FEATURES', 'The query returned more than 100000 features.'),
      toolError('NO_GEOMETRY', 'The query has no geom column.'),
      toolError('MIXED_GEOMETRY', 'The layer mixes points and polygons.')
    ])('passes the engine failure $error.code on, and adds nothing', async (answer) => {
      state.layerAnswer = answer;
      expect(await run(state, addRequest())).toEqual(answer);
      expect(mapState.layers).toEqual([]);
      expect(state.fits).toEqual([]);
    });

    it('answers UNKNOWN_COLUMN for a label column the layer lacks, and INVALID_STYLE for a style that does not fit, adding nothing', async () => {
      expect(failure(await run(state, addRequest({ label: { column: 'nope' } }))).code).toBe('UNKNOWN_COLUMN');
      expect(failure(await run(state, addRequest({ style: { type: 'categorized', column: 'nope' } }))).code).toBe('UNKNOWN_COLUMN');
      const invalid = failure(await run(state, addRequest({ style: { type: 'graduated', column: 'kind', method: 'equal' } })));
      expect(invalid.code).toBe('INVALID_STYLE');
      expect(mapState.layers).toEqual([]);
      expect(state.fits).toEqual([]);
    });

    describe('replaceLayerId', () => {
      it('answers UNKNOWN_LAYER for an id that is not on the map, without running the query', async () => {
        await run(state, addRequest());
        const error = failure(await run(state, addRequest({ replaceLayerId: 'L9' })));
        expect(error.code).toBe('UNKNOWN_LAYER');
        expect(error.hint).toContain('L1');
        expect(state.layerSql).toHaveLength(1);
      });

      it('keeps the id and the old style and label while they fit the new data, and says nothing', async () => {
        await run(state, addRequest({ style: { type: 'categorized', column: 'kind' }, label: { column: 'name' } }));
        state.layerAnswer = { ok: true, data: layerData([{ name: '大阪', kind: 'JR', passengers: 5 }], [135, 34, 136, 35]) };
        const data = success(await run(state, addRequest({ name: '大阪の駅', replaceLayerId: 'L1' })));
        expect(data).toMatchObject({ layerId: 'L1', name: '大阪の駅', featureCount: 1, bbox: [135, 34, 136, 35] });
        expect(data.warnings).toBeUndefined();
        expect(data.applied).toMatchObject({ type: 'categorized' });
        expect(getLayer('L1')?.label).toEqual({ column: 'name' });
        expect(mapState.layers).toHaveLength(1);
        expect(state.fits.at(-1)?.bbox).toEqual([135, 34, 136, 35]);
      });

      it('lets a given style and label win over the old ones', async () => {
        await run(state, addRequest({ style: { type: 'categorized', column: 'kind' }, label: { column: 'name' } }));
        const data = success(await run(state, addRequest({ replaceLayerId: 'L1', style: { type: 'single', color: '#112233' }, label: { column: 'kind' } })));
        expect(data.applied).toEqual({ type: 'single', color: '#112233' });
        expect(getLayer('L1')?.label).toEqual({ column: 'kind' });
        expect(data.warnings).toBeUndefined();
      });

      it('warns when the old style or label no longer fit the new data and fell back', async () => {
        await run(state, addRequest({ style: { type: 'graduated', column: 'passengers', method: 'equal', classes: 3 }, label: { column: 'name' } }));
        state.layerAnswer = { ok: true, data: layerData([{ code: 'a' }]) };
        const data = success(await run(state, addRequest({ replaceLayerId: 'L1' })));
        expect(data.applied).toMatchObject({ type: 'single' });
        expect(data.warnings).toHaveLength(2);
        expect(data.warnings).toEqual([expect.stringContaining('style'), expect.stringContaining('label')]);
      });

      it('changes nothing when a given style fails', async () => {
        await run(state, addRequest({ style: { type: 'single', color: '#112233' } }));
        const before = JSON.stringify(getLayer('L1'));
        const error = failure(await run(state, addRequest({ replaceLayerId: 'L1', name: 'x', style: { type: 'categorized', column: 'nope' } })));
        expect(error.code).toBe('UNKNOWN_COLUMN');
        expect(JSON.stringify(getLayer('L1'))).toBe(before);
      });

      it('does not move the map when zoomTo is false', async () => {
        await run(state, addRequest());
        await run(state, addRequest({ replaceLayerId: 'L1', zoomTo: false }));
        expect(state.fits).toHaveLength(1);
      });
    });
  });

  describe('the applied style is the one <map_state> shows', () => {
    const prefix = 'あ'.repeat(mapConfig.summaryMaxStringChars + 6);
    const kinds = ['a', 'b', 'c', 'd'].map((tail) => `${prefix}${tail}`);
    const rows = [kinds[0], kinds[1], kinds[1], kinds[2], kinds[3], kinds[3], kinds[3]].map((kind, n) => ({ kind, n }));

    function mapStateApplied(layerId: string): Json | undefined {
      const layer = summarizeForLlm().layers.find((candidate) => candidate.id === layerId);
      return layer && 'applied' in layer ? layer.applied : undefined;
    }

    it('in addLayer: category values and an override that share a long prefix are numbered as in <map_state>', async () => {
      state.layerAnswer = { ok: true, data: layerData(rows) };
      const data = success(
        await run(state, addRequest({ style: { type: 'categorized', column: 'kind', overrides: { [kinds[1]]: '#ff0000', [`${prefix}z`]: '#00ff00' } } }))
      );
      expect(data.applied).toEqual(mapStateApplied('L1'));
      const applied = appliedStyleSchema.parse(data.applied);
      const values = applied.type === 'categorized' ? applied.categories.map(({ value }) => value) : [];
      expect(values).not.toEqual([]);
      expect(new Set(values).size).toBe(values.length);
      expect(values.every((value) => Array.from(value).length <= mapConfig.summaryMaxStringChars)).toBe(true);
      // The override's own key in <map_state> is the text of the category it names.
      const layer = summarizeForLlm().layers[0];
      const overrideKey = 'style' in layer && layer.style.type === 'categorized' ? Object.keys(layer.style.overrides ?? {})[0] : undefined;
      expect(values).toContain(overrideKey);
    });

    it('in setLayerStyle too', async () => {
      state.layerAnswer = { ok: true, data: layerData(rows) };
      await run(state, addRequest());
      const data = success(
        await run(state, { tool: 'setLayerStyle', input: { layerId: 'L1', style: { type: 'categorized', column: 'kind', overrides: { [kinds[2]]: '#ff0000' } } } })
      );
      expect(data.applied).toEqual(mapStateApplied('L1'));
    });

    it('for a graduated style as well', async () => {
      const data = success(await run(state, addRequest({ style: { type: 'graduated', column: 'passengers', method: 'quantile', classes: 3 } })));
      expect(data.applied).toEqual(mapStateApplied('L1'));
    });
  });

  describe('setLayerStyle', () => {
    beforeEach(async () => {
      await run(state, addRequest());
    });

    it('restyles the layer and answers the applied style', async () => {
      const data = success(await run(state, { tool: 'setLayerStyle', input: { layerId: 'L1', style: { type: 'proportional', column: 'passengers', color: '#e41a1c' } } }));
      expect(data).toMatchObject({ layerId: 'L1', applied: { type: 'proportional', column: 'passengers', min: 100, max: 300 } });
      expect(getLayer('L1')?.style.type).toBe('proportional');
    });

    it('answers UNKNOWN_LAYER, UNKNOWN_COLUMN and INVALID_STYLE, changing nothing', async () => {
      const before = JSON.stringify(getLayer('L1'));
      expect(failure(await run(state, { tool: 'setLayerStyle', input: { layerId: 'L7', style: { type: 'single', color: '#112233' } } })).code).toBe('UNKNOWN_LAYER');
      expect(failure(await run(state, { tool: 'setLayerStyle', input: { layerId: 'L1', style: { type: 'categorized', column: 'nope' } } })).code).toBe('UNKNOWN_COLUMN');
      expect(failure(await run(state, { tool: 'setLayerStyle', input: { layerId: 'L1', style: { type: 'graduated', column: 'kind', method: 'equal' } } })).code).toBe('INVALID_STYLE');
      expect(JSON.stringify(getLayer('L1'))).toBe(before);
    });
  });

  describe('setLayerLabel', () => {
    beforeEach(async () => {
      await run(state, addRequest());
    });

    it('sets the label and answers it, and removes it with null', async () => {
      expect(success(await run(state, { tool: 'setLayerLabel', input: { layerId: 'L1', label: { column: 'name', size: 14 } } }))).toEqual({
        layerId: 'L1',
        label: { column: 'name', size: 14 }
      });
      expect(getLayer('L1')?.label).toEqual({ column: 'name', size: 14 });
      expect(success(await run(state, { tool: 'setLayerLabel', input: { layerId: 'L1', label: null } }))).toEqual({ layerId: 'L1', label: null });
      expect(getLayer('L1')?.label).toBeNull();
    });

    it('answers UNKNOWN_LAYER and UNKNOWN_COLUMN', async () => {
      expect(failure(await run(state, { tool: 'setLayerLabel', input: { layerId: 'L7', label: null } })).code).toBe('UNKNOWN_LAYER');
      expect(failure(await run(state, { tool: 'setLayerLabel', input: { layerId: 'L1', label: { column: 'nope' } } })).code).toBe('UNKNOWN_COLUMN');
    });
  });

  describe('removeLayer', () => {
    it('removes the layer and lists the ones left', async () => {
      await run(state, addRequest());
      await run(state, addRequest());
      expect(success(await run(state, { tool: 'removeLayer', input: { layerId: 'L1' } }))).toEqual({ removed: 'L1', remaining: ['L2'] });
      expect(mapState.layers.map((layer) => layer.id)).toEqual(['L2']);
    });

    it('answers UNKNOWN_LAYER with the layers there are', async () => {
      await run(state, addRequest());
      const error = failure(await run(state, { tool: 'removeLayer', input: { layerId: 'L5' } }));
      expect(error.code).toBe('UNKNOWN_LAYER');
      expect(error.hint).toContain('L1');
    });
  });

  describe('setView', () => {
    it('fits to a layer and reads the view back from the map, rounded', async () => {
      await run(state, addRequest());
      state.fits.length = 0;
      const data = success(await run(state, { tool: 'setView', input: { target: { type: 'layer', layerId: 'L1' } } }));
      expect(data).toEqual({ center: [139.1235, 35.9877], zoom: 9.1235 });
      expect(state.fits).toHaveLength(1);
      expect(state.fits[0].bbox).toEqual([139, 35, 140, 36]);
    });

    it('answers UNKNOWN_LAYER for an unknown layer, and NO_GEOMETRY for a layer with no feature (the view stays)', async () => {
      expect(failure(await run(state, { tool: 'setView', input: { target: { type: 'layer', layerId: 'L3' } } })).code).toBe('UNKNOWN_LAYER');
      state.layerAnswer = { ok: true, data: layerData([], [0, 0, 0, 0]) };
      await run(state, addRequest());
      expect(failure(await run(state, { tool: 'setView', input: { target: { type: 'layer', layerId: 'L1' } } })).code).toBe('NO_GEOMETRY');
      expect(state.fits).toEqual([]);
    });

    it('fits to a box', async () => {
      success(await run(state, { tool: 'setView', input: { target: { type: 'bbox', bbox: [130, 30, 131, 31] } } }));
      expect(state.fits.map(({ bbox }) => bbox)).toEqual([[130, 30, 131, 31]]);
    });

    it('jumps to a centre and zoom', async () => {
      success(await run(state, { tool: 'setView', input: { target: { type: 'center', center: [139.7, 35.7], zoom: 11 } } }));
      expect(state.jumps).toEqual([{ center: [139.7, 35.7], zoom: 11 }]);
      expect(state.fits).toEqual([]);
    });

    it('runs the query without adding a layer, and fits to its box', async () => {
      state.layerAnswer = { ok: true, data: layerData([{ name: '札幌' }], [141, 43, 141.5, 43.5]) };
      success(await run(state, { tool: 'setView', input: { target: { type: 'query', sql: 'SELECT geom FROM municipalities' } } }));
      expect(state.layerSql).toEqual(['SELECT geom FROM municipalities']);
      expect(state.fits.map(({ bbox }) => bbox)).toEqual([[141, 43, 141.5, 43.5]]);
      expect(mapState.layers).toEqual([]);
    });

    it('answers NO_GEOMETRY for a query with no feature, and passes the engine failures on', async () => {
      state.layerAnswer = { ok: true, data: layerData([], [0, 0, 0, 0]) };
      const empty = failure(await run(state, { tool: 'setView', input: { target: { type: 'query', sql: 'SELECT geom FROM municipalities WHERE false' } } }));
      expect(empty.code).toBe('NO_GEOMETRY');
      for (const code of ['SQL_REJECTED', 'SQL_ERROR', 'TIMEOUT', 'TOO_MANY_FEATURES', 'NO_GEOMETRY', 'MIXED_GEOMETRY'] as const) {
        const answer = toolError(code, 'x');
        state.layerAnswer = answer;
        expect(await run(state, { tool: 'setView', input: { target: { type: 'query', sql: 'SELECT 1' } } })).toEqual(answer);
      }
      expect(state.fits).toEqual([]);
    });
  });

  describe('a failure inside never escapes as a rejection', () => {
    const requests: Record<ToolName, ClientToolRequest> = {
      runQuery: { tool: 'runQuery', input: { sql: 'SELECT 1' } },
      addLayer: addRequest(),
      setLayerStyle: { tool: 'setLayerStyle', input: { layerId: 'L1', style: { type: 'single', color: '#112233' } } },
      setLayerLabel: { tool: 'setLayerLabel', input: { layerId: 'L1', label: null } },
      removeLayer: { tool: 'removeLayer', input: { layerId: 'L1' } },
      setView: { tool: 'setView', input: { target: { type: 'center', center: [139, 35], zoom: 5 } } }
    };
    const boom = new Error('boom https://bucket.example.com/data.parquet?X-Amz-Signature=secret\n    at stack line');

    it.each(toolNameSchema.options)('%s: a thrown fake becomes ENGINE_UNAVAILABLE without a URL or a stack', async (tool) => {
      const thrower = () => {
        throw boom;
      };
      const deps: ToolExecutorDeps = {
        queryLayer: async () => thrower(),
        queryTable: async () => thrower(),
        map: { addLayer: thrower, replaceLayer: thrower, setStyle: thrower, setLabel: thrower, removeLayer: thrower, getLayer: thrower, layerIds: thrower, appliedOf: thrower },
        view: { fitBounds: async () => thrower(), jumpTo: thrower, getView: thrower }
      };
      const error = failure(await createToolExecutor(deps)(requests[tool]));
      expect(error.code).toBe('ENGINE_UNAVAILABLE');
      expect(error.message).toContain('boom');
      expect(error.message).not.toContain('https://');
      expect(error.message).not.toContain('secret');
      expect(error.message).not.toContain('stack line');
    });

    it('also for something that is not an Error', async () => {
      const deps: ToolExecutorDeps = { ...state.deps, queryTable: () => Promise.reject('plain text') };
      const error = failure(await createToolExecutor(deps)(requests.runQuery));
      expect(error).toEqual({ code: 'ENGINE_UNAVAILABLE', message: 'The tool failed: plain text' });
    });
  });

  describe('geometries outside longitude/latitude', () => {
    const buffered = (): LayerQueryResult => layerData(stations, [-361, -465, 639, 535]);
    const farPoint = (): LayerQueryResult => layerData([{ name: 'x' }], [200, 0, 200, 0]);

    it.each([
      ['ST_Buffer(geom, 500)', buffered],
      ['ST_Point(200, 0)', farPoint]
    ])('addLayer refuses %s as SQL_ERROR with a hint about degrees, and adds nothing', async (_sql, make) => {
      state.layerAnswer = { ok: true, data: make() };
      const error = failure(await run(state, addRequest()));
      expect(error.code).toBe('SQL_ERROR');
      expect(error.hint).toContain('degrees');
      expect(mapState.layers).toEqual([]);
      expect(state.fits).toEqual([]);
    });

    it('does not replace a layer with one outside the range', async () => {
      await run(state, addRequest());
      const before = JSON.stringify(getLayer('L1'));
      state.layerAnswer = { ok: true, data: buffered() };
      expect(failure(await run(state, addRequest({ replaceLayerId: 'L1' }))).code).toBe('SQL_ERROR');
      expect(JSON.stringify(getLayer('L1'))).toBe(before);
    });

    it('setView with a query refuses it too, and the view stays', async () => {
      state.layerAnswer = { ok: true, data: farPoint() };
      const error = failure(await run(state, { tool: 'setView', input: { target: { type: 'query', sql: 'SELECT ST_Point(200, 0) AS geom' } } }));
      expect(error.code).toBe('SQL_ERROR');
      expect(state.fits).toEqual([]);
    });
  });

  describe('one call at a time', () => {
    it('runs calls started together in the order received, and setView answers the final view', async () => {
      const order: string[] = [];
      let view = { center: [0, 0] as [number, number], zoom: 1 };
      const slowFit: ToolExecutorDeps['view']['fitBounds'] = async (bbox) => {
        order.push(`fit-start ${bbox[0]}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        view = { center: [bbox[0], bbox[1]], zoom: 5 };
        order.push(`fit-end ${bbox[0]}`);
      };
      const deps: ToolExecutorDeps = {
        ...state.deps,
        queryLayer: async (sql) => {
          order.push(`query ${sql}`);
          const west = sql.endsWith('A') ? 130 : 140;
          return { ok: true, data: layerData(stations, [west, 35, west + 1, 36]) };
        },
        view: { fitBounds: slowFit, jumpTo: (center, zoom) => { view = { center, zoom }; order.push('jump'); }, getView: () => view }
      };
      const execute = createToolExecutor(deps);
      const [first, second, third] = await Promise.all([
        execute(addRequest({ sql: 'SELECT A' })),
        execute(addRequest({ sql: 'SELECT B' })),
        execute({ tool: 'setView', input: { target: { type: 'center', center: [135, 34], zoom: 10 } } })
      ]);
      expect(order).toEqual(['query SELECT A', 'fit-start 130', 'fit-end 130', 'query SELECT B', 'fit-start 140', 'fit-end 140', 'jump']);
      expect(first.ok && 'layerId' in first.data && first.data.layerId).toBe('L1');
      expect(second.ok && 'layerId' in second.data && second.data.layerId).toBe('L2');
      expect(third).toEqual({ ok: true, data: { center: [135, 34], zoom: 10 } });
    });

    it('does not let a failed call block the next', async () => {
      const execute = createToolExecutor({ ...state.deps, queryTable: () => Promise.reject(new Error('boom')) });
      const [bad, good] = await Promise.all([
        execute({ tool: 'runQuery', input: { sql: 'SELECT 1' } }),
        execute({ tool: 'removeLayer', input: { layerId: 'L9' } })
      ]);
      expect(failure(bad).code).toBe('ENGINE_UNAVAILABLE');
      expect(failure(good).code).toBe('UNKNOWN_LAYER');
    });
  });

  it('keeps the zoom the view reports within the zoom range of the schema', async () => {
    state.viewAfter = { center: [139, 35], zoom: 25 };
    expect(success(await run(state, { tool: 'setView', input: { target: { type: 'center', center: [139, 35], zoom: 5 } } })).zoom).toBe(styleConfig.zoom.max);
    state.viewAfter = { center: [139, 35], zoom: -3 };
    expect(success(await run(state, { tool: 'setView', input: { target: { type: 'center', center: [139, 35], zoom: 5 } } })).zoom).toBe(styleConfig.zoom.min);
  });

  describe('answerToolRequest', () => {
    it('is the JSON string of the result', async () => {
      const execute = createToolExecutor(state.deps);
      const request: ClientToolRequest = { tool: 'runQuery', input: { sql: 'SELECT n FROM t' } };
      expect(JSON.parse(await answerToolRequest(execute, request))).toEqual(await execute(request));
    });

    it('is the JSON of an error too', async () => {
      const execute = createToolExecutor(state.deps);
      const text = await answerToolRequest(execute, JSON.parse('{"tool":"nope"}'));
      expect(JSON.parse(text)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });
  });
});
