import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mapConfig, mapsConfig, styleConfig, toolConfig } from '../../../shared/config';
import type { StyleSpec } from '../../../shared/mapSpec';
import { persistedMapStateSchema, persistedMapVersion, type PersistedMapState } from '../../../shared/persistedMap';
import { toolError, type ClientToolResult } from '../../../shared/toolProtocol';
import type { LayerQueryResult } from '../duckdb/queryTypes';
import { fittedLayerIds, pickFitBounds } from './fit';
import { addLayer, getFeatures, getLayer, layerIds, mapState, removeLayer, replaceLayer, resetMapState, setStyle, setView, setVisible, summarizeForLlm, type LayerState } from './mapState.svelte';
import { restoreMap, restoreProgress, toPersisted } from './persist.svelte';
import { toMapLibreLayers } from './styleCompiler';

function data(geometryType: LayerQueryResult['geometryType'] = 'point'): LayerQueryResult {
  return {
    features: {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', id: 0, geometry: { type: 'Point', coordinates: [139, 35] }, properties: { name: 'a', kind: 'x', pop: 10 } },
        { type: 'Feature', id: 1, geometry: { type: 'Point', coordinates: [140, 36] }, properties: { name: 'b', kind: 'y', pop: 20 } }
      ]
    },
    geometryType,
    columns: [
      { name: 'name', type: 'string' },
      { name: 'kind', type: 'string' },
      { name: 'pop', type: 'number' }
    ],
    featureCount: 2,
    bbox: [139, 35, 140, 36]
  };
}

const placed = (input: Parameters<typeof addLayer>[0], result: LayerQueryResult = data()): LayerState => {
  const added = addLayer(input, result);
  if (!added.ok) throw new Error(added.error.message);
  return added.data;
};

/** A saved map of three layers: L1 labelled and hidden, L2 categorized, L4 proportional (L3 was removed before it was saved). */
function savedState(): PersistedMapState {
  return {
    version: persistedMapVersion,
    view: { center: [138.5, 36.25], zoom: 7.5 },
    layers: [
      { id: 'L1', name: '市区町村', sql: 'SELECT 1', style: { type: 'single', color: '#112233' }, label: { column: 'name' }, visible: false },
      { id: 'L2', name: '路線', sql: 'SELECT 2', style: { type: 'categorized', column: 'kind' }, label: null, visible: true },
      { id: 'L4', name: '駅', sql: 'SELECT 4', style: { type: 'proportional', column: 'pop', color: '#ff0000' }, label: null, visible: true }
    ],
    nextLayerSeq: 5
  };
}

type Query = (sql: string) => Promise<ClientToolResult<LayerQueryResult>>;

/** A query that answers each SQL from `answers` (a missing one is `data()`), one call at a time: it fails the test when two overlap. */
function fakeQueries(answers: Record<string, ClientToolResult<LayerQueryResult>> = {}) {
  const calls: string[] = [];
  let running = 0;
  let overlapped = false;
  const queryLayer: Query = async (sql) => {
    calls.push(sql);
    running += 1;
    overlapped ||= running > 1;
    await Promise.resolve();
    running -= 1;
    return answers[sql] ?? { ok: true, data: data() };
  };
  return { queryLayer, calls, overlapped: () => overlapped, jumpTo: () => undefined };
}

/** The persisted state of the map; fails the test when there is none. */
function persisted(): PersistedMapState {
  const result = toPersisted();
  if (!result.ok) throw new Error(result.message);
  return result.state;
}

