import { describe, expect, it } from 'vitest';
import type { GeometryFamily } from '../../../shared/mapSpec';
import { mapConfig } from '../../../shared/config';
import { beforeLabelLayerId, beforeMapLayerId, bottomMapLayerId, inDrawOrder, inTopDownOrder, mapLayerIds } from './drawOrder';

describe('inDrawOrder', () => {
  it('puts polygons below lines below points, and keeps the order added within a family', () => {
    const layers = [
      { id: 'L1', geometryType: 'point' as const },
      { id: 'L2', geometryType: 'polygon' as const },
      { id: 'L3', geometryType: 'line' as const },
      { id: 'L4', geometryType: 'polygon' as const },
      { id: 'L5', geometryType: 'point' as const }
    ];
    expect(inDrawOrder(layers).map((l) => l.id)).toEqual(['L2', 'L4', 'L3', 'L1', 'L5']);
    expect(layers[0].id).toBe('L1');
  });
});

describe('inTopDownOrder', () => {
  it('is the draw order read from the top: points first, the newest first within a family', () => {
    const layers = [
      { id: 'L1', geometryType: 'point' as const },
      { id: 'L2', geometryType: 'polygon' as const },
      { id: 'L3', geometryType: 'line' as const },
      { id: 'L4', geometryType: 'polygon' as const },
      { id: 'L5', geometryType: 'point' as const }
    ];
    expect(inTopDownOrder(layers).map((l) => l.id)).toEqual(['L5', 'L1', 'L3', 'L4', 'L2']);
    expect(inTopDownOrder(layers).map((l) => l.id)).toEqual(inDrawOrder(layers).map((l) => l.id).reverse());
    expect(layers[0].id).toBe('L1');
  });
});

describe('mapLayerIds', () => {
  it('derives the source and every map layer id from the layer id', () => {
    expect(mapLayerIds('L7')).toEqual({
      source: 'L7',
      labelSource: 'L7-label-points',
      fill: 'L7-fill',
      outline: 'L7-outline',
      line: 'L7-line',
      circle: 'L7-circle',
      label: 'L7-label'
    });
  });
});

describe('bottomMapLayerId', () => {
  it('names the lowest map layer of each family', () => {
    expect(bottomMapLayerId({ id: 'L1', geometryType: 'polygon' })).toBe('L1-fill');
    expect(bottomMapLayerId({ id: 'L2', geometryType: 'line' })).toBe('L2-line');
    expect(bottomMapLayerId({ id: 'L3', geometryType: 'point' })).toBe('L3-circle');
  });
});

const anchor = mapConfig.labelAnchorLayerId;

describe('beforeMapLayerId', () => {
  const polygon = { id: 'L1', geometryType: 'polygon' as const };
  const line = { id: 'L2', geometryType: 'line' as const };
  const point = { id: 'L3', geometryType: 'point' as const };
  const onMap = (ids: string[]) => (id: string) => ids.includes(id);

  it('goes below the anchor when nothing above is on the map', () => {
    expect(beforeMapLayerId([polygon, line, point], 0, onMap([]))).toBe(anchor);
    expect(beforeMapLayerId([polygon, line, point], 2, onMap(['L1-fill']))).toBe(anchor);
  });

  it('goes below the nearest layer above that is on the map, skipping layers not on it yet', () => {
    expect(beforeMapLayerId([polygon, line, point], 0, onMap(['L2-line', 'L3-circle']))).toBe('L2-line');
    expect(beforeMapLayerId([polygon, line, point], 0, onMap(['L3-circle']))).toBe('L3-circle');
  });

  it('looks past a removed layer to the next one above', () => {
    // L2 (line) was between them and is gone from the list.
    expect(beforeMapLayerId([polygon, point], 0, onMap(['L3-circle']))).toBe('L3-circle');
  });

  it('ignores a label: geometry is below the anchor, labels are above it', () => {
    expect(beforeMapLayerId([polygon, point], 1, onMap(['L1-label']))).toBe(anchor);
    expect(beforeMapLayerId([polygon, point], 0, onMap(['L3-label', 'L1-label']))).toBe(anchor);
    expect(beforeMapLayerId([polygon, point], 0, onMap(['L3-circle', 'L1-label']))).toBe('L3-circle');
  });
});

