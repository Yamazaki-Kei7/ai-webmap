import type { GeoJsonFeatureCollection, GeoJsonGeometry, JsonRow, Position } from '../duckdb/queryTypes';

/**
 * The labels of a polygon layer: one point per feature, so that a feature made of many parts (islands, enclaves) is named
 * once. The point lies inside the largest part of the feature (by area): the centroid of that part's outer ring when it
 * is inside the part, else the middle of the widest stretch of the part on the horizontal line through the centroid.
 * Coordinates are degrees and are treated as plane coordinates: the label only has to be inside the shape.
 */

/** One part of a polygon: the outer ring first, then its holes. */
type Part = readonly (readonly Position[])[];

/** The point features the derived label source holds (each keeps the properties and the id of its polygon feature). */
export type LabelPointFeature = { type: 'Feature'; id: number; geometry: { type: 'Point'; coordinates: Position }; properties: JsonRow };
export type LabelPointCollection = { type: 'FeatureCollection'; features: LabelPointFeature[] };

/** The signed area of a ring (shoelace; the sign follows the winding). */
function signedArea(ring: readonly Position[]): number {
  let twice = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    twice += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return twice / 2;
}

/** The area of a part: its outer ring minus its holes. */
function partArea([outer, ...holes]: Part): number {
  return Math.abs(signedArea(outer)) - holes.reduce((sum, hole) => sum + Math.abs(signedArea(hole)), 0);
}

/** The centroid of a ring. A ring with no area (all points on a line) has no centroid by the formula: the mean of its points stands in. */
function ringCentroid(ring: readonly Position[]): Position {
  const area = signedArea(ring);
  if (area !== 0) {
    let sumX = 0;
    let sumY = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      sumX += (ring[j][0] + ring[i][0]) * cross;
      sumY += (ring[j][1] + ring[i][1]) * cross;
    }
    return [sumX / (6 * area), sumY / (6 * area)];
  }
  const count = Math.max(ring.length, 1);
  return [ring.reduce((sum, [x]) => sum + x, 0) / count, ring.reduce((sum, [, y]) => sum + y, 0) / count];
}

/** The x of every edge of the part that crosses the horizontal line at `y` (an edge counts when one end is above the line and the other is not), sorted. */
function crossings(part: Part, y: number): number[] {
  const xs: number[] = [];
  for (const ring of part) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y) xs.push(xi + ((y - yi) * (xj - xi)) / (yj - yi));
    }
  }
  return xs.sort((a, b) => a - b);
}

/** Whether the point is inside the part: inside the outer ring and not in a hole (ray casting, even-odd over all rings). */
function insidePart(part: Part, [x, y]: Position): boolean {
  return crossings(part, y).filter((crossing) => crossing > x).length % 2 === 1;
}

/** The point of a part: its centroid if that is inside, else the middle of the widest inside stretch of the line through the centroid. */
function partLabelPoint(part: Part): Position {
  const [outer] = part;
  const centroid = ringCentroid(outer);
  if (insidePart(part, centroid)) return centroid;

  const xs = crossings(part, centroid[1]);
  let widest: [number, number] | undefined;
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (widest === undefined || xs[i + 1] - xs[i] > widest[1] - widest[0]) widest = [xs[i], xs[i + 1]];
  }
  // No stretch at all (a ring with no area, a centroid outside the shape's height): a vertex of the ring is the last resort.
  return widest === undefined ? outer[0] : [(widest[0] + widest[1]) / 2, centroid[1]];
}

function partsOf(geometry: GeoJsonGeometry): Part[] {
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

/** The label point of a polygon or a multi-polygon, or undefined for anything else (and for a polygon with no ring). */
export function polygonLabelPoint(geometry: GeoJsonGeometry): Position | undefined {
  const parts = partsOf(geometry).filter(([outer]) => outer !== undefined && outer.length > 0);
  const [first, ...rest] = parts;
  if (first === undefined) return undefined;
  const largest = rest.reduce(
    (best, part) => {
      const area = partArea(part);
      return area > best.area ? { part, area } : best;
    },
    { part: first, area: partArea(first) }
  );
  return partLabelPoint(largest.part);
}

// A layer's data is one object until the layer is replaced, so the points are built once per data and read from here after.
const built = new WeakMap<GeoJsonFeatureCollection, LabelPointCollection>();

/** The derived label source of a polygon layer: one point per polygon feature (a feature with no polygon has none). Built once per data object. */
export function derivedLabelPoints(data: GeoJsonFeatureCollection): LabelPointCollection {
  const cached = built.get(data);
  if (cached !== undefined) return cached;
  const features: LabelPointFeature[] = [];
  for (const { id, geometry, properties } of data.features) {
    const coordinates = polygonLabelPoint(geometry);
    if (coordinates !== undefined) features.push({ type: 'Feature', id, geometry: { type: 'Point', coordinates }, properties });
  }
  const labels: LabelPointCollection = { type: 'FeatureCollection', features };
  built.set(data, labels);
  return labels;
}
