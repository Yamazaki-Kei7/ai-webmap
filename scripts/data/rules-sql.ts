import { sqlIdent, sqlString } from './convert-plan.js';
import { landPriceRules, placeConfig, stationRules, type DatasetConfig } from './datasets.config.js';

/**
 * The rules of the four datasets of task 1.4 as SQL expressions over plain columns: the labels, the change rate, the
 * passenger count, the station that is kept, and the choice of the municipality code. Nothing here needs the spatial
 * extension: the spatial results (containing code, nearest code and distance) arrive as plain columns, so every rule
 * runs on a small hand-made table.
 */

type LandPriceRules = typeof landPriceRules;
type StationRules = typeof stationRules;

/** The columns of the table that holds the spatial results of a point (see `place-plan.ts`). */
export const locatedColumns = {
  sourceCode: 'source_code',
  containingCode: 'containing_code',
  nearestCode: 'nearest_code',
  nearestMeters: 'nearest_distance_m'
} as const;

/** `CASE code WHEN 'a' THEN 'label' … END`; a code without a label gives NULL (the check before it makes such a run fail). */
export function labelSql(codeExpression: string, labels: Record<string, string>): string {
  const branches = Object.entries(labels).map(([code, label]) => `WHEN ${sqlString(code)} THEN ${sqlString(label)}`);
  return `CASE ${codeExpression} ${branches.join(' ')} END`;
}

/** The distinct values of a code column that have no label, NULL included (a label column is never NULL). */
export function buildUnknownCodesSql(table: string, codeColumn: string, labels: Record<string, string>): string {
  const known = Object.keys(labels).map(sqlString).join(', ');
  const column = sqlIdent(codeColumn);
  return `SELECT DISTINCT ${column} AS code FROM ${sqlIdent(table)} WHERE ${column} IS NULL OR ${column} NOT IN (${known}) ORDER BY 1`;
}

/** The message of a code without a label (naming the dataset, the column and the code); undefined when there is none. */
export function unknownCodeError(dataset: string, column: string, codes: (string | null)[]): string | undefined {
  if (codes.length === 0) return undefined;
  const shown = codes.map((code) => (code === null ? 'NULL' : sqlString(code))).join(', ');
  return `${dataset}: column ${column} has code(s) without a label: ${shown}. Add them to codeLabels in datasets.config.ts.`;
}

/** The change rate; NULL for the selection statuses where the source stores a placeholder 0.0. */
export function changeRateSql(rate: string, status: string, rules: LandPriceRules): string {
  const statuses = rules.noRateStatuses.join(', ');
  return `CASE WHEN ${status} IN (${statuses}) THEN NULL ELSE ${rate} END`;
}

/**
 * The passenger count: the number only where it is this line's row (`duplicate`) and the data exists (`existence`).
 * The source stores 0 for "no data", "not disclosed" and "recorded on another line's row"; those are NULL here, and
 * a real 0 (both codes right) stays 0.
 */
export function passengersSql(value: string, duplicate: string, existence: string, rules: StationRules): string {
  return `CASE WHEN ${duplicate} = ${rules.recordedHereCode} AND ${existence} = ${rules.dataExistsCode} THEN ${value} END`;
}

/** True for the stations that are kept: the row does not say "no station" (a NULL code keeps the row). */
export function stationKeptSql(existence: string, rules: StationRules): string {
  return `${existence} IS DISTINCT FROM ${rules.noStationCode}`;
}

/** The three branches of the choice of a code (source attribute, containing polygon, nearest polygon within the limit), each giving `values`. */
function codeChoiceSql(knownCodesQuery: string, limitMeters: number, values: { source: string; containing: string; nearest: string }): string {
  const { sourceCode, containingCode, nearestCode, nearestMeters } = locatedColumns;
  return `CASE
    WHEN ${sourceCode} IN (${knownCodesQuery}) THEN ${values.source}
    WHEN ${containingCode} IS NOT NULL THEN ${values.containing}
    WHEN ${nearestCode} IS NOT NULL AND ${nearestMeters} <= ${limitMeters} THEN ${values.nearest}
  END`;
}

/**
 * The municipality code of a point: the code of the source attribute when `knownCodesQuery` (a query that returns the
 * codes of `municipalities`) has it; otherwise the code of the polygon that contains the point; otherwise the code of
 * the nearest polygon when it is within the limit; otherwise NULL. A code that joins to nothing is never kept.
 */
export function chosenCodeSql(knownCodesQuery: string, limitMeters: number): string {
  const { sourceCode, containingCode, nearestCode } = locatedColumns;
  return codeChoiceSql(knownCodesQuery, limitMeters, { source: sourceCode, containing: containingCode, nearest: nearestCode });
}

/** Which of the three branches gave the code, as the label of `placeConfig.methods` (NULL when the code stays NULL). */
export function codeMethodSql(knownCodesQuery: string, limitMeters: number): string {
  const { methods } = placeConfig;
  return codeChoiceSql(knownCodesQuery, limitMeters, {
    source: sqlString(methods.source),
    containing: sqlString(methods.containing),
    nearest: sqlString(methods.nearest)
  });
}

/**
 * One output column of a dataset, from the table `alias`: the label of a code, a rule of `overrides` (keyed by the
 * output column name; it receives the SQL of the source attribute) or the plain source attribute, then cast to the
 * configured type when there is one.
 */
export function outputColumnSql(
  dataset: DatasetConfig,
  column: DatasetConfig['columns'][number],
  alias: string,
  overrides: Record<string, (source: string) => string>
): string {
  const source = `${alias}.${sqlIdent(column.source)}`;
  const labels = dataset.codeLabels?.[column.name];
  const override = overrides[column.name];
  const value = labels !== undefined ? labelSql(source, labels) : override !== undefined ? override(source) : source;
  // The configured type is the only place a column's type is decided: it applies to whatever produced the value.
  const expression = column.type !== undefined ? `CAST(${value} AS ${column.type})` : value;
  return `${expression} AS ${sqlIdent(column.name)}`;
}

/** `ORDER BY` terms for the configured source keys of a dataset. */
export function orderTerms(alias: string, keys: string[]): string[] {
  return keys.map((key) => `${alias}.${sqlIdent(key)}`);
}
