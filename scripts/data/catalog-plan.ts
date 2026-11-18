import type { Catalog, CatalogColumn, CatalogDataset } from '../../shared/catalog-schema.js';
import { dataConfig } from '../../shared/config.js';
import type { GeometryFamily } from '../../shared/mapSpec.js';
import type { ColumnText, DatasetText, ValuesKind } from './catalog.config.js';
import { sqlIdent, sqlString } from './convert-plan.js';

/**
 * The pure parts of `npm run data:catalog`: the SQL that measures a dataset file, the mapping of DuckDB types, the
 * merge of the measurements with the texts of `catalog.config.ts`, and the serialisation. No database is touched here.
 * The relation passed to the SQL builders is `parquetRelation(file)`, or a table name in the tests.
 */

export type ColumnType = CatalogColumn['type'];

/** DuckDB type names that are numbers: the integer and floating types. */
const numberTypes: readonly string[] = [
  'TINYINT',
  'SMALLINT',
  'INTEGER',
  'BIGINT',
  'HUGEINT',
  'UTINYINT',
  'USMALLINT',
  'UINTEGER',
  'UBIGINT',
  'UHUGEINT',
  'FLOAT',
  'DOUBLE'
];

/** The catalog type of a DuckDB column type; any other type (a date, a decimal, a list, ...) fails, naming dataset, column and type. */
export function catalogColumnType(datasetId: string, column: string, duckdbType: string): ColumnType {
  if (duckdbType === 'VARCHAR') return 'string';
  if (duckdbType === 'BOOLEAN') return 'boolean';
  if (numberTypes.includes(duckdbType)) return 'number';
  throw new Error(`Dataset "${datasetId}", column "${column}": the type ${duckdbType} has no catalog type (string, number or boolean).`);
}

/** The geometry families of the geometry type names `ST_GeometryType` reports (multi-part types count as their single-part kind). */
const geometryFamilies = new Map<string, GeometryFamily>([
  ['POINT', 'point'],
  ['LINESTRING', 'line'],
  ['MULTILINESTRING', 'line'],
  ['POLYGON', 'polygon'],
  ['MULTIPOLYGON', 'polygon']
]);

/** The one geometry family of the geometry types found in a file; an unknown type, no type, or two families fail. */
export function geometryFamilyOf(datasetId: string, typeNames: string[]): GeometryFamily {
  const families = new Set<GeometryFamily>();
  for (const name of typeNames) {
    const family = geometryFamilies.get(name);
    if (family === undefined) throw new Error(`Dataset "${datasetId}": the geometry type ${name} is not point, line or polygon.`);
    families.add(family);
  }
  const [first, ...others] = [...families];
  if (first === undefined) throw new Error(`Dataset "${datasetId}": the file has no geometry.`);
  if (others.length > 0) throw new Error(`Dataset "${datasetId}": the file mixes geometry families (${[first, ...others].join(', ')}).`);
  return first;
}

/** Float noise beyond this many places is ignored before rounding: 127.65228 scaled by 1e5 is 12765227.999999998, and must stay 127.65228. */
const noiseDecimals = 6;

/** Rounds to `decimals` places, towards negative infinity (`down`) or positive infinity (`up`). */
export function roundOutward(value: number, decimals: number, direction: 'down' | 'up'): number {
  const factor = 10 ** decimals;
  const scaled = Number((value * factor).toFixed(noiseDecimals));
  const whole = direction === 'down' ? Math.floor(scaled) : Math.ceil(scaled);
  return whole / factor;
}

export type Extent = { minLon: number; minLat: number; maxLon: number; maxLat: number };

/** The bounding box of a measured extent: minimum down, maximum up, at the configured number of decimals. */
export function bboxOf(extent: Extent): [number, number, number, number] {
  const decimals = dataConfig.catalog.bboxDecimals;
  return [
    roundOutward(extent.minLon, decimals, 'down'),
    roundOutward(extent.minLat, decimals, 'down'),
    roundOutward(extent.maxLon, decimals, 'up'),
    roundOutward(extent.maxLat, decimals, 'up')
  ];
}

export function parquetRelation(file: string): string {
  return `read_parquet(${sqlString(file)})`;
}

/** The columns of a relation with their DuckDB types (`column_name`, `column_type`), in the order of the file. */
export function buildDescribeSql(relation: string): string {
  return `DESCRIBE SELECT * FROM ${relation}`;
}

/** The distinct geometry type names of a relation (needs the spatial extension). */
export function buildGeometryTypesSql(relation: string, geometryColumn: string): string {
  return `SELECT DISTINCT CAST(ST_GeometryType(${sqlIdent(geometryColumn)}) AS VARCHAR) AS geometry_type FROM ${relation} ORDER BY 1`;
}

/** The row count and the extent of the geometry column (needs the spatial extension). */
export function buildExtentSql(relation: string, geometryColumn: string): string {
  const geom = sqlIdent(geometryColumn);
  return `SELECT count(*) AS feature_count, min(ST_XMin(${geom})) AS min_lon, min(ST_YMin(${geom})) AS min_lat, max(ST_XMax(${geom})) AS max_lon, max(ST_YMax(${geom})) AS max_lat FROM ${relation}`;
}

