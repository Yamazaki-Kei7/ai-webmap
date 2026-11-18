import { sqlIdent, sqlString } from './convert-plan.js';
import {
  landPriceRules,
  placeConfig,
  stationRules,
  type ConversionConfig,
  type PointDataset
} from './datasets.config.js';
import {
  changeRateSql,
  chosenCodeSql,
  codeMethodSql,
  locatedColumns,
  orderTerms,
  outputColumnSql,
  passengersSql,
  stationKeptSql
} from './rules-sql.js';

/**
 * The SQL of the three point files (`land_prices`, `stations`, `schools`): the raw rows as a work table, the spatial
 * search for the municipality of a point, the choice of the code, and the output rows. The search is the only part
 * that needs the spatial extension; the choice and the output run on plain columns.
 */

/** Tables shared by the point datasets. */
export const placeTables = {
  /** The code, city name and prefecture name of every row of the written `municipalities` file. */
  municipalityAttributes: 'municipality_attributes',
  /** The polygons of the un-simplified intermediate with their bounding boxes. */
  municipalityBounds: 'municipality_bounds'
} as const;

/** Columns of the work tables that are not source attributes. */
export const workColumns = {
  rowId: 'row_id',
  lon: 'lon',
  lat: 'lat',
  containingCodes: 'containing_codes',
  codeMethod: 'muni_code_method'
} as const;

/** The work tables of one dataset. */
export function datasetTables(id: string): { prepared: string; containing: string; nearest: string; located: string; resolved: string } {
  return {
    prepared: `${id}_prepared`,
    containing: `${id}_containing`,
    nearest: `${id}_nearest`,
    located: `${id}_located`,
    resolved: `${id}_resolved`
  };
}

/** The rules that belong to one point dataset. */
export type DatasetRules = {
  /** Source attributes the rules read besides the output columns. */
  sources: string[];
  /** Output column name -> SQL expression over the SQL of its source attribute; `alias` is the table the rows come from. */
  overrides: (alias: string) => Record<string, (source: string) => string>;
  /** SQL condition over the table `alias`; the rows where it is not true are dropped. */
  keep: ((alias: string) => string) | undefined;
  /** The geometry of a point as a SQL expression over the raw geometry. */
  pointExpression: (geometry: string) => string;
};

/** The rules of a point dataset (a dataset without any gets the empty rules). */
export function datasetRules(id: string): DatasetRules {
  const none: DatasetRules = { sources: [], overrides: () => ({}), keep: undefined, pointExpression: (geometry) => geometry };
  if (id === landPriceRules.datasetId) {
    return {
      ...none,
      sources: [landPriceRules.statusSource],
      overrides: (alias) => ({
        [landPriceRules.rateColumn]: (rate) => changeRateSql(rate, `${alias}.${sqlIdent(landPriceRules.statusSource)}`, landPriceRules)
      })
    };
  }
  if (id === stationRules.datasetId) {
    return {
      ...none,
      sources: [stationRules.duplicateSource, stationRules.existenceSource],
      overrides: (alias) => ({
        [stationRules.passengersColumn]: (value) =>
          passengersSql(value, `${alias}.${sqlIdent(stationRules.duplicateSource)}`, `${alias}.${sqlIdent(stationRules.existenceSource)}`, stationRules)
      }),
      keep: (alias) => stationKeptSql(`${alias}.${sqlIdent(stationRules.existenceSource)}`, stationRules),
      // A station is a line in the source; its point is the centroid of that line.
      pointExpression: (geometry) => `ST_Centroid(${geometry})`
    };
  }
  return none;
}

/** The source attributes a point dataset needs, each once: its columns, its code, the attributes of its rules and its order keys. */
export function sourceAttributes(dataset: PointDataset, rules: DatasetRules): string[] {
  const code = dataset.codeSource === undefined ? [] : [dataset.codeSource];
  return [...new Set([...dataset.columns.map((column) => column.source), ...code, ...rules.sources, ...dataset.orderBy])];
}

/**
 * The raw rows of a point dataset as a work table: the source attributes, `source_code` (the code attribute, NULL for a
 * dataset without one), the point `geom`, its longitude and latitude (ordering and search), and a row id.
 * `row_id` only joins this table to the spatial results of the same run; the output order never depends on it.
 */
