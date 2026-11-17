import type { GeometryFamily } from '../../../shared/mapSpec';

/** Polygons are drawn below lines, and lines below points. */
const familyRank: Record<GeometryFamily, number> = { polygon: 0, line: 1, point: 2 };

type Ordered = { geometryType: GeometryFamily };

/** The layers from the bottom to the top of the map: by family, and within one family in the order given (the order added). */
export function inDrawOrder<T extends Ordered>(layers: readonly T[]): T[] {
  return [...layers].sort((a, b) => familyRank[a.geometryType] - familyRank[b.geometryType]);
}

/** The id of the layer's lowest map layer: what the layer below it in the draw order is placed before. */
export function bottomMapLayerId(layer: { id: string; geometryType: GeometryFamily }): string {
  const suffix: Record<GeometryFamily, string> = { polygon: 'fill', line: 'line', point: 'circle' };
  return `${layer.id}-${suffix[layer.geometryType]}`;
}

/**
 * The map layer the layer at `index` of `bottomUp` goes below: the lowest map layer of the nearest layer above it that
 * is already on the map; undefined (the top) when there is none. Map layers are added after the render, so layers added
 * together find none of each other: with the layers listed bottom to top they are added in that order and stack right.
 */
export function beforeMapLayerId(
  bottomUp: readonly { id: string; geometryType: GeometryFamily }[],
  index: number,
  existsOnMap: (mapLayerId: string) => boolean
): string | undefined {
  return bottomUp.slice(index + 1).map(bottomMapLayerId).find(existsOnMap);
}
