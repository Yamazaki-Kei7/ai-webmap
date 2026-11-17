import type { GeometryFamily } from '../../../shared/mapSpec';

/** Polygons are drawn below lines, and lines below points; the labels of every layer are above all of them. */
const familyRank: Record<GeometryFamily, number> = { polygon: 0, line: 1, point: 2 };

type Ordered = { geometryType: GeometryFamily };
type Identified = { id: string; geometryType: GeometryFamily };

/** The layers from the bottom to the top of the map: by family, and within one family in the order given (the order added). */
export function inDrawOrder<T extends Ordered>(layers: readonly T[]): T[] {
  return [...layers].sort((a, b) => familyRank[a.geometryType] - familyRank[b.geometryType]);
}

/** The layers as a list shows them: the top of the map first (points above lines above polygons, the newest first within a family). */
export function inTopDownOrder<T extends Ordered>(layers: readonly T[]): T[] {
  return inDrawOrder(layers).reverse();
}

/** The map ids a layer gets: its GeoJSON source, and its map layers (a polygon has a fill and an outline). */
export function mapLayerIds(layerId: string) {
  return {
    source: layerId,
    fill: `${layerId}-fill`,
    outline: `${layerId}-outline`,
    line: `${layerId}-line`,
    circle: `${layerId}-circle`,
    label: `${layerId}-label`
  };
}

/** The id of the layer's lowest geometry map layer: what the layer below it in the draw order is placed before. */
export function bottomMapLayerId(layer: Identified): string {
  const ids = mapLayerIds(layer.id);
  const bottom: Record<GeometryFamily, string> = { polygon: ids.fill, line: ids.line, point: ids.circle };
  return bottom[layer.geometryType];
}

/**
 * The map layer the geometry of the layer at `index` of `bottomUp` goes below: the lowest map layer of the nearest layer
 * above it that is already on the map; failing that the lowest label on the map (labels are above all geometry);
 * undefined (the top) when there is none. Map layers are added after the render, so layers added together find none of
 * each other: with the layers listed bottom to top they are added in that order and stack right (geometry of all
 * layers first, then the labels).
 */
export function beforeMapLayerId(
  bottomUp: readonly Identified[],
  index: number,
  existsOnMap: (mapLayerId: string) => boolean
): string | undefined {
  return (
    bottomUp.slice(index + 1).map(bottomMapLayerId).find(existsOnMap) ??
    bottomUp.map(({ id }) => mapLayerIds(id).label).find(existsOnMap)
  );
}

/** The map layer the label of the layer at `index` goes below: the nearest label above it that is on the map, else the top. */
export function beforeLabelLayerId(
  bottomUp: readonly Identified[],
  index: number,
  existsOnMap: (mapLayerId: string) => boolean
): string | undefined {
  return bottomUp.slice(index + 1).map(({ id }) => mapLayerIds(id).label).find(existsOnMap);
}

/**
 * The ids of the labels, in draw order. Layers rendered together cannot see each other's map layers when they pick their
 * `beforeId`, so a label can land under the geometry of a layer added in the same tick; moving these to the top in this
 * order puts every label above all geometry again.
 */
export function labelMapLayerIds(bottomUp: readonly { id: string; label: object | null }[]): string[] {
  return bottomUp.filter(({ label }) => label !== null).map(({ id }) => mapLayerIds(id).label);
}