export function buildPreparedSql(input: string, dataset: PointDataset, config: ConversionConfig): string {
  const rules = datasetRules(dataset.id);
  const geom = sqlIdent(config.geometryColumn);
  const attributes = sourceAttributes(dataset, rules).map(sqlIdent).join(', ');
  const sourceCode = dataset.codeSource === undefined ? 'CAST(NULL AS VARCHAR)' : sqlIdent(dataset.codeSource);
  const { rowId, lon, lat } = workColumns;
  return `CREATE OR REPLACE TABLE ${sqlIdent(datasetTables(dataset.id).prepared)} AS
    SELECT row_number() OVER () AS ${rowId}, ${attributes}, ${sourceCode} AS ${locatedColumns.sourceCode}, ${geom}, ST_X(${geom}) AS ${lon}, ST_Y(${geom}) AS ${lat}
    FROM (SELECT ${attributes}, ${rules.pointExpression(geom)} AS ${geom} FROM ST_Read(${sqlString(input)}))`;
}

/** The code, city name and prefecture name of the rows of the written `municipalities` file. */
export function buildMunicipalityAttributesSql(municipalitiesFile: string): string {
  const { codeColumn, cityNameColumn, prefNameColumn } = placeConfig;
  const columns = [codeColumn, cityNameColumn, prefNameColumn].map(sqlIdent).join(', ');
  return `CREATE OR REPLACE TABLE ${placeTables.municipalityAttributes} AS SELECT ${columns} FROM read_parquet(${sqlString(municipalitiesFile)})`;
}

/** The polygons of the un-simplified intermediate with their bounding boxes (the box test narrows the nearest search). */
export function buildMunicipalityBoundsSql(rawIntermediate: string, config: ConversionConfig): string {
  const geom = sqlIdent(config.geometryColumn);
  return `CREATE OR REPLACE TABLE ${placeTables.municipalityBounds} AS
    SELECT ${sqlIdent(placeConfig.codeColumn)}, ${geom}, ST_XMin(${geom}) AS xmin, ST_YMin(${geom}) AS ymin, ST_XMax(${geom}) AS xmax, ST_YMax(${geom}) AS ymax
    FROM read_parquet(${sqlString(rawIntermediate)})`;
}

/** The half-width, in degrees, of the box test of the nearest search: the limit with its safety factor. */
export function nearestMarginDegrees(config: ConversionConfig): number {
  return (placeConfig.nearest.limitMeters / config.metersPerDegree) * placeConfig.nearest.candidateMarginFactor;
}

/**
 * Per point: the polygon that contains it. A point on the border of two polygons matches both; the lower code is taken
 * and `containing_codes` says how many codes matched. DuckDB spatial runs this `ST_Intersects` join as a spatial join.
 */
export function buildContainingSql(dataset: PointDataset, config: ConversionConfig): string {
  const tables = datasetTables(dataset.id);
  const geom = sqlIdent(config.geometryColumn);
  const code = sqlIdent(placeConfig.codeColumn);
  return `CREATE OR REPLACE TABLE ${sqlIdent(tables.containing)} AS
    SELECT p.${workColumns.rowId}, min(m.${code}) AS ${locatedColumns.containingCode}, count(DISTINCT m.${code}) AS ${workColumns.containingCodes}
    FROM ${sqlIdent(tables.prepared)} p JOIN ${placeTables.municipalityBounds} m ON ST_Intersects(m.${geom}, p.${geom})
    GROUP BY p.${workColumns.rowId}`;
}

/**
 * Per point that no polygon contains: the nearest polygon and the distance to it in metres.
 *  1. Candidates: polygons whose bounding box is within `nearestMarginDegrees` of the point (the east-west axis is scaled
 *     by the cosine of the point's latitude, so that a degree of both axes is about the same length).
 *  2. In that scaled space, `ST_ShortestLine` gives the closest pair of points between the point and a candidate.
 *  3. The closest point on the polygon is scaled back, and the distance is measured on the WGS84 ellipsoid
 *     (`ST_Distance_Spheroid`, which takes latitude first, hence the flips). The candidate with the least distance wins;
 *     the lower code breaks a tie. A candidate farther than the limit is kept here: the choice of the code applies the limit.
 */
