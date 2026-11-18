import { beforeEach, describe, expect, it } from 'vitest';
import type { LayerQueryResult } from '../duckdb/queryTypes';
import { pickFitBounds } from '../map/fit';
import { addLayer, mapState, resetMapState } from '../map/mapState.svelte';
import { markingFitted } from './fitRegistration';

const data: LayerQueryResult = {
  features: { type: 'FeatureCollection', features: [{ type: 'Feature', id: 0, geometry: { type: 'Point', coordinates: [139, 35] }, properties: { a: 1 } }] },
  geometryType: 'point',
  columns: [{ name: 'a', type: 'number' }],
  featureCount: 1,
  bbox: [139, 35, 140, 36]
};

describe('markingFitted', () => {
  beforeEach(() => resetMapState());

  it('keeps the map view from fitting a layer the tools added, and only that one', () => {
    const fitted = new Set<string>();
    const added = markingFitted(addLayer, fitted)({ name: 'a', sql: 'SELECT 1' }, data);
    const other = addLayer({ name: 'b', sql: 'SELECT 1' }, data);
    if (!added.ok || !other.ok) throw new Error('add failed');
    expect(fitted).toEqual(new Set([added.data.id]));
    expect(pickFitBounds(mapState.layers, fitted)).toEqual([[139, 35], [140, 36]]);
    expect(fitted.has(other.data.id)).toBe(true);
  });

  it('marks nothing when the layer is refused', () => {
    const fitted = new Set<string>();
    const refused = markingFitted(addLayer, fitted)({ name: 'a', sql: 'SELECT 1', style: { type: 'categorized', column: 'nope' } }, data);
    expect(refused.ok).toBe(false);
    expect(fitted.size).toBe(0);
  });

  it('leaves a layer that was not registered to the map view (it fits it once)', () => {
    const fitted = new Set<string>();
    addLayer({ name: 'a', sql: 'SELECT 1' }, data);
    expect(pickFitBounds(mapState.layers, fitted)).toEqual([[139, 35], [140, 36]]);
  });
});