describe('toPersisted', () => {
  beforeEach(() => resetMapState());

  it('keeps what rebuilds each layer, the view and the next layer number, and passes the schema', () => {
    placed({ name: '市区町村', sql: 'SELECT 1', style: { type: 'single', color: '#112233' }, label: { column: 'name' } });
    placed({ name: '路線', sql: 'SELECT 2', style: { type: 'categorized', column: 'kind' } });
    setVisible('L2', false);
    setView({ lng: 138.5, lat: 36.25 }, 7.5);

    const saved = persisted();
    expect(persistedMapStateSchema.safeParse(saved).success).toBe(true);
    expect(saved).toEqual({
      version: persistedMapVersion,
      view: { center: [138.5, 36.25], zoom: 7.5 },
      layers: [
        { id: 'L1', name: '市区町村', sql: 'SELECT 1', style: { type: 'single', color: '#112233' }, label: { column: 'name' }, visible: true },
        { id: 'L2', name: '路線', sql: 'SELECT 2', style: { type: 'categorized', column: 'kind' }, label: null, visible: false }
      ],
      nextLayerSeq: 3
    });
  });

  it('has no features and nothing resolved from them', () => {
    placed({ name: 'a', sql: 'SELECT 1', style: { type: 'categorized', column: 'kind' } });
    const text = JSON.stringify(persisted());
    expect(text).not.toContain('features');
    expect(text).not.toContain('resolved');
    expect(text).not.toContain('bbox');
  });

  it('is plain data: a later change to the map does not reach it', () => {
    placed({ name: 'a', sql: 'SELECT 1' });
    const saved = persisted();
    setVisible('L1', false);
    expect(saved.layers[0].visible).toBe(true);
  });

  it('clamps a zoom below the saved range (a short map zooms out further) instead of failing', () => {
    placed({ name: 'a', sql: 'SELECT 1' });
    setView({ lng: 139, lat: 35 }, styleConfig.zoom.min - 1.5);
    expect(persisted().view.zoom).toBe(styleConfig.zoom.min);
    setView({ lng: 139, lat: 35 }, styleConfig.zoom.max + 3);
    expect(persisted().view.zoom).toBe(styleConfig.zoom.max);
  });

  it('answers tooManyLayers for more layers than a saved map holds, and never throws', () => {
    for (let i = 0; i <= mapsConfig.maxLayers; i++) placed({ name: `l${i}`, sql: 'SELECT 1' });
    expect(toPersisted()).toMatchObject({ ok: false, reason: 'tooManyLayers' });
    removeLayer(layerIds()[0]);
    expect(toPersisted()).toMatchObject({ ok: true });
  });

  it('answers invalid for a state the schema refuses', () => {
    placed({ name: 'a'.repeat(toolConfig.maxLayerNameChars + 1), sql: 'SELECT 1' });
    expect(toPersisted()).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('round-trips through a restore: the same map comes back', async () => {
    placed({ name: '市区町村', sql: 'SELECT 1', style: { type: 'categorized', column: 'kind' }, label: { column: 'name' } });
    placed({ name: '駅', sql: 'SELECT 2', style: { type: 'proportional', column: 'pop', color: '#ff0000' } });
    setVisible('L2', false);
    setView({ lng: 135, lat: 34 }, 9);
    const before = persisted();
    await restoreMap(before, fakeQueries());
    expect(persisted()).toEqual(before);
  });
});

describe('restoreMap', () => {
  beforeEach(() => {
    resetMapState();
    fittedLayerIds.clear();
  });

  it('rebuilds every layer under its saved id, name, style, label and visibility, in the saved order', async () => {
    const queries = fakeQueries();
    const report = await restoreMap(savedState(), queries);
    expect(report).toEqual({ restored: ['L1', 'L2', 'L4'], failed: [] });
    expect(layerIds()).toEqual(['L1', 'L2', 'L4']);
    expect(mapState.layers.map(({ name, style, label, visible, status }) => ({ name, style, label, visible, status }))).toEqual([
      { name: '市区町村', style: { type: 'single', color: '#112233' }, label: { column: 'name' }, visible: false, status: 'ready' },
      { name: '路線', style: { type: 'categorized', column: 'kind' }, label: null, visible: true, status: 'ready' },
      { name: '駅', style: { type: 'proportional', column: 'pop', color: '#ff0000' }, label: null, visible: true, status: 'ready' }
    ]);
    expect(getFeatures('L2')?.features).toHaveLength(2);
    expect(getLayer('L2')?.resolved.type).toBe('categorized');
  });

  it('runs the queries one at a time, in the saved order', async () => {
    const queries = fakeQueries();
    await restoreMap(savedState(), queries);
    expect(queries.calls).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 4']);
    expect(queries.overlapped()).toBe(false);
  });

  it('clears the map it finds first', async () => {
    placed({ name: 'old', sql: 'SELECT 9' });
    await restoreMap(savedState(), fakeQueries());
    expect(layerIds()).toEqual(['L1', 'L2', 'L4']);
    expect(getFeatures('L1')).toBeDefined();
  });

  it('keeps a layer whose query failed as an error layer, and restores the others', async () => {
    const queries = fakeQueries({ 'SELECT 2': toolError('SQL_ERROR', 'Referenced column "nope" not found') });
    const report = await restoreMap(savedState(), queries);
    expect(report.restored).toEqual(['L1', 'L4']);
    expect(report.failed).toEqual([{ id: 'L2', code: 'SQL_ERROR', message: 'Referenced column "nope" not found' }]);
    expect(layerIds()).toEqual(['L1', 'L2', 'L4']);
    const failed = getLayer('L2');
    expect(failed).toMatchObject({ status: 'error', errorMessage: 'Referenced column "nope" not found', name: '路線', featureCount: 0, visible: true, style: { type: 'categorized', column: 'kind' } });
    expect(getFeatures('L2')).toBeUndefined();
    expect(getLayer('L1')?.status).toBe('ready');
    expect(getLayer('L4')?.status).toBe('ready');
  });

  it('keeps a layer the SQL guard rejected as an error layer', async () => {
    const queries = fakeQueries({ 'SELECT 1': toolError('SQL_REJECTED', 'Only SELECT is allowed.') });
    const report = await restoreMap(savedState(), queries);
    expect(report.failed).toEqual([{ id: 'L1', code: 'SQL_REJECTED', message: 'Only SELECT is allowed.' }]);
    expect(getLayer('L1')).toMatchObject({ status: 'error', errorMessage: 'Only SELECT is allowed.' });
  });

  it('keeps a layer whose style no longer resolves against the data as an error layer', async () => {
    const state = savedState();
    state.layers[1].style = { type: 'categorized', column: 'gone' };
    const report = await restoreMap(state, fakeQueries());
    expect(report.failed).toEqual([expect.objectContaining({ id: 'L2', code: 'UNKNOWN_COLUMN' })]);
    expect(getLayer('L2')).toMatchObject({ status: 'error', featureCount: 0 });
    expect(getFeatures('L2')).toBeUndefined();
    expect(report.restored).toEqual(['L1', 'L4']);
  });

  it('keeps a layer whose label column is gone as an error layer', async () => {
    const state = savedState();
    state.layers[0].label = { column: 'gone' };
    const report = await restoreMap(state, fakeQueries());
    expect(report.failed).toEqual([expect.objectContaining({ id: 'L1', code: 'UNKNOWN_COLUMN' })]);
  });

  it('answers a query that throws as a failed layer', async () => {
    const queryLayer: Query = async (sql) => {
      if (sql === 'SELECT 2') throw new Error('engine gone\n    at somewhere');
      return { ok: true, data: data() };
    };
    const report = await restoreMap(savedState(), { queryLayer, jumpTo: () => undefined });
    expect(report.failed).toEqual([{ id: 'L2', code: 'ENGINE_UNAVAILABLE', message: 'engine gone' }]);
    expect(report.restored).toEqual(['L1', 'L4']);
  });

  it('takes the saved next layer number, never lower than the restored ids need', async () => {
    await restoreMap({ ...savedState(), nextLayerSeq: 12 }, fakeQueries());
    expect(mapState.nextLayerSeq).toBe(12);
    await restoreMap({ ...savedState(), nextLayerSeq: 1 }, fakeQueries());
    expect(mapState.nextLayerSeq).toBe(5);
    const next = placed({ name: 'new', sql: 'SELECT 5' });
    expect(next.id).toBe('L5');
  });

  it('sets the view after the layers, in the state and on the camera', async () => {
    const events: string[] = [];
    const queries = fakeQueries();
    const jumpTo = vi.fn((center: [number, number], zoom: number) => events.push(`jump ${center.join(',')} ${zoom} after ${queries.calls.length} queries`));
    await restoreMap(savedState(), { queryLayer: queries.queryLayer, jumpTo });
    expect(events).toEqual(['jump 138.5,36.25 7.5 after 3 queries']);
    expect(mapState.view).toEqual({ center: [138.5, 36.25], zoom: 7.5 });
  });

  it('leaves the fitting to nobody: the map view finds no layer that is new to it', async () => {
    await restoreMap(savedState(), fakeQueries());
    expect(mapState.layers.every((layer) => layer.featureCount > 0)).toBe(true);
    expect(pickFitBounds(mapState.layers, fittedLayerIds)).toBeUndefined();
  });

  it('does not let ids of an earlier map hide a layer added afterwards from the map view', async () => {
    fittedLayerIds.add('L5');
    await restoreMap(savedState(), fakeQueries());
    placed({ name: 'new', sql: 'SELECT 5' });
    expect(pickFitBounds(mapState.layers, fittedLayerIds)).toEqual([
      [139, 35],
      [140, 36]
    ]);
  });

  it('reports its progress and ends with none', async () => {
    const seen: ({ done: number; total: number } | null)[] = [];
    const queryLayer: Query = async () => {
      seen.push(restoreProgress.current && { ...restoreProgress.current });
      return { ok: true, data: data() };
    };
    expect(restoreProgress.current).toBeNull();
    await restoreMap(savedState(), { queryLayer, jumpTo: () => undefined });
    expect(seen).toEqual([
      { done: 0, total: 3 },
      { done: 1, total: 3 },
      { done: 2, total: 3 }
    ]);
    expect(restoreProgress.current).toBeNull();
  });

  describe('a state that cannot be trusted', () => {
    it('is refused before the map in use is touched (duplicate ids, a bad id)', async () => {
      mapState.nextLayerSeq = 1;
      placed({ name: 'in use', sql: 'SELECT 9' });
      const queries = fakeQueries();
      const duplicate: PersistedMapState = { ...savedState(), layers: [savedState().layers[0], savedState().layers[0]] };
      const report = await restoreMap(duplicate, queries);
      expect(report.invalid).toEqual(expect.any(String));
      expect(report).toMatchObject({ restored: [], failed: [] });
      const badId: PersistedMapState = { ...savedState(), layers: [{ ...savedState().layers[0], id: 'x1' }] };
      expect((await restoreMap(badId, queries)).invalid).toEqual(expect.any(String));
      expect(queries.calls).toEqual([]);
      expect(layerIds()).toEqual(['L1']);
      expect(getLayer('L1')?.name).toBe('in use');
    });

    it('turns a layer whose geometries are outside degrees into an error layer, as an add refuses it', async () => {
      const outside: LayerQueryResult = { ...data(), bbox: [100000, 3000000, 100500, 3000500] };
      const report = await restoreMap(savedState(), fakeQueries({ 'SELECT 2': { ok: true, data: outside } }));
      expect(report.failed).toEqual([expect.objectContaining({ id: 'L2', code: 'SQL_ERROR' })]);
      expect(report.restored).toEqual(['L1', 'L4']);
      expect(getLayer('L2')).toMatchObject({ status: 'error', featureCount: 0 });
    });
  });

  describe('a layer added while a restore runs', () => {
    it('never takes an id of the saved map', async () => {
      placed({ name: 'old 1', sql: 'SELECT 9' });
      placed({ name: 'old 2', sql: 'SELECT 9' });
      let stray: LayerState | undefined;
      const queryLayer: Query = async (sql) => {
        // A tool call that was already running adds its layer between two restored ones.
        if (sql === 'SELECT 2') stray = placed({ name: 'stray', sql: 'SELECT 5' });
        return { ok: true, data: data() };
      };
      await restoreMap(savedState(), { queryLayer, jumpTo: () => undefined });
      expect(stray?.id).toBe('L5');
      const ids = layerIds();
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.sort()).toEqual(['L1', 'L2', 'L4', 'L5']);
      expect(mapState.nextLayerSeq).toBe(6);
    });
  });

  describe('a second restore while one runs', () => {
    it('cancels the earlier one: it adds nothing more, and the map holds the later one', async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const slow: Query = async () => {
        await gate;
        return { ok: true, data: data() };
      };
      const first = restoreMap(savedState(), { queryLayer: slow, jumpTo: () => undefined });
      const other: PersistedMapState = { ...savedState(), layers: [{ ...savedState().layers[1], id: 'L7', name: '別の地図' }], nextLayerSeq: 8 };
      const second = restoreMap(other, fakeQueries());
      release();
      const [firstReport, secondReport] = await Promise.all([first, second]);
      expect(firstReport).toEqual({ restored: [], failed: [], cancelled: true });
      expect(secondReport).toEqual({ restored: ['L7'], failed: [] });
      expect(layerIds()).toEqual(['L7']);
      expect(restoreProgress.current).toBeNull();
      expect(mapState.nextLayerSeq).toBe(8);
    });

    it('stops after a sign-out reset too, and leaves no progress behind', async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const slow: Query = async () => {
        await gate;
        return { ok: true, data: data() };
      };
      const running = restoreMap(savedState(), { queryLayer: slow, jumpTo: () => undefined });
      resetMapState();
      release();
      expect(await running).toMatchObject({ cancelled: true });
      expect(layerIds()).toEqual([]);
      expect(restoreProgress.current).toBeNull();
    });
  });

  describe('an error layer', () => {
    it('draws nothing, and the model is told it failed', async () => {
      await restoreMap(savedState(), fakeQueries({ 'SELECT 2': toolError('SQL_ERROR', 'Binder Error: no such column') }));
      const failed = mapState.layers.find((layer) => layer.id === 'L2');
      expect(failed && toMapLibreLayers(failed)).toEqual([]);
      const listed = summarizeForLlm().layers.find((layer) => layer.id === 'L2');
      expect(listed).toEqual({ id: 'L2', name: '路線', error: 'Binder Error: no such column', sql: 'SELECT 2' });
    });

    it('is turned into a ready layer when it is replaced', async () => {
      await restoreMap(savedState(), fakeQueries({ 'SELECT 2': toolError('SQL_ERROR', 'bad') }));
      const replaced = replaceLayer('L2', { name: '路線', sql: 'SELECT 2b' }, data());
      expect(replaced.ok && replaced.data).toMatchObject({ status: 'ready', featureCount: 2 });
      expect(getLayer('L2')?.errorMessage).toBeUndefined();
    });

    it('cannot be restyled before it has data', async () => {
      await restoreMap(savedState(), fakeQueries({ 'SELECT 2': toolError('SQL_ERROR', 'bad') }));
      const styled = setStyle('L2', { type: 'single', color: '#000000' } satisfies StyleSpec);
      expect(styled).toMatchObject({ ok: false, error: { code: 'INVALID_STYLE' } });
    });

    it('has no dataset to attribute, and sits at the bottom of the layer list', async () => {
      await restoreMap(savedState(), fakeQueries({ 'SELECT 2': toolError('SQL_ERROR', 'bad') }));
      expect(getLayer('L2')).toMatchObject({ datasetIds: [], geometryType: mapConfig.errorLayerGeometry });
      expect(getLayer('L2')?.resolved).toMatchObject({ type: 'single', color: styleConfig.noDataColor });
    });
  });
});
