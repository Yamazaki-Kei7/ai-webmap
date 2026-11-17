import { describe, expect, it } from 'vitest';
import type { GeometryFamily } from '../../../shared/mapSpec';
import { beforeLabelLayerId, beforeMapLayerId, bottomMapLayerId, inDrawOrder, inTopDownOrder, labelMapLayerIds, mapLayerIds } from './drawOrder';

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

describe('beforeMapLayerId', () => {
  const polygon = { id: 'L1', geometryType: 'polygon' as const };
  const line = { id: 'L2', geometryType: 'line' as const };
  const point = { id: 'L3', geometryType: 'point' as const };
  const onMap = (ids: string[]) => (id: string) => ids.includes(id);

  it('goes to the top when nothing above is on the map', () => {
    expect(beforeMapLayerId([polygon, line, point], 0, onMap([]))).toBeUndefined();
    expect(beforeMapLayerId([polygon, line, point], 2, onMap(['L1-fill']))).toBeUndefined();
  });

  it('goes below the nearest layer above that is on the map, skipping layers not on it yet', () => {
    expect(beforeMapLayerId([polygon, line, point], 0, onMap(['L2-line', 'L3-circle']))).toBe('L2-line');
    expect(beforeMapLayerId([polygon, line, point], 0, onMap(['L3-circle']))).toBe('L3-circle');
  });

  // Layers added in one tick are mounted bottom to top, and each map layer is added in that order.
  describe('layers added at once', () => {
    const stack = (all: { id: string; geometryType: GeometryFamily }[], onMapAlready: string[]): string[] => {
      const map = [...onMapAlready];
      const order = inDrawOrder(all);
      order.forEach((layer, index) => {
        if (map.includes(bottomMapLayerId(layer))) return;
        const before = beforeMapLayerId(order, index, (id) => map.includes(id));
        map.splice(before === undefined ? map.length : map.indexOf(before), 0, bottomMapLayerId(layer));
      });
      return map;
    };

    it('stack in the draw order on an empty map', () => {
      expect(stack([point, polygon, line], [])).toEqual(['L1-fill', 'L2-line', 'L3-circle']);
    });

    it('stack below a layer that is already on the map', () => {
      expect(stack([point, line, polygon], ['L3-circle'])).toEqual(['L1-fill', 'L2-line', 'L3-circle']);
    });
  });

  it('looks past a removed layer to the next one above', () => {
    // L2 (line) was between them and is gone from the list.
    expect(beforeMapLayerId([polygon, point], 0, onMap(['L3-circle']))).toBe('L3-circle');
  });
});

describe('labels above all geometry', () => {
  const polygon = { id: 'L1', geometryType: 'polygon' as const };
  const line = { id: 'L2', geometryType: 'line' as const };
  const point = { id: 'L3', geometryType: 'point' as const };
  const onMap = (ids: string[]) => (id: string) => ids.includes(id);

  it('places geometry below the lowest label on the map when no geometry is above it', () => {
    expect(beforeMapLayerId([polygon, point], 1, onMap(['L1-label']))).toBe('L1-label');
    expect(beforeMapLayerId([polygon, point], 0, onMap(['L3-label', 'L1-label']))).toBe('L1-label');
  });

  it('prefers the geometry above over a label', () => {
    expect(beforeMapLayerId([polygon, point], 0, onMap(['L3-circle', 'L1-label']))).toBe('L3-circle');
  });

  it('places a label below the nearest label above it that is on the map, else on top', () => {
    expect(beforeLabelLayerId([polygon, line, point], 0, onMap(['L3-label', 'L1-circle']))).toBe('L3-label');
    expect(beforeLabelLayerId([polygon, line, point], 0, onMap(['L2-label', 'L3-label']))).toBe('L2-label');
    expect(beforeLabelLayerId([polygon, line, point], 2, onMap(['L1-label']))).toBeUndefined();
    expect(beforeLabelLayerId([polygon, line, point], 0, onMap(['L3-circle']))).toBeUndefined();
  });

  // The map view mounts each layer's map layers inside its source (so a removal takes the label before the source):
  // layer by layer in the draw order, geometry then label. Layers rendered together cannot see each other on the map
  // (every `beforeId` is picked against what was on the map before), so the labels are moved to the top afterwards.
  describe('layers added in one tick', () => {
    const stack = (all: { id: string; geometryType: GeometryFamily }[], withLabel: string[], onMapAlready: string[], reorder: boolean): string[] => {
      const before = [...onMapAlready];
      const map = [...onMapAlready];
      const order = inDrawOrder(all);
      const seen = (id: string) => before.includes(id);
      const insert = (id: string, beforeId: string | undefined) => map.splice(beforeId === undefined ? map.length : map.indexOf(beforeId), 0, id);
      order.forEach((layer, index) => {
        if (!seen(bottomMapLayerId(layer))) insert(bottomMapLayerId(layer), beforeMapLayerId(order, index, seen));
        if (withLabel.includes(layer.id) && !seen(`${layer.id}-label`)) insert(`${layer.id}-label`, beforeLabelLayerId(order, index, seen));
      });
      if (!reorder) return map;
      const labels = labelMapLayerIds(order.map((layer) => ({ id: layer.id, label: withLabel.includes(layer.id) || seen(`${layer.id}-label`) ? {} : null })));
      return [...map.filter((id) => !labels.includes(id)), ...labels.filter((id) => map.includes(id))];
    };

    it('would leave a label under the geometry of the next layer without the move', () => {
      expect(stack([polygon, point], ['L1', 'L3'], [], false)).toEqual(['L1-fill', 'L1-label', 'L3-circle', 'L3-label']);
    });

    it('put every label above all geometry, in draw order', () => {
      expect(stack([polygon, point], ['L1', 'L3'], [], true)).toEqual(['L1-fill', 'L3-circle', 'L1-label', 'L3-label']);
      expect(stack([point, polygon, line], ['L1', 'L3'], [], true)).toEqual(['L1-fill', 'L2-line', 'L3-circle', 'L1-label', 'L3-label']);
    });

    it('put a layer added later below the labels already on the map', () => {
      const added = { id: 'L4', geometryType: 'polygon' as const };
      expect(stack([polygon, added], [], ['L1-fill', 'L1-label'], true)).toEqual(['L1-fill', 'L4-fill', 'L1-label']);
    });
  });

  it('lists the labels in draw order, only for layers that have one', () => {
    expect(labelMapLayerIds([{ id: 'L1', label: {} }, { id: 'L2', label: null }, { id: 'L3', label: {} }])).toEqual(['L1-label', 'L3-label']);
  });
});
