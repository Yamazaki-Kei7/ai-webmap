import type { GeometryFamily } from '../../../shared/mapSpec';
import type { Bbox, Coordinates, GeoJsonFeature, GeoJsonFeatureCollection, GeoJsonGeometry, JsonRow } from './queryTypes';

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

/** The parsed text of a geometry, before it is checked. */
type ParsedGeometry = { type?: string; coordinates?: Coordinates };

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

/** Widens `bbox` by every position (`[lon, lat, ...]`) in `coordinates`; false when there is none. */
function extendBbox(coordinates: Coordinates, bbox: Bbox): boolean {
  if (typeof coordinates === 'number') return false;
  if (typeof coordinates[0] === 'number' && typeof coordinates[1] === 'number') {
    const lon = coordinates[0];
    const lat = coordinates[1];
    bbox[0] = Math.min(bbox[0], lon);
    bbox[1] = Math.min(bbox[1], lat);
    bbox[2] = Math.max(bbox[2], lon);
    bbox[3] = Math.max(bbox[3], lat);
    return true;
  }
  let found = false;
  for (const inner of coordinates) {
    if (extendBbox(inner, bbox)) found = true;
  }
  return found;
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
    if (parsed.coordinates === undefined || !extendBbox(parsed.coordinates, bbox)) return;
    families.add(geometryFamilies[parsed.type]);
    features.push({
      type: 'Feature',
      id: index,
      geometry: { type: parsed.type, coordinates: parsed.coordinates },
      properties: row.properties
    });
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
