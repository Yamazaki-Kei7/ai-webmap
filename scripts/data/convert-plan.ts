import { adminAreaConfig, type ConversionConfig, type DatasetConfig } from './datasets.config.js';

/**
 * The pure parts of `npm run data:convert`: the arguments of mapshaper, the SQL text, and the checks on
 * what the steps measured. Nothing here reads a file, starts a process or opens a database.
 */

type AdminAreaConfig = typeof adminAreaConfig;

/** Names of the in-memory tables the steps pass to each other. */
export const tables = {
  areas: 'areas',
  parts: 'parts',
  partVertices: 'part_vertices',
  partContacts: 'part_contacts',
  partFlags: 'part_flags',
  municipalitiesSimplified: 'municipalities_simplified',
  municipalitiesRepaired: 'municipalities_repaired',
  prefecturesSimplified: 'prefectures_simplified',
  prefecturesRepaired: 'prefectures_repaired'
} as const;

/** A SQL string literal. */
export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** A quoted SQL identifier. */
export function sqlIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** True for the rows that belong to no municipality (SQL, over the source attributes). */
export function unassignedSql(area: AdminAreaConfig): string {
  return `ends_with(${sqlIdent(area.codeSource)}, ${sqlString(area.unassigned.codeSuffix)})`;
}

/** The same condition as `unassignedSql`, but on the label alone: the check that the two select the same rows. */
export function unassignedByNameSql(area: AdminAreaConfig): string {
  return `${sqlIdent(area.citySource)} = ${sqlString(area.unassigned.name)}`;
}

/** True where the two conditions disagree; NULL-safe (a NULL on one side counts as a disagreement). */
export function unassignedDisagreementSql(area: AdminAreaConfig): string {
  return `(${unassignedSql(area)}) IS DISTINCT FROM (${unassignedByNameSql(area)})`;
}

/** The same condition as `unassignedSql`, as a mapshaper (JavaScript) expression for `-filter` that keeps the other rows. */
export function assignedMapshaperExpression(area: AdminAreaConfig): string {
  return `!${area.codeSource}.endsWith(${JSON.stringify(area.unassigned.codeSuffix)})`;
}

/** City name followed by the ward name when there is one (札幌市中央区); otherwise the city name. */
export function muniNameSql(area: AdminAreaConfig): string {
  return `${sqlIdent(area.citySource)} || coalesce(${sqlIdent(area.wardSource)}, '')`;
}

/** The first digits of a municipality code (the SQL expression that gives the code). */
export function prefCodeSql(codeExpression: string, area: AdminAreaConfig): string {
  return `left(${codeExpression}, ${area.prefCodeLength})`;
}

/** The output column names of `municipalities`, in order (the geometry column follows). */
export function municipalityColumns(municipalities: DatasetConfig, area: AdminAreaConfig): string[] {
  return [...municipalities.columns.map((column) => column.name), area.muniNameColumn];
}

/** The arguments of mapshaper's large-heap launcher (the heap size first, then mapshaper's own arguments). */
export function buildMapshaperArgs(input: string, output: string, config: ConversionConfig, area: AdminAreaConfig): string[] {
  return [
    `${config.mapshaper.heapGb}gb`,
    '-i',
    input,
    // The raw borders of neighbours differ in the last bits; mapshaper shares an edge only when coordinates are equal.
    ...(config.mapshaper.snap ? ['snap'] : []),
    '-filter',
    assignedMapshaperExpression(area),
    '-filter-fields',
    area.codeSource,
    '-simplify',
    config.simplify.method,
    `interval=${config.simplify.intervalMeters}m`,
    // A polygon that would vanish keeps its largest ring, so that a municipality made of small pieces does not disappear.
    'keep-shapes',
    '-dissolve',
    area.codeSource,
    '-o',
    output,
    'format=geojson'
  ];
}

function copyOptions(config: ConversionConfig): string {
  return `FORMAT parquet, COMPRESSION ${config.parquet.compression}, ROW_GROUP_SIZE ${config.parquet.rowGroupSize}`;
}

/** `COPY (query) TO file` as Parquet. DuckDB spatial adds the GeoParquet `geo` metadata for a GEOMETRY column. */
export function buildCopySql(query: string, file: string, config: ConversionConfig): string {
  return `COPY (${query}) TO ${sqlString(file)} (${copyOptions(config)})`;
}

