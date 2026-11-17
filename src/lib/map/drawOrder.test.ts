import { describe, expect, it } from 'vitest';
import type { GeometryFamily } from '../../../shared/mapSpec';
import { beforeMapLayerId, bottomMapLayerId, inDrawOrder } from './drawOrder';

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
