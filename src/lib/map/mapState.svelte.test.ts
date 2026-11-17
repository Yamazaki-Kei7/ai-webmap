import { LngLat } from 'maplibre-gl';
import { flushSync } from 'svelte';
import { beforeEach, describe, expect, it } from 'vitest';
import { mapConfig } from '../../../shared/config';
import { mapContextSchema, type GeometryFamily, type StyleSpec } from '../../../shared/mapSpec';
import type { ClientToolResult } from '../../../shared/toolProtocol';
import type { GeoJsonGeometry, JsonRow, LayerQueryResult } from '../duckdb/queryTypes';
import {
  addLayer,
  currentSession,
  getFeatures,
  mapState,
  removeLayer,
  replaceLayer,
  resetMapState,
  setLabel,
  setStyle,
  setView,
  setVisible,
  summarizeForLlm,
  type LayerState,
  type NewLayer
} from './mapState.svelte';

function added(input: NewLayer, data: LayerQueryResult): LayerState {
  const result = addLayer(input, data);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}

function result(geometryType: LayerQueryResult['geometryType'] = 'point'): LayerQueryResult {
  return {
    features: {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', id: 0, geometry: { type: 'Point', coordinates: [139, 35] }, properties: { name: 'a' } }]
    },
    geometryType,
    columns: [{ name: 'name', type: 'string' }],
    featureCount: 1,
    bbox: [139, 35, 139, 35]
  };
}

describe('mapState', () => {
  beforeEach(() => {
    resetMapState();
  });

  it('adds a layer with a short id, the query facts and a visible ready state', () => {
    const layer = added({ name: '駅', sql: 'SELECT * FROM stations' }, result());
    expect(layer).toMatchObject({
      name: '駅',
      sql: 'SELECT * FROM stations',
      geometryType: 'point',
      featureCount: 1,
      bbox: [139, 35, 139, 35],
      visible: true,
      status: 'ready'
    });
    expect(layer.id).toMatch(/^L\d+$/);
    expect(mapState.layers.map((l) => l.id)).toEqual([layer.id]);
  });

  it('numbers ids upwards and never reuses one after a removal', () => {
    const a = added({ name: 'a', sql: 's' }, result());
    const b = added({ name: 'b', sql: 's' }, result());
    expect(Number(b.id.slice(1))).toBe(Number(a.id.slice(1)) + 1);
    expect(removeLayer(b.id)).toBe(true);
    const c = added({ name: 'c', sql: 's' }, result());
    expect(Number(c.id.slice(1))).toBe(Number(b.id.slice(1)) + 1);
  });

  it('answers false for an unknown layer id', () => {
    added({ name: 'a', sql: 's' }, result());
    expect(removeLayer('nope')).toBe(false);
    expect(mapState.layers).toHaveLength(1);
  });

  it('removes the layer and its features', () => {
    const a = added({ name: 'a', sql: 's' }, result());
    expect(removeLayer(a.id)).toBe(true);
    expect(mapState.layers).toHaveLength(0);
    expect(getFeatures(a.id)).toBeUndefined();
  });

  it('sets the visibility of one layer, and ignores an unknown id', () => {
    const a = added({ name: 'a', sql: 's' }, result());
    const b = added({ name: 'b', sql: 's' }, result());
    setVisible(a.id, false);
    expect(mapState.layers.map((l) => l.visible)).toEqual([false, true]);
    setVisible(a.id, true);
    setVisible('nope', false);
    expect(mapState.layers.map((l) => l.visible)).toEqual([true, true]);
    expect(b.visible).toBe(true);
  });

  it('gives layers a single colour from the default palette, cycling through it', () => {
    const colors = mapConfig.defaultLayerColors;
    const seen: string[] = [];
    for (let i = 0; i < colors.length + 1; i++) {
      const { style } = added({ name: `n${i}`, sql: 's' }, result());
      seen.push(style.type === 'single' ? style.color : '');
    }
    expect(new Set(seen.slice(0, colors.length)).size).toBe(colors.length);
    expect(seen[colors.length]).toBe(seen[0]);
    expect(colors).toContain(seen[0]);
  });

  it('keeps the features outside the reactive state, as the very object the query returned', () => {
    const data = result();
    const layer = added({ name: 'a', sql: 's' }, data);
    expect(getFeatures(layer.id)).toBe(data.features);
    expect(JSON.stringify(mapState.layers)).not.toContain('Feature');
    expect('features' in layer).toBe(false);
  });

  it('shows a change to a layer to an effect', () => {
    const layer = added({ name: 'a', sql: 's' }, result());
    const seen: boolean[] = [];
    const cleanup = $effect.root(() => {
      $effect(() => {
        seen.push(mapState.layers.every((l) => l.visible));
      });
    });
    flushSync();
    setVisible(layer.id, false);
    flushSync();
    cleanup();
    expect(seen).toEqual([true, false]);
  });

  it('hands back the reactive layer: a change to it shows in the state', () => {
    const layer = added({ name: 'a', sql: 's' }, result());
    layer.visible = false;
    expect(mapState.layers[0].visible).toBe(false);
  });

  it('changes the session number at every reset, and only then', () => {
    const before = currentSession();
    added({ name: 'a', sql: 's' }, result());
    expect(currentSession()).toBe(before);
    resetMapState();
    expect(currentSession()).not.toBe(before);
  });

  it('puts the view back to the start at sign-out', () => {
    mapState.view = { center: [10, 20], zoom: 9 };
    resetMapState();
    expect(mapState.view).toEqual({ center: [...mapConfig.initialView.center], zoom: mapConfig.initialView.zoom });
  });

  it('clears all layers and features at sign-out, and goes on counting ids', () => {
    const a = added({ name: 'a', sql: 's' }, result());
    resetMapState();
    expect(mapState.layers).toHaveLength(0);
    expect(getFeatures(a.id)).toBeUndefined();
    const b = added({ name: 'b', sql: 's' }, result());
    expect(b.id).not.toBe(a.id);
  });
});

