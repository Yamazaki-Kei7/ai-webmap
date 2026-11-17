import { flushSync } from 'svelte';
import { beforeEach, describe, expect, it } from 'vitest';
import { mapConfig } from '../../../shared/config';
import type { LayerQueryResult } from '../duckdb/queryTypes';
import { addLayer, currentSession, getFeatures, mapState, removeLayer, resetMapState, setVisible } from './mapState.svelte';

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
    const layer = addLayer({ name: '駅', sql: 'SELECT * FROM stations' }, result());
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
    const a = addLayer({ name: 'a', sql: 's' }, result());
    const b = addLayer({ name: 'b', sql: 's' }, result());
    expect(Number(b.id.slice(1))).toBe(Number(a.id.slice(1)) + 1);
    expect(removeLayer(b.id)).toBe(true);
    const c = addLayer({ name: 'c', sql: 's' }, result());
    expect(Number(c.id.slice(1))).toBe(Number(b.id.slice(1)) + 1);
  });

  it('answers false for an unknown layer id', () => {
    addLayer({ name: 'a', sql: 's' }, result());
    expect(removeLayer('nope')).toBe(false);
    expect(mapState.layers).toHaveLength(1);
  });

  it('removes the layer and its features', () => {
    const a = addLayer({ name: 'a', sql: 's' }, result());
    expect(removeLayer(a.id)).toBe(true);
    expect(mapState.layers).toHaveLength(0);
    expect(getFeatures(a.id)).toBeUndefined();
  });

  it('sets the visibility of one layer, and ignores an unknown id', () => {
    const a = addLayer({ name: 'a', sql: 's' }, result());
    const b = addLayer({ name: 'b', sql: 's' }, result());
    setVisible(a.id, false);
    expect(mapState.layers.map((l) => l.visible)).toEqual([false, true]);
    setVisible(a.id, true);
    setVisible('nope', false);
    expect(mapState.layers.map((l) => l.visible)).toEqual([true, true]);
    expect(b.visible).toBe(true);
  });

  it('cycles through the default palette', () => {
    const colors = mapConfig.defaultLayerColors;
    const seen: string[] = [];
    for (let i = 0; i < colors.length + 1; i++) seen.push(addLayer({ name: `n${i}`, sql: 's' }, result()).color);
    expect(new Set(seen.slice(0, colors.length)).size).toBe(colors.length);
    expect(seen[colors.length]).toBe(seen[0]);
    expect(colors).toContain(seen[0]);
  });

  it('keeps the features outside the reactive state, as the very object the query returned', () => {
    const data = result();
    const layer = addLayer({ name: 'a', sql: 's' }, data);
    expect(getFeatures(layer.id)).toBe(data.features);
    expect(JSON.stringify(mapState.layers)).not.toContain('Feature');
    expect('features' in layer).toBe(false);
  });

  it('shows a change to a layer to an effect', () => {
    const layer = addLayer({ name: 'a', sql: 's' }, result());
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
    const layer = addLayer({ name: 'a', sql: 's' }, result());
    layer.visible = false;
    expect(mapState.layers[0].visible).toBe(false);
  });

  it('changes the session number at every reset, and only then', () => {
    const before = currentSession();
    addLayer({ name: 'a', sql: 's' }, result());
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
    const a = addLayer({ name: 'a', sql: 's' }, result());
    resetMapState();
    expect(mapState.layers).toHaveLength(0);
    expect(getFeatures(a.id)).toBeUndefined();
    const b = addLayer({ name: 'b', sql: 's' }, result());
    expect(b.id).not.toBe(a.id);
  });
});
