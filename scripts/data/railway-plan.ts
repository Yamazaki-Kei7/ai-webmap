import { sqlIdent, sqlString } from './convert-plan.js';
import { railwayRules, type ConversionConfig, type SourceDataset } from './datasets.config.js';
import { orderTerms, outputColumnSql } from './rules-sql.js';

/**
 * The SQL of `railways`: the sections of the source are dissolved by the four attribute columns together (so that a
 * line never mixes two codes), merged where they join, and simplified. Needs the spatial extension.
 */

export const railwayTables = {
  dissolved: 'railways_dissolved',
  simplified: 'railways_simplified'
} as const;

/** The number of raw sections. */
export function buildRailwaySourceCountSql(input: string): string {
  return `SELECT count(*) AS n FROM ST_Read(${sqlString(input)})`;
}

/** The dissolve key: the source attribute of every output column. */
function dissolveKeys(dataset: SourceDataset): string[] {
  return dataset.columns.map((column) => column.source);
}

/**
 * One row per distinct (line name, operator, railway type, operator type): the sections collected and line-merged.
 * The sections go in by their text form so that the result does not depend on the order the file is read in.
 * A group that merges into one line becomes a LINESTRING. `ST_LineMerge` does not join lines at a node where three or more
 * meet (a branch or a junction), so such a group, and a group with a separate part, becomes a MULTILINESTRING.
 */
export function buildRailwayDissolvedSql(input: string, dataset: SourceDataset, config: ConversionConfig): string {
  const geom = sqlIdent(config.geometryColumn);
  const keys = dissolveKeys(dataset).map(sqlIdent).join(', ');
  return `CREATE OR REPLACE TABLE ${railwayTables.dissolved} AS
    SELECT ${keys}, ST_LineMerge(ST_Collect(list(${geom} ORDER BY ST_AsText(${geom})))) AS ${geom}
    FROM ST_Read(${sqlString(input)}) GROUP BY ${keys}`;
}

/** The simplification tolerance in degrees (the tolerance in metres over `conversionConfig.metersPerDegree`). */
function simplifyToleranceDegrees(config: ConversionConfig): number {
  return railwayRules.simplifyToleranceMeters / config.metersPerDegree;
}

/**
 * Every line simplified with Douglas-Peucker, kept valid on its own (no self-intersection or collapse). Contacts between
 * lines are not kept: see the measurement in docs/data-sources.md. The ends of a line stay where they are (no
 * coordinate is moved, vertices are only dropped), so a line that ended on another line's vertex keeps its end;
 * whether the other line keeps that vertex is measured, not assumed (docs/data-sources.md).
 */
export function buildRailwaySimplifiedSql(dataset: SourceDataset, config: ConversionConfig): string {
  const geom = sqlIdent(config.geometryColumn);
  const keys = dissolveKeys(dataset).map(sqlIdent).join(', ');
  return `CREATE OR REPLACE TABLE ${railwayTables.simplified} AS
    SELECT ${keys}, ST_SimplifyPreserveTopology(${geom}, ${simplifyToleranceDegrees(config)}) AS ${geom} FROM ${railwayTables.dissolved}`;
}

/** The output rows of `railways`: labels applied, ordered by the configured keys. */
export function buildRailwayOutputQuery(dataset: SourceDataset, config: ConversionConfig): string {
  const columns = dataset.columns.map((column) => outputColumnSql(dataset, column, 'r', {}));
  return `SELECT ${[...columns, `r.${sqlIdent(config.geometryColumn)}`].join(', ')}
    FROM ${railwayTables.simplified} r ORDER BY ${orderTerms('r', dataset.orderBy).join(', ')}`;
}

/** Rows, vertices and geometry types of a work table (one row per geometry type). */
export function buildGeometryTypesSql(table: string, config: ConversionConfig): string {
  const geom = sqlIdent(config.geometryColumn);
  return `SELECT CAST(ST_GeometryType(${geom}) AS VARCHAR) AS geometry_type, count(*) AS rows, sum(ST_NPoints(${geom})) AS vertices FROM ${sqlIdent(table)} GROUP BY 1 ORDER BY 1`;
}

/** The message when the written file has more vertices than the budget; undefined when it fits. */
export function vertexBudgetError(label: string, vertices: number, budget: number): string | undefined {
  if (vertices <= budget) return undefined;
  return `${label}: ${vertices} vertices, over the budget of ${budget}. Raise railwayRules.simplifyToleranceMeters in datasets.config.ts.`;
}