export function buildNearestSql(dataset: PointDataset, config: ConversionConfig): string {
  const tables = datasetTables(dataset.id);
  const geom = sqlIdent(config.geometryColumn);
  const code = sqlIdent(placeConfig.codeColumn);
  const { rowId, lon, lat } = workColumns;
  const margin = nearestMarginDegrees(config);
  const scaled = (expression: string): string => `ST_Affine(${expression}, k, 0, 0, 1, 0, 0)`;
  const unscaled = (expression: string): string => `ST_Affine(${expression}, 1 / k, 0, 0, 1, 0, 0)`;
  const closestOnPolygon = unscaled(`ST_StartPoint(ST_ShortestLine(${scaled('polygon')}, ${scaled('point')}))`);
  return `CREATE OR REPLACE TABLE ${sqlIdent(tables.nearest)} AS
    WITH unlocated AS (
      SELECT ${rowId}, ${geom}, ${lon}, ${lat}, cos(radians(${lat})) AS k
      FROM ${sqlIdent(tables.prepared)} WHERE ${rowId} NOT IN (SELECT ${rowId} FROM ${sqlIdent(tables.containing)})
    ), candidates AS (
      SELECT u.${rowId}, u.${geom} AS point, u.k, m.${code} AS candidate_code, m.${geom} AS polygon
      FROM unlocated u JOIN ${placeTables.municipalityBounds} m
        ON m.xmax * u.k >= u.${lon} * u.k - ${margin} AND m.xmin * u.k <= u.${lon} * u.k + ${margin}
        AND m.ymax >= u.${lat} - ${margin} AND m.ymin <= u.${lat} + ${margin}
    ), measured AS (
      SELECT ${rowId}, candidate_code, ST_Distance_Spheroid(
        ST_FlipCoordinates(point),
        ST_FlipCoordinates(${closestOnPolygon})
      ) AS meters
      FROM candidates
    )
    SELECT ${rowId}, candidate_code AS ${locatedColumns.nearestCode}, meters AS ${locatedColumns.nearestMeters}
    FROM (SELECT *, row_number() OVER (PARTITION BY ${rowId} ORDER BY meters, candidate_code) AS rank FROM measured)
    WHERE rank = 1`;
}

/** The spatial results of every row of a dataset as plain columns (row id, containing code, nearest code and distance). */
export function buildLocatedSql(dataset: PointDataset): string {
  const tables = datasetTables(dataset.id);
  const { rowId, containingCodes } = workColumns;
  const { containingCode, nearestCode, nearestMeters } = locatedColumns;
  return `CREATE OR REPLACE TABLE ${sqlIdent(tables.located)} AS
    SELECT p.${rowId}, c.${containingCode}, c.${containingCodes}, n.${nearestCode}, n.${nearestMeters}
    FROM ${sqlIdent(tables.prepared)} p
    LEFT JOIN ${sqlIdent(tables.containing)} c USING (${rowId})
    LEFT JOIN ${sqlIdent(tables.nearest)} n USING (${rowId})`;
}

const knownCodesQuery = `SELECT ${sqlIdent(placeConfig.codeColumn)} FROM ${placeTables.municipalityAttributes}`;

/**
 * The rows of a dataset after its rules: the dropped rows are gone (stations that do not exist), and every row carries
 * the chosen `muni_code` and the way it was found (`muni_code_method`). Reads `<id>_prepared` and `<id>_located` and the
 * `municipality_attributes` table.
 */
export function buildResolvedSql(dataset: PointDataset): string {
  const tables = datasetTables(dataset.id);
  const keep = datasetRules(dataset.id).keep;
  const limit = placeConfig.nearest.limitMeters;
  const where = keep === undefined ? '' : `WHERE ${keep('p')}`;
  return `CREATE OR REPLACE TABLE ${sqlIdent(tables.resolved)} AS
    SELECT p.*, l.${workColumns.containingCodes}, l.${locatedColumns.containingCode}, l.${locatedColumns.nearestCode}, l.${locatedColumns.nearestMeters},
      ${chosenCodeSql(knownCodesQuery, limit)} AS ${sqlIdent(placeConfig.codeColumn)},
      ${codeMethodSql(knownCodesQuery, limit)} AS ${workColumns.codeMethod}
    FROM ${sqlIdent(tables.prepared)} p LEFT JOIN ${sqlIdent(tables.located)} l USING (${workColumns.rowId}) ${where}`;
}

/**
 * The output rows of a point dataset: the dataset's columns (labels and rules applied), `muni_code`, `city_name` and
 * `pref_name` (from `municipalities` by code), the point. Ordered by code (NULLs last), the configured keys, then the coordinates.
 */
export function buildPointOutputQuery(dataset: PointDataset, config: ConversionConfig): string {
  const { codeColumn, cityNameColumn, prefNameColumn } = placeConfig;
  const overrides = datasetRules(dataset.id).overrides('r');
  const columns = dataset.columns.map((column) => outputColumnSql(dataset, column, 'r', overrides));
  const place = [`r.${sqlIdent(codeColumn)}`, `a.${sqlIdent(cityNameColumn)}`, `a.${sqlIdent(prefNameColumn)}`];
  const order = [`r.${sqlIdent(codeColumn)} ASC NULLS LAST`, ...orderTerms('r', dataset.orderBy), `r.${workColumns.lon}`, `r.${workColumns.lat}`];
  return `SELECT ${[...columns, ...place, `r.${sqlIdent(config.geometryColumn)}`].join(', ')}
    FROM ${sqlIdent(datasetTables(dataset.id).resolved)} r
    LEFT JOIN ${placeTables.municipalityAttributes} a ON a.${sqlIdent(codeColumn)} = r.${sqlIdent(codeColumn)}
    ORDER BY ${order.join(', ')}`;
}