/** The un-simplified raw polygons with the output attribute columns, unassigned areas excluded, ordered by code. */
export function buildRawIntermediateQuery(
  input: string,
  municipalities: DatasetConfig,
  config: ConversionConfig,
  area: AdminAreaConfig
): string {
  const copies = municipalities.columns.map((column) => `${sqlIdent(column.source)} AS ${sqlIdent(column.name)}`);
  const columns = [...copies, `${muniNameSql(area)} AS ${sqlIdent(area.muniNameColumn)}`, sqlIdent(config.geometryColumn)];
  return `SELECT ${columns.join(', ')} FROM ST_Read(${sqlString(input)}) WHERE NOT ${unassignedSql(area)} ORDER BY ${sqlIdent(area.codeColumn)}`;
}

/** Counts, over the raw file, of the two conditions that mean "unassigned area". */
export function buildUnassignedCountsSql(input: string, area: AdminAreaConfig): string {
  const byCode = unassignedSql(area);
  const byName = unassignedByNameSql(area);
  const disagree = unassignedDisagreementSql(area);
  const code = sqlIdent(area.codeSource);
  return `SELECT
    count(*) AS rows,
    count(DISTINCT ${code}) AS codes,
    count(*) FILTER (WHERE ${byCode}) AS by_code_rows,
    count(*) FILTER (WHERE ${byName}) AS by_name_rows,
    count(*) FILTER (WHERE ${disagree}) AS mismatch_rows,
    count(DISTINCT ${code}) FILTER (WHERE ${byCode}) AS unassigned_codes
  FROM ST_Read(${sqlString(input)})`;
}

/** One row per municipality code with the output attributes (a code with two different attribute sets gives two rows). */
export function buildAreasSql(rawIntermediate: string, municipalities: DatasetConfig, area: AdminAreaConfig): string {
  const columns = municipalityColumns(municipalities, area).map(sqlIdent).join(', ');
  return `CREATE OR REPLACE TABLE ${tables.areas} AS SELECT DISTINCT ${columns} FROM read_parquet(${sqlString(rawIntermediate)})`;
}

/**
 * Every part of mapshaper's dissolved municipalities, with an id and its area on the ellipsoid (square metres).
 * `ST_Area_Spheroid` takes latitude first, hence the flip.
 */
export function buildPartsSql(simplified: string, config: ConversionConfig, area: AdminAreaConfig): string {
  const geom = sqlIdent(config.geometryColumn);
  const code = sqlIdent(area.codeColumn);
  return `CREATE OR REPLACE TABLE ${tables.parts} AS
    WITH dumped AS (
      SELECT ${sqlIdent(area.codeSource)} AS ${code}, unnest(ST_Dump(${geom})) AS part FROM ST_Read(${sqlString(simplified)})
    )
    -- part_id follows the read order of the GeoJSON (reproducible: identical outputs across runs)
    SELECT row_number() OVER () AS part_id, ${code}, part.geom AS ${geom}, ST_Area_Spheroid(ST_FlipCoordinates(part.geom)) AS area_m2 FROM dumped`;
}

/** The vertices of every part, as plain coordinates. */
export function buildPartVerticesSql(area: AdminAreaConfig, config: ConversionConfig): string {
  const code = sqlIdent(area.codeColumn);
  return `CREATE OR REPLACE TABLE ${tables.partVertices} AS
    SELECT part_id, ${code}, ST_X(v.geom) AS x, ST_Y(v.geom) AS y
    FROM (SELECT part_id, ${code}, unnest(ST_Dump(ST_Points(${sqlIdent(config.geometryColumn)}))) AS v FROM ${tables.parts})`;
}

/**
 * The parts that touch a part of another code: they share a vertex (equality join on the coordinates). After the
 * snapping of the input, the shared borders of neighbours are made of identical vertices. Without `mapshaper.snap`
 * the test would miss borders and land enclaves would be dropped again.
 */
export function buildPartContactsSql(area: AdminAreaConfig): string {
  const code = sqlIdent(area.codeColumn);
  return `CREATE OR REPLACE TABLE ${tables.partContacts} AS
    SELECT DISTINCT a.part_id FROM ${tables.partVertices} a JOIN ${tables.partVertices} b ON a.x = b.x AND a.y = b.y AND a.${code} <> b.${code}`;
}