/** Minimum and maximum of the non-NULL values of a numeric column (both NULL when every value is NULL). */
export function buildStatsSql(relation: string, column: string): string {
  const name = sqlIdent(column);
  return `SELECT min(${name})::DOUBLE AS min, max(${name})::DOUBLE AS max FROM ${relation}`;
}

/** The most frequent non-NULL values of a column: by count descending, then by value ascending, at most `limit`. */
export function buildTopValuesSql(relation: string, column: string, limit: number): string {
  const name = sqlIdent(column);
  return `SELECT ${name}::VARCHAR AS value, count(*) AS count FROM ${relation} WHERE ${name} IS NOT NULL GROUP BY ${name} ORDER BY count(*) DESC, ${name} ASC LIMIT ${limit}`;
}

/** The number of distinct non-NULL values of a column. */
export function buildDistinctCountSql(relation: string, column: string): string {
  const name = sqlIdent(column);
  return `SELECT count(DISTINCT ${name}) AS distinct_count FROM ${relation}`;
}

/**
 * How many values a column lists: `all` lists every distinct value and fails, naming dataset and column, when there
 * are more than `allValuesLimit`; `top` lists the `topValuesLimit` most frequent ones.
 */
export function listedValuesLimit(datasetId: string, column: string, kind: ValuesKind, distinctCount: number): number {
  const { topValuesLimit, allValuesLimit } = dataConfig.catalog;
  if (kind === 'top') return topValuesLimit;
  if (distinctCount > allValuesLimit) {
    throw new Error(`Dataset "${datasetId}", column "${column}": ${distinctCount} distinct values, more than the ${allValuesLimit} an all-values column may have. List its top values instead (catalog.config.ts).`);
  }
  return allValuesLimit;
}

/** What was measured on one column of a file. */
export type MeasuredColumn = {
  name: string;
  type: ColumnType;
  stats?: { min: number; max: number };
  topValues?: { value: string; count: number }[];
  distinctCount?: number;
};

/** What was measured on one file. */
export type MeasuredDataset = {
  file: string;
  geometryType: GeometryFamily;
  featureCount: number;
  bbox: [number, number, number, number];
  columns: MeasuredColumn[];
};

/**
 * Compares the columns of a file with the column texts, in both directions, and throws a message that names the
 * dataset and the columns: a column without a text, a text without a column, a text twice, and a top-values flag on a
 * column that is not a string.
 */
export function checkColumnTexts(datasetId: string, columns: { name: string; type: ColumnType }[], texts: ColumnText[]): void {
  const problems: string[] = [];
  const names = columns.map((column) => column.name);
  const textNames = texts.map((text) => text.name);
  const withoutText = names.filter((name) => !textNames.includes(name));
  if (withoutText.length > 0) problems.push(`the file has columns without a text: ${withoutText.join(', ')}`);
  const withoutColumn = textNames.filter((name) => !names.includes(name));
  if (withoutColumn.length > 0) problems.push(`the texts describe columns the file does not have: ${withoutColumn.join(', ')}`);
  const twice = textNames.filter((name, index) => textNames.indexOf(name) !== index);
  if (twice.length > 0) problems.push(`the texts describe a column twice: ${twice.join(', ')}`);
  for (const text of texts) {
    const column = columns.find((candidate) => candidate.name === text.name);
    if (text.values !== undefined && column !== undefined && column.type !== 'string') {
      problems.push(`values are asked for column ${text.name}, which is a ${column.type} column (only string columns have them)`);
    }
  }
  if (problems.length > 0) throw new Error(`Dataset "${datasetId}": ${problems.join('; ')}.`);
}

/** The catalog entry of a dataset: the measurements merged with the texts. The keys come in the order of the schema. */
export function assembleDataset(text: DatasetText, measured: MeasuredDataset): CatalogDataset {
  checkColumnTexts(text.id, measured.columns, text.columns);
  const columns = measured.columns.map((column): CatalogColumn => {
    const columnText = text.columns.find((candidate) => candidate.name === column.name);
    if (columnText === undefined) throw new Error(`Dataset "${text.id}": no text for column ${column.name}.`);
    return {
      name: column.name,
      type: column.type,
      description: columnText.description,
      ...(columnText.unit === undefined ? {} : { unit: columnText.unit }),
      ...(column.stats === undefined ? {} : { stats: column.stats }),
      ...(column.topValues === undefined ? {} : { topValues: column.topValues }),
      ...(column.distinctCount === undefined ? {} : { distinctCount: column.distinctCount })
    };
  });
  return {
    id: text.id,
    title: text.title,
    description: text.description,
    file: measured.file,
    geometryType: measured.geometryType,
    featureCount: measured.featureCount,
    bbox: measured.bbox,
    source: text.source,
    columns,
    ...(text.notes === undefined ? {} : { notes: text.notes })
  };
}

/** The bytes of `shared/catalog.json`: 2-space indent, final newline, keys in the order of the object (the schema's order after `catalogSchema.parse`). */
export function serializeCatalog(catalog: Catalog): string {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

/** The message when a dataset file the catalog is measured on is missing. */
export function missingDatasetFileMessage(path: string, convertCommand: string): string {
  return `The dataset file ${path} is missing. Run the conversion first with: ${convertCommand}`;
}
