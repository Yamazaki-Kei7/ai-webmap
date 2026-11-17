import type { GeometryFamily } from '../../../shared/mapSpec';

export type ColumnInfo = { name: string; type: 'string' | 'number' | 'boolean' | 'other' };

export type JsonValue = string | number | boolean | null;
export type JsonRow = Record<string, JsonValue>;

/** The GeoJSON geometries a layer can hold (`GeometryCollection` is refused before it gets here). */
export type Coordinates = number | Coordinates[];
export type GeoJsonGeometry = {
  type: 'Point' | 'MultiPoint' | 'LineString' | 'MultiLineString' | 'Polygon' | 'MultiPolygon';
  coordinates: Coordinates;
};
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