describe('beforeLabelLayerId', () => {
  const polygon = { id: 'L1', geometryType: 'polygon' as const };
  const line = { id: 'L2', geometryType: 'line' as const };
  const point = { id: 'L3', geometryType: 'point' as const };
  const onMap = (ids: string[]) => (id: string) => ids.includes(id);

  it('goes below the nearest label above it that is on the map, else on top', () => {
    expect(beforeLabelLayerId([polygon, line, point], 0, onMap(['L3-label', 'L1-circle']))).toBe('L3-label');
    expect(beforeLabelLayerId([polygon, line, point], 0, onMap(['L2-label', 'L3-label']))).toBe('L2-label');
    expect(beforeLabelLayerId([polygon, line, point], 2, onMap(['L1-label']))).toBeUndefined();
    expect(beforeLabelLayerId([polygon, line, point], 0, onMap(['L3-circle']))).toBeUndefined();
  });
});

/*
 * The map view mounts each layer's map layers inside its source, layer by layer in the draw order (geometry, then label),
 * after the anchor. Layers rendered together cannot see each other on the map (every `beforeId` is picked against what was
 * on the map before the tick), so these simulate MapLibre's `addLayer(layer, beforeId)` and `removeLayer`.
 */
describe('the stack of map layers', () => {
  type Item = { id: string; geometryType: GeometryFamily };
  const polygon: Item = { id: 'L1', geometryType: 'polygon' };
  const line: Item = { id: 'L2', geometryType: 'line' };
  const point: Item = { id: 'L3', geometryType: 'point' };
  const later: Item = { id: 'L4', geometryType: 'polygon' };

  /** The map layers after one tick that adds `all` (those not on the map yet); `withLabel` are the ids that have a label. Starts from `onMap`, bottom to top. */
  const tick = (all: Item[], withLabel: string[], onMap: string[]): string[] => {
    const before = [...onMap];
    const map = [...onMap];
    const seen = (id: string) => before.includes(id);
    const insert = (id: string, beforeId: string | undefined) => {
      if (beforeId !== undefined && !map.includes(beforeId)) return; // MapLibre refuses a layer before one that does not exist.
      map.splice(beforeId === undefined ? map.length : map.indexOf(beforeId), 0, id);
    };
    if (!map.includes(anchor)) map.push(anchor);
    const order = inDrawOrder(all);
    order.forEach((layer, index) => {
      if (!seen(bottomMapLayerId(layer))) insert(bottomMapLayerId(layer), beforeMapLayerId(order, index, seen));
      if (withLabel.includes(layer.id) && !seen(`${layer.id}-label`)) insert(`${layer.id}-label`, beforeLabelLayerId(order, index, seen));
    });
    return map;
  };

  const remove = (map: string[], ...ids: string[]): string[] => map.filter((id) => !ids.includes(id));

  it('puts every label above all geometry, in draw order, for layers added in one tick', () => {
    expect(tick([polygon, point], ['L1', 'L3'], [])).toEqual(['L1-fill', 'L3-circle', anchor, 'L1-label', 'L3-label']);
    expect(tick([point, polygon, line], ['L1', 'L3'], [])).toEqual(['L1-fill', 'L2-line', 'L3-circle', anchor, 'L1-label', 'L3-label']);
  });

  it('stacks geometry in the draw order on an empty map', () => {
    expect(tick([point, polygon, line], [], [])).toEqual(['L1-fill', 'L2-line', 'L3-circle', anchor]);
  });

  it('stacks the new geometry below a layer that is already on the map', () => {
    expect(tick([point, line, polygon], [], ['L3-circle', anchor])).toEqual(['L1-fill', 'L2-line', 'L3-circle', anchor]);
  });

  it('puts a layer added later below the labels already on the map', () => {
    const first = tick([polygon], ['L1'], []);
    expect(tick([polygon, later], [], first)).toEqual(['L1-fill', 'L4-fill', anchor, 'L1-label']);
  });

  it('puts the label of a layer added later above the labels already on the map, and above all geometry', () => {
    const first = tick([polygon, point], ['L1'], []);
    expect(tick([polygon, point, later], ['L4'], first)).toEqual(['L1-fill', 'L4-fill', 'L3-circle', anchor, 'L1-label', 'L4-label']);
  });

  it('keeps the order when a labelled layer is removed (the remaining labels stay above the geometry)', () => {
    const first = tick([polygon, line, point], ['L1', 'L2', 'L3'], []);
    expect(remove(first, 'L2-line', 'L2-label')).toEqual(['L1-fill', 'L3-circle', anchor, 'L1-label', 'L3-label']);
    const second = tick([polygon, point, later], ['L4'], remove(first, 'L2-line', 'L2-label'));
    expect(second).toEqual(['L1-fill', 'L4-fill', 'L3-circle', anchor, 'L1-label', 'L4-label', 'L3-label']);
  });
});
