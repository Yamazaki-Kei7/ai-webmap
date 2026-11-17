import { mapConfig } from '../../../shared/config';
import type { GeometryFamily } from '../../../shared/mapSpec';

/**
 * Polygons are drawn below lines, and lines below points; the labels of every layer are above all of them: the geometry
 * goes below the hidden anchor layer (`mapConfig.labelAnchorLayerId`), the labels above it.
 */
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
 * above it that is already on the map; failing that the anchor, which is below every label whenever the layers were added.
 * Map layers are added after the render, so layers added together find none of each other: with the layers listed bottom
 * to top they are added in that order and each goes below the anchor, which stacks them right.
 */
export function beforeMapLayerId(bottomUp: readonly Identified[], index: number, existsOnMap: (mapLayerId: string) => boolean): string {
  return bottomUp.slice(index + 1).map(bottomMapLayerId).find(existsOnMap) ?? mapConfig.labelAnchorLayerId;
}

/**
 * The map layer the label of the layer at `index` goes below: the nearest label above it that is on the map, else the top
 * (above the anchor, so above all geometry). Labels added together are added in draw order, so they stack right.
 */
export function beforeLabelLayerId(
  bottomUp: readonly Identified[],
  index: number,
  existsOnMap: (mapLayerId: string) => boolean
): string | undefined {
  return bottomUp.slice(index + 1).map(({ id }) => mapLayerIds(id).label).find(existsOnMap);
}
