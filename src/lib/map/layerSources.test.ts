import { describe, expect, it } from 'vitest';
import { mapConfig } from '../../../shared/config';
import type { LabelSpec } from '../../../shared/mapSpec';
import type { GeoJsonFeatureCollection } from '../duckdb/queryTypes';
import { beforeLabelLayerId, beforeMapLayerId, inDrawOrder } from './drawOrder';
import { mapSourcesOf } from './layerSources';
import type { StyledLayer } from './styleCompiler';

const polygonData = (n: number): GeoJsonFeatureCollection => ({
  type: 'FeatureCollection',
  features: Array.from({ length: n }, (_, id) => ({
    type: 'Feature' as const,
    id,
    geometry: { type: 'Polygon' as const, coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] },
    properties: { name: `n${id}` }
  }))
});

const common = { opacity: 0.5, strokeColor: '#000000' as const, strokeWidth: 1, size: 3 };

function layer(id: string, geometryType: StyledLayer['geometryType'], label: LabelSpec | null): StyledLayer {
  return { id, geometryType, visible: true, label, resolved: { type: 'single', color: '#112233', common } };
}

const data: Record<string, GeoJsonFeatureCollection> = {};
const featuresOf = (id: string) => data[id];

describe('mapSourcesOf', () => {
  it('gives a labelled polygon layer its own source with the geometry, and a point source with the label layer', () => {
    data.L1 = polygonData(2);
    const sources = mapSourcesOf([layer('L1', 'polygon', { column: 'name' })], featuresOf);
    expect(sources.map((s) => s.id)).toEqual(['L1', 'L1-label-points']);
    expect(sources[0].layers.map((l) => l.id)).toEqual(['L1-fill', 'L1-outline']);
    expect(sources[1].layers.map((l) => [l.id, l.type, l.source])).toEqual([['L1-label', 'symbol', 'L1-label-points']]);
    // One point per feature, with the properties the label reads.
    expect(sources[1].data.features.map((f) => [f.geometry.type, f.properties.name])).toEqual([['Point', 'n0'], ['Point', 'n1']]);
  });

  it('has no label source for a polygon layer without a label, and keeps the labels of points and lines on their own source', () => {
    data.L1 = polygonData(1);
    data.L2 = polygonData(1);
    expect(mapSourcesOf([layer('L1', 'polygon', null)], featuresOf).map((s) => s.id)).toEqual(['L1']);
    for (const family of ['point', 'line'] as const) {
      const sources = mapSourcesOf([layer('L2', family, { column: 'name' })], featuresOf);
      expect(sources.map((s) => s.id)).toEqual(['L2']);
      expect(sources[0].layers.some((l) => l.id === 'L2-label')).toBe(true);
    }
  });

  it('drops the label source when the label is removed, and both sources when the layer is removed', () => {
    data.L1 = polygonData(1);
    const labelled = layer('L1', 'polygon', { column: 'name' });
    expect(mapSourcesOf([labelled], featuresOf).map((s) => s.id)).toEqual(['L1', 'L1-label-points']);
    expect(mapSourcesOf([{ ...labelled, label: null }], featuresOf).map((s) => s.id)).toEqual(['L1']);
    expect(mapSourcesOf([], featuresOf)).toEqual([]);
  });

  it('has no source for a layer without features (a failed layer or one not loaded)', () => {
    delete data.L9;
    expect(mapSourcesOf([layer('L9', 'polygon', { column: 'name' })], featuresOf)).toEqual([]);
  });

  it('rebuilds the label points when the layer gets new data (replaceLayerId), and keeps them while the data is the same', () => {
    data.L1 = polygonData(2);
    const labelled = layer('L1', 'polygon', { column: 'name' });
    const before = mapSourcesOf([labelled], featuresOf)[1].data;
    expect(mapSourcesOf([labelled], featuresOf)[1].data).toBe(before);
    data.L1 = polygonData(3);
    const after = mapSourcesOf([labelled], featuresOf)[1].data;
    expect(after).not.toBe(before);
    expect(after.features).toHaveLength(3);
  });

  it('keeps labels above all geometry: the label layers go above the anchor, the geometry below it', () => {
    data.L1 = polygonData(1);
    data.L2 = polygonData(1);
    const bottomUp = inDrawOrder([layer('L1', 'polygon', { column: 'name' }), layer('L2', 'point', { column: 'name' })]);
    const sources = mapSourcesOf(bottomUp, featuresOf);
    const none = () => false;
    for (const source of sources) {
      for (const spec of source.layers) {
        if (spec.type === 'symbol') expect(beforeLabelLayerId(bottomUp, source.index, none)).toBeUndefined();
        else expect(beforeMapLayerId(bottomUp, source.index, none)).toBe(mapConfig.labelAnchorLayerId);
      }
    }
    // The polygon's label is below the label of the layer above it once that is on the map.
    const onMap = (id: string) => id === 'L2-label';
    expect(beforeLabelLayerId(bottomUp, sources.find((s) => s.id === 'L1-label-points')?.index ?? -1, onMap)).toBe('L2-label');
  });

  it('gives the identical data objects on every call while the data is the same, so a source is not sent its data again', () => {
    data.L1 = polygonData(2);
    data.L2 = polygonData(2);
    const layers = [layer('L1', 'polygon', { column: 'name' }), layer('L2', 'polygon', null)];
    const first = mapSourcesOf(layers, featuresOf);
    // Another layer changes (here: its style and visibility): new layer objects, same data.
    const changed = [layers[0], { ...layers[1], visible: false, resolved: { type: 'single' as const, color: '#ff0000' as const, common } }];
    const second = mapSourcesOf(changed, featuresOf);
    expect(second.map((s) => s.id)).toEqual(first.map((s) => s.id));
    second.forEach((source, i) => expect(source.data).toBe(first[i].data));
  });
});