/**
 * Which parts are kept (reads `parts(muni_code, part_id, area_m2)` and `part_contacts(part_id)`; no geometry). A part is dropped
 * only when it is below the threshold, is not the largest of its municipality (ties: the lower id wins) and touches no part of
 * another code: a real island. Small parts that touch another municipality (land enclaves) stay.
 */
export function buildPartFlagsSql(config: ConversionConfig, area: AdminAreaConfig): string {
  const code = sqlIdent(area.codeColumn);
  return `CREATE OR REPLACE TABLE ${tables.partFlags} AS
    SELECT part_id, ${code}, area_m2, area_rank, touches_other,
      (area_rank = 1 OR area_m2 >= ${config.island.minAreaSquareMeters} OR touches_other) AS kept
    FROM (
      SELECT p.part_id, p.${code}, p.area_m2,
        row_number() OVER (PARTITION BY p.${code} ORDER BY p.area_m2 DESC, p.part_id) AS area_rank,
        c.part_id IS NOT NULL AS touches_other
      FROM ${tables.parts} p LEFT JOIN ${tables.partContacts} c USING (part_id)
    )`;
}

/** Municipalities kept only because their largest part is below the threshold and touches nothing: the "keep the largest part" rule alone keeps them. */
export function buildKeptOnlyByRankSql(config: ConversionConfig, area: AdminAreaConfig): string {
  return `SELECT f.${sqlIdent(area.codeColumn)} AS code, a.${sqlIdent(area.muniNameColumn)} AS name, f.area_m2
    FROM ${tables.partFlags} f JOIN ${tables.areas} a USING (${sqlIdent(area.codeColumn)})
    WHERE f.area_rank = 1 AND f.area_m2 < ${config.island.minAreaSquareMeters} AND NOT f.touches_other ORDER BY code`;
}

/** Counts of the parts: all, kept, kept although small (they touch another municipality), and the area dropped. */
export function buildPartCountsSql(config: ConversionConfig): string {
  return `SELECT count(*) AS parts, count(*) FILTER (WHERE kept) AS kept,
    count(*) FILTER (WHERE kept AND area_rank > 1 AND area_m2 < ${config.island.minAreaSquareMeters}) AS small_kept,
    coalesce(sum(area_m2) FILTER (WHERE NOT kept), 0) AS dropped_m2 FROM ${tables.partFlags}`;
}

/** The municipalities after the removal of the islands: one MULTIPOLYGON per code, before any repair. */
export function buildMunicipalitiesSimplifiedSql(config: ConversionConfig, area: AdminAreaConfig): string {
  const geom = sqlIdent(config.geometryColumn);
  const code = sqlIdent(area.codeColumn);
  return `CREATE OR REPLACE TABLE ${tables.municipalitiesSimplified} AS
    SELECT p.${code}, ST_Multi(ST_Collect(list(p.${geom}))) AS ${geom}
    FROM ${tables.parts} p JOIN ${tables.partFlags} f USING (part_id) WHERE f.kept GROUP BY p.${code}`;
}

/** `ST_IsValid` is false: what the count before and after the repair counts. */
export function buildInvalidCountSql(table: string, config: ConversionConfig): string {
  return `SELECT count(*) FILTER (WHERE NOT ST_IsValid(${sqlIdent(config.geometryColumn)})) AS invalid FROM ${sqlIdent(table)}`;
}

/** The repaired copy of a table: invalid geometries made valid, keeping the polygonal parts only. Valid ones are untouched. */
export function buildRepairSql(source: string, target: string, keys: string[], config: ConversionConfig): string {
  const geom = sqlIdent(config.geometryColumn);
  const repaired = `ST_Multi(ST_CollectionExtract(ST_MakeValid(${geom}), 3))`;
  return `CREATE OR REPLACE TABLE ${sqlIdent(target)} AS
    SELECT ${keys.map(sqlIdent).join(', ')}, CASE WHEN ST_IsValid(${geom}) THEN ${geom} ELSE ${repaired} END AS ${geom}
    FROM ${sqlIdent(source)}`;
}