function table(rows: JsonRow[], geometryType: GeometryFamily = 'point'): LayerQueryResult {
  const geometry: Record<GeometryFamily, GeoJsonGeometry> = {
    point: { type: 'Point', coordinates: [139, 35] },
    line: { type: 'LineString', coordinates: [[139, 35], [140, 36]] },
    polygon: { type: 'Polygon', coordinates: [[[139, 35], [140, 35], [140, 36], [139, 35]]] }
  };
  const names = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return {
    features: { type: 'FeatureCollection', features: rows.map((properties, id) => ({ type: 'Feature', id, geometry: geometry[geometryType], properties })) },
    geometryType,
    columns: names.map((name) => ({ name, type: typeof rows[0][name] === 'number' ? 'number' : 'string' })),
    featureCount: rows.length,
    bbox: [139, 35, 140, 36]
  };
}

const people = table([
  { name: 'a', n: 1, kind: 'x' },
  { name: 'b', n: 5, kind: 'y' },
  { name: 'c', n: 9, kind: 'x' }
]);
const graduated: StyleSpec = { type: 'graduated', column: 'n', method: 'equal', classes: 2 };

/** The default colour of a layer: the default colours cycled by the number in its id. */
const defaultColorOf = (layer: LayerState): string =>
  mapConfig.defaultLayerColors[(Number(layer.id.slice(1)) - 1) % mapConfig.defaultLayerColors.length];

function failure<T>(result: ClientToolResult<T>) {
  if (result.ok) throw new Error('expected an error');
  return result.error;
}

