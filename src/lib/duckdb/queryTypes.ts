import type { GeometryFamily } from '../../../shared/mapSpec';

export type ColumnInfo = { name: string; type: 'string' | 'number' | 'boolean' | 'other' };

export type JsonValue = string | number | boolean | null;
export type JsonRow = Record<string, JsonValue>;

/** A position: longitude, latitude and optionally a height. */
export type Position = [number, number, ...number[]];

/** The GeoJSON geometries a layer can hold, with the nesting of `coordinates` each type has (`GeometryCollection` is refused before it gets here). */
export type GeoJsonGeometry =
  | { type: 'Point'; coordinates: Position }
  | { type: 'MultiPoint' | 'LineString'; coordinates: Position[] }
  | { type: 'MultiLineString' | 'Polygon'; coordinates: Position[][] }
  | { type: 'MultiPolygon'; coordinates: Position[][][] };
export type GeoJsonFeature = { type: 'Feature'; id: number; geometry: GeoJsonGeometry; properties: JsonRow };
export type GeoJsonFeatureCollection = { type: 'FeatureCollection'; features: GeoJsonFeature[] };

export type Bbox = [number, number, number, number];

export type LayerQueryResult = {
  features: GeoJsonFeatureCollection;
  geometryType: GeometryFamily;
  /** The attribute columns (no geometry). */
  columns: ColumnInfo[];
  featureCount: number;
  /** [minLon, minLat, maxLon, maxLat] */
  bbox: Bbox;
};

export type TableQueryResult = { columns: ColumnInfo[]; rows: JsonRow[]; truncated: boolean };