/** The output columns of a point dataset, in order (the geometry column follows). */
export function pointColumnNames(dataset: PointDataset): string[] {
  return [...dataset.columns.map((column) => column.name), placeConfig.codeColumn, placeConfig.cityNameColumn, placeConfig.prefNameColumn];
}

/** How the points of a dataset got their code, and how many source codes disagree with the containing polygon. One row. */
export function buildResolutionStatsSql(dataset: PointDataset): string {
  const { methods } = placeConfig;
  const { sourceCode, containingCode } = locatedColumns;
  const method = workColumns.codeMethod;
  return `SELECT count(*) AS rows,
    count(*) FILTER (WHERE ${method} = ${sqlString(methods.source)}) AS by_source,
    count(*) FILTER (WHERE ${method} = ${sqlString(methods.containing)}) AS by_containing,
    count(*) FILTER (WHERE ${method} = ${sqlString(methods.nearest)}) AS by_nearest,
    count(*) FILTER (WHERE ${method} IS NULL) AS unresolved,
    count(*) FILTER (WHERE ${sourceCode} IS NOT NULL AND ${sourceCode} NOT IN (${knownCodesQuery})) AS source_unknown,
    count(*) FILTER (WHERE ${sourceCode} IN (${knownCodesQuery}) AND ${containingCode} IS NOT NULL AND ${sourceCode} <> ${containingCode}) AS source_differs,
    count(*) FILTER (WHERE ${sourceCode} IN (${knownCodesQuery}) AND ${containingCode} IS NULL) AS source_outside,
    count(*) FILTER (WHERE ${workColumns.containingCodes} > 1) AS on_border
  FROM ${sqlIdent(datasetTables(dataset.id).resolved)}`;
}

/** The points whose code came from the nearest polygon (`method` is a `placeConfig.methods` label) or stayed NULL (`undefined`), with the distance. */
export function buildPointListSql(dataset: PointDataset, method: string | undefined): string {
  const labelSource = dataset.columns.find((column) => column.name === dataset.labelColumn)?.source;
  if (labelSource === undefined) throw new Error(`${dataset.id}: labelColumn "${dataset.labelColumn}" is not one of its columns.`);
  const condition = method === undefined ? `${workColumns.codeMethod} IS NULL` : `${workColumns.codeMethod} = ${sqlString(method)}`;
  const { nearestCode, nearestMeters } = locatedColumns;
  return `SELECT ${sqlIdent(labelSource)} AS name, ${workColumns.lon} AS lon, ${workColumns.lat} AS lat, ${sqlIdent(placeConfig.codeColumn)} AS code,
    ${nearestCode} AS nearest_code, ${nearestMeters} AS nearest_meters
    FROM ${sqlIdent(datasetTables(dataset.id).resolved)} WHERE ${condition} ORDER BY name, lon, lat`;
}

/**
 * The distinct codes of a relation that no row of `municipalities` has (NULL is ignored). Two relations: table names or
 * `read_parquet(…)`. `NOT EXISTS`, not `NOT IN`: a NULL code in the reference must not hide a foreign code.
 */
export function buildCodesOutsideSql(relation: string, municipalitiesRelation: string): string {
  const code = sqlIdent(placeConfig.codeColumn);
  return `SELECT DISTINCT o.${code} AS code FROM ${relation} o
    WHERE o.${code} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${municipalitiesRelation} m WHERE m.${code} = o.${code}) ORDER BY 1`;
}

/** The message of codes that are not in `municipalities`; undefined when there are none. */
export function codesOutsideError(label: string, codes: string[]): string | undefined {
  if (codes.length === 0) return undefined;
  return `${label}: muni_code(s) not in municipalities: ${codes.join(', ')}.`;
}

/** The number of rows of an output file with a NULL code (point files). */
export function buildNullCodeCountSql(file: string): string {
  return `SELECT count(*) FILTER (WHERE ${sqlIdent(placeConfig.codeColumn)} IS NULL) AS null_codes FROM read_parquet(${sqlString(file)})`;
}