/** The output rows of `municipalities`: attributes joined to the repaired geometry, ordered by code. */
export function buildMunicipalitiesOutputQuery(
  repaired: string,
  municipalities: DatasetConfig,
  config: ConversionConfig,
  area: AdminAreaConfig
): string {
  const columns = municipalityColumns(municipalities, area).map((name) => `a.${sqlIdent(name)}`);
  const code = sqlIdent(area.codeColumn);
  return `SELECT ${columns.join(', ')}, m.${sqlIdent(config.geometryColumn)}
    FROM ${sqlIdent(repaired)} m JOIN ${tables.areas} a USING (${code}) ORDER BY a.${code}`;
}

/**
 * Prefectures dissolved from the output municipalities (one union per prefecture; the shared borders are the same
 * vertices). The name comes from the municipality attributes; a code with two names would give two rows.
 */
export function buildPrefecturesSimplifiedSql(
  municipalitiesTable: string,
  config: ConversionConfig,
  area: AdminAreaConfig
): string {
  const geom = sqlIdent(config.geometryColumn);
  const names = [`a.${sqlIdent(area.prefNameColumn)}`];
  const prefCode = sqlIdent(area.prefCodeColumn);
  const code = sqlIdent(area.codeColumn);
  return `CREATE OR REPLACE TABLE ${tables.prefecturesSimplified} AS
    SELECT ${prefCodeSql(`m.${code}`, area)} AS ${prefCode}, ${names.join(', ')},
      ST_Multi(ST_CollectionExtract(ST_Union_Agg(m.${geom}), 3)) AS ${geom}
    FROM ${sqlIdent(municipalitiesTable)} m JOIN ${tables.areas} a USING (${code}) GROUP BY ${prefCode}, ${names.join(', ')}`;
}

/** The output rows of `prefectures`, ordered by code. */
export function buildPrefecturesOutputQuery(repaired: string, config: ConversionConfig, area: AdminAreaConfig): string {
  const names = [sqlIdent(area.prefNameColumn)];
  return `SELECT ${sqlIdent(area.prefCodeColumn)}, ${names.join(', ')}, ${sqlIdent(config.geometryColumn)}
    FROM ${sqlIdent(repaired)} ORDER BY ${sqlIdent(area.prefCodeColumn)}`;
}

/** What is measured on an output file, read back from the file. */
export function buildFileSummarySql(file: string, config: ConversionConfig): string {
  const geom = sqlIdent(config.geometryColumn);
  return `SELECT count(*) AS rows, coalesce(sum(ST_NPoints(${geom})), 0) AS vertices,
    count(*) FILTER (WHERE NOT ST_IsValid(${geom})) AS invalid FROM read_parquet(${sqlString(file)})`;
}

export type UnassignedCounts = { byCodeRows: number; byNameRows: number; mismatchRows: number };

/** A message when the two conditions for an unassigned area do not select the same rows; undefined when they do. */
export function unassignedCheckError(counts: UnassignedCounts, area: AdminAreaConfig): string | undefined {
  if (counts.mismatchRows === 0) return undefined;
  return `The two conditions for an unassigned area (code ends in ${area.unassigned.codeSuffix}; ${area.citySource} = ${area.unassigned.name}) select different rows (${counts.byCodeRows} by code, ${counts.byNameRows} by name, ${counts.mismatchRows} differ). The raw data is not what this command expects.`;
}

/** A message when a table has not the expected number of rows; undefined when it has. */
export function rowCountError(label: string, actual: number, expected: number): string | undefined {
  if (actual === expected) return undefined;
  return `${label}: ${actual} rows, expected ${expected}.`;
}

/** What is measured on an output file; `nullCodes` (rows without a municipality code) only for point files. */
export type OutputSummary = { rows: number; vertices: number; bytes: number; invalid: number; nullCodes?: number };

/** The line printed for an output file at the end of a run. */
export function formatSummaryLine(file: string, summary: OutputSummary): string {
  const format = (value: number): string => value.toLocaleString('en-US');
  const base = `${file}: rows ${format(summary.rows)}, vertices ${format(summary.vertices)}, bytes ${format(summary.bytes)}, invalid geometries ${format(summary.invalid)}`;
  return summary.nullCodes === undefined ? base : `${base}, NULL ${adminAreaConfig.codeColumn} ${format(summary.nullCodes)}`;
}

/** The message when a raw file is missing. */
export function missingRawFileMessage(path: string, config: ConversionConfig): string {
  return `The raw file ${path} is missing. Fetch the raw data first with: ${config.downloadCommand}`;
}
