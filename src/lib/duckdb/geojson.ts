import type { GeometryFamily } from '../../../shared/mapSpec';
import type { Bbox, GeoJsonFeature, GeoJsonFeatureCollection, GeoJsonGeometry, JsonRow, Position } from './queryTypes';

/** One result row: the attribute values (already converted) and the geometry as the text of `ST_AsGeoJSON`, or NULL. */
export type FeatureRow = { properties: JsonRow; geometry: string | null };

export type FeatureCollectionResult =
  | {
      ok: true;
      features: GeoJsonFeatureCollection;
      /** Undefined when there is no feature. */
      geometryType: GeometryFamily | undefined;
      /** [0, 0, 0, 0] when there is no feature. */
      bbox: Bbox;
    }
  /** `mixed`: not one family; `invalid`: a value that is not GeoJSON. */
  | { ok: false; reason: 'mixed' | 'invalid'; message: string };

export const emptyBbox: Bbox = [0, 0, 0, 0];

const geometryFamilies: Record<GeoJsonGeometry['type'], GeometryFamily> = {
  Point: 'point',
  MultiPoint: 'point',
  LineString: 'line',
  MultiLineString: 'line',
  Polygon: 'polygon',
  MultiPolygon: 'polygon'
};

const familyNames: Record<GeometryFamily, string> = { point: 'points', line: 'lines', polygon: 'polygons' };

/** Coordinates as parsed, before their nesting is checked. */
type Nested = number | Nested[];

/** The parsed text of a geometry, before it is checked. */
type ParsedGeometry = { type?: string; coordinates?: Nested };

const invalidMessage = 'The geom column holds a value that is not a geometry.';

/** The geometry of a GeoJSON text; undefined when the text is not a GeoJSON object. */
function parseGeometry(text: string): ParsedGeometry | undefined {
  try {
    const parsed: ParsedGeometry | null = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isGeometryType(type: string | undefined): type is GeoJsonGeometry['type'] {
  return type !== undefined && Object.hasOwn(geometryFamilies, type);
}

/** The positions found while the coordinates are checked: their count and the box around them. */
type Walk = { positions: number; bbox: Bbox };

/** A position (`[lon, lat, ...]`): it widens the box of the walk. */
function isPosition(coordinates: Nested, walk: Walk): coordinates is Position {
  if (!Array.isArray(coordinates) || coordinates.length < 2) return false;
  if (!coordinates.every((value) => typeof value === 'number')) return false;
  const [lon, lat] = coordinates;
  if (typeof lon !== 'number' || typeof lat !== 'number') return false;
  walk.positions += 1;
  walk.bbox[0] = Math.min(walk.bbox[0], lon);
  walk.bbox[1] = Math.min(walk.bbox[1], lat);
  walk.bbox[2] = Math.max(walk.bbox[2], lon);
  walk.bbox[3] = Math.max(walk.bbox[3], lat);
  return true;
}

/** An array whose every item passes `isItem`; the walk goes through each item once. */
function isArrayOf<T extends Nested>(coordinates: Nested, isItem: (item: Nested, walk: Walk) => item is T, walk: Walk): coordinates is T[] {
  return Array.isArray(coordinates) && coordinates.every((item) => isItem(item, walk));
}

const isPositions = (c: Nested, walk: Walk): c is Position[] => isArrayOf(c, isPosition, walk);
const isRings = (c: Nested, walk: Walk): c is Position[][] => isArrayOf(c, isPositions, walk);
const isPolygons = (c: Nested, walk: Walk): c is Position[][][] => isArrayOf(c, isRings, walk);

/**
 * The geometry of a type and its coordinates, checked to nest as the type says and walked once for the box of `walk`.
 * Undefined when the nesting is wrong.
 */
function toGeometry(type: GeoJsonGeometry['type'], coordinates: Nested, walk: Walk): GeoJsonGeometry | undefined {
  switch (type) {
    case 'Point':
      return isPosition(coordinates, walk) ? { type, coordinates } : undefined;
    case 'MultiPoint':
    case 'LineString':
      return isPositions(coordinates, walk) ? { type, coordinates } : undefined;
    case 'MultiLineString':
    case 'Polygon':
      return isRings(coordinates, walk) ? { type, coordinates } : undefined;
    case 'MultiPolygon':
      return isPolygons(coordinates, walk) ? { type, coordinates } : undefined;
  }
}

/**
 * The features of a result: `id` is the row index, `properties` the attribute columns. A row with no geometry (NULL or
 * empty) is left out. A result that is not one family of point, line or polygon is refused with a message that names
 * what was found. Pure: DuckDB is not involved.
 */
export function buildFeatureCollection(rows: readonly FeatureRow[]): FeatureCollectionResult {
  const features: GeoJsonFeature[] = [];
  const families = new Set<GeometryFamily>();
  const bbox: Bbox = [Infinity, Infinity, -Infinity, -Infinity];
  let otherType: string | undefined;
  let invalid = false;

  rows.forEach((row, index) => {
    if (row.geometry === null) return;
    const parsed = parseGeometry(row.geometry);
    if (parsed === undefined) {
      invalid = true;
      return;
    }
    if (!isGeometryType(parsed.type)) {
      otherType ??= parsed.type ?? 'unknown';
      return;
    }
    // An empty geometry (`POINT EMPTY`, no coordinates) has no feature.
    if (parsed.coordinates === undefined || (Array.isArray(parsed.coordinates) && parsed.coordinates.length === 0)) return;
    const walk: Walk = { positions: 0, bbox };
    const geometry = toGeometry(parsed.type, parsed.coordinates, walk);
    if (geometry === undefined) {
      invalid = true;
      return;
    }
    if (walk.positions === 0) return;
    families.add(geometryFamilies[parsed.type]);
    features.push({ type: 'Feature', id: index, geometry, properties: row.properties });
  });

  if (invalid) return { ok: false, reason: 'invalid', message: invalidMessage };
  if (otherType !== undefined) {
    return { ok: false, reason: 'mixed', message: `The geometry column holds ${otherType} values; a layer holds points, lines or polygons.` };
  }
  if (families.size > 1) {
    const found = [...families].map((family) => familyNames[family]).join(' and ');
    return { ok: false, reason: 'mixed', message: `The query returned ${found}; a layer holds one geometry type.` };
  }
  const [geometryType] = families;
  return {
    ok: true,
    features: { type: 'FeatureCollection', features },
    geometryType,
    bbox: features.length === 0 ? [...emptyBbox] : bbox
  };
}