describe('layer style and label', () => {
  beforeEach(() => {
    resetMapState();
  });

  it('gives a layer without a style the next default colour as a single style, resolved, and no label', () => {
    const a = added({ name: 'a', sql: 's' }, people);
    const b = added({ name: 'b', sql: 's' }, people);
    expect(a.style).toEqual({ type: 'single', color: defaultColorOf(a) });
    expect(b.style).toEqual({ type: 'single', color: defaultColorOf(b) });
    expect(defaultColorOf(b)).not.toBe(defaultColorOf(a));
    expect(a.resolved).toMatchObject({ type: 'single', color: defaultColorOf(a) });
    expect(a.label).toBeNull();
    expect('color' in a).toBe(false);
  });

  it('adds a layer with the given style and label, resolved against its features', () => {
    const layer = added({ name: 'a', sql: 's', style: graduated, label: { column: 'name' } }, people);
    expect(layer.style).toEqual(graduated);
    expect(layer.resolved).toMatchObject({ type: 'graduated', column: 'n' });
    expect(layer.label).toEqual({ column: 'name' });
  });

  it('adds nothing and spends no id when the given style does not resolve', () => {
    const before = mapState.nextLayerSeq;
    const error = failure(addLayer({ name: 'a', sql: 's', style: { type: 'graduated', column: 'nope', method: 'equal' } }, people));
    expect(error.code).toBe('UNKNOWN_COLUMN');
    expect(failure(addLayer({ name: 'a', sql: 's', style: { type: 'proportional', column: 'n', color: '#ff0000' } }, table([{ n: 1 }], 'polygon'))).code).toBe('INVALID_STYLE');
    expect(mapState.layers).toHaveLength(0);
    expect(mapState.nextLayerSeq).toBe(before);
  });

  it('adds nothing when the label names a column the layer lacks, and says which columns exist', () => {
    const error = failure(addLayer({ name: 'a', sql: 's', label: { column: 'nope' } }, people));
    expect(error).toMatchObject({ code: 'UNKNOWN_COLUMN', hint: 'Columns: name, n, kind.' });
    expect(mapState.layers).toHaveLength(0);
  });

  describe('setStyle', () => {
    it('resolves the style against the held features, without touching them', () => {
      const layer = added({ name: 'a', sql: 's' }, people);
      const features = getFeatures(layer.id);
      const result = setStyle(layer.id, graduated);
      expect(result.ok).toBe(true);
      expect(layer.style).toEqual(graduated);
      expect(layer.resolved).toMatchObject({ type: 'graduated' });
      expect(getFeatures(layer.id)).toBe(features);
    });

    it('changes nothing on an error', () => {
      const layer = added({ name: 'a', sql: 's', style: graduated }, people);
      const style = $state.snapshot(layer.style);
      const resolved = $state.snapshot(layer.resolved);
      expect(failure(setStyle(layer.id, { type: 'categorized', column: 'nope' })).code).toBe('UNKNOWN_COLUMN');
      expect($state.snapshot(layer.style)).toEqual(style);
      expect($state.snapshot(layer.resolved)).toEqual(resolved);
    });

    it('answers UNKNOWN_LAYER for an unknown id, and names the layers there are', () => {
      expect(failure(setStyle('L99', graduated))).toMatchObject({ code: 'UNKNOWN_LAYER', hint: 'Layers: none.' });
      const layer = added({ name: 'a', sql: 's' }, people);
      expect(failure(setStyle('L99', graduated)).hint).toBe(`Layers: ${layer.id}.`);
    });

    it('shows the change to an effect', () => {
      const layer = added({ name: 'a', sql: 's' }, people);
      const seen: string[] = [];
      const cleanup = $effect.root(() => {
        $effect(() => {
          seen.push(mapState.layers[0].resolved.type);
        });
      });
      flushSync();
      setStyle(layer.id, graduated);
      flushSync();
      cleanup();
      expect(seen).toEqual(['single', 'graduated']);
    });
  });

  describe('setLabel', () => {
    it('sets and clears the label', () => {
      const layer = added({ name: 'a', sql: 's' }, people);
      expect(setLabel(layer.id, { column: 'name', size: 14 }).ok).toBe(true);
      expect(layer.label).toEqual({ column: 'name', size: 14 });
      expect(setLabel(layer.id, null).ok).toBe(true);
      expect(layer.label).toBeNull();
    });

    it('refuses a column the layer lacks, and keeps the old label', () => {
      const layer = added({ name: 'a', sql: 's', label: { column: 'name' } }, people);
      expect(failure(setLabel(layer.id, { column: 'nope' })).code).toBe('UNKNOWN_COLUMN');
      expect(layer.label).toEqual({ column: 'name' });
    });

    it('answers UNKNOWN_LAYER for an unknown id', () => {
      expect(failure(setLabel('L99', null)).code).toBe('UNKNOWN_LAYER');
    });
  });

  describe('replaceLayer', () => {
    it('keeps the id, the place in the draw order and the visibility, and takes the new data', () => {
      const a = added({ name: 'a', sql: 's' }, people);
      const b = added({ name: 'b', sql: 's' }, people);
      const c = added({ name: 'c', sql: 's' }, people);
      setVisible(b.id, false);
      const fresh = table([{ name: 'z', n: 2, kind: 'q' }]);
      const result = replaceLayer(b.id, { name: 'b2', sql: 'new' }, fresh);
      expect(result.ok).toBe(true);
      expect(mapState.layers.map((l) => l.id)).toEqual([a.id, b.id, c.id]);
      expect(mapState.layers[1]).toMatchObject({ name: 'b2', sql: 'new', visible: false, featureCount: 1 });
      expect(getFeatures(b.id)).toBe(fresh.features);
    });

    it('keeps the old style and label while they fit the new data', () => {
      const layer = added({ name: 'a', sql: 's', style: graduated, label: { column: 'name' } }, people);
      replaceLayer(layer.id, { name: 'a', sql: 's2' }, table([{ name: 'p', n: 1 }, { name: 'q', n: 7 }]));
      expect(layer.style).toEqual(graduated);
      expect(layer.label).toEqual({ column: 'name' });
    });

    it('falls back to the default single style and no label when the old ones do not fit', () => {
      const layer = added({ name: 'a', sql: 's', style: graduated, label: { column: 'name' } }, people);
      replaceLayer(layer.id, { name: 'a', sql: 's2' }, table([{ other: 'p' }]));
      expect(layer.style).toEqual({ type: 'single', color: defaultColorOf(layer) });
      expect(layer.resolved.type).toBe('single');
      expect(layer.label).toBeNull();
    });

    it('takes the given style and label, and null clears the label', () => {
      const layer = added({ name: 'a', sql: 's', label: { column: 'name' } }, people);
      replaceLayer(layer.id, { name: 'a', sql: 's', style: graduated, label: null }, people);
      expect(layer.style).toEqual(graduated);
      expect(layer.label).toBeNull();
    });

    it('changes nothing when a given style or label fails', () => {
      const layer = added({ name: 'a', sql: 's', style: graduated }, people);
      const features = getFeatures(layer.id);
      expect(failure(replaceLayer(layer.id, { name: 'b', sql: 'x', style: { type: 'categorized', column: 'nope' } }, table([{ n: 1 }]))).code).toBe('UNKNOWN_COLUMN');
      expect(failure(replaceLayer(layer.id, { name: 'b', sql: 'x', label: { column: 'nope' } }, table([{ n: 1 }]))).code).toBe('UNKNOWN_COLUMN');
      expect(layer).toMatchObject({ name: 'a', sql: 's', featureCount: 3 });
      expect(layer.style).toEqual(graduated);
      expect(getFeatures(layer.id)).toBe(features);
    });

    it('answers UNKNOWN_LAYER for an unknown id', () => {
      expect(failure(replaceLayer('L99', { name: 'a', sql: 's' }, people)).code).toBe('UNKNOWN_LAYER');
    });

    it('shows the new data to an effect', () => {
      const layer = added({ name: 'a', sql: 's' }, people);
      const seen: (number | undefined)[] = [];
      const cleanup = $effect.root(() => {
        $effect(() => {
          seen.push(getFeatures(layer.id)?.features.length);
        });
      });
      flushSync();
      replaceLayer(layer.id, { name: 'a', sql: 's' }, table([{ n: 1 }]));
      flushSync();
      cleanup();
      expect(seen).toEqual([3, 1]);
    });
  });

  describe('summarizeForLlm', () => {
    it('lists the view and each layer with its style, label and applied summary, and validates against the schema', () => {
      mapState.view = { center: [139.7, 35.7], zoom: 9 };
      added({ name: 'people', sql: 'SELECT * FROM people', style: graduated, label: { column: 'name' } }, people);
      added({ name: 'kinds', sql: 's', style: { type: 'categorized', column: 'kind' } }, people);
      const context = summarizeForLlm();
      expect(mapContextSchema.parse(context)).toEqual(context);
      expect(context.view).toEqual({ center: [139.7, 35.7], zoom: 9 });
      expect(context.layers[0]).toMatchObject({
        id: expect.stringMatching(/^L\d+$/),
        name: 'people',
        geometryType: 'point',
        featureCount: 3,
        visible: true,
        columns: [{ name: 'name', type: 'string' }, { name: 'n', type: 'number' }, { name: 'kind', type: 'string' }],
        columnCount: 3,
        style: graduated,
        label: { column: 'name' },
        applied: { type: 'graduated', breaks: [5], min: 1, max: 9, nullCount: 0 }
      });
      expect('applied' in context.layers[1] && context.layers[1].applied).toMatchObject({
        type: 'categorized',
        categories: [{ value: 'x', count: 2 }, { value: 'y', count: 1 }],
        categoryCount: 2,
        other: null
      });
    });

    it('never holds a feature', () => {
      added({ name: 'a', sql: 's' }, people);
      const text = JSON.stringify(summarizeForLlm());
      expect(text).not.toContain('Feature');
      expect(text).not.toContain('coordinates');
    });

    it('keeps a centre the map wrapped valid for the schema, where the unwrapped one is not', () => {
      setView(new LngLat(190, 35).wrap(), 5);
      expect(mapContextSchema.safeParse(summarizeForLlm()).success).toBe(true);
      setView(new LngLat(190, 35), 5);
      expect(mapContextSchema.safeParse(summarizeForLlm()).success).toBe(false);
    });
  });
});
