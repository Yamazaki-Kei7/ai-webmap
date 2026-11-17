/**
 * The steps of `npm run data:convert` for the four datasets of task 1.4 (land prices, stations, schools, railways).
 * They run after the administrative areas: they read the written `municipalities` file (the names) and the
 * un-simplified intermediate (the polygons of the point-in-polygon search). The pure parts are in `place-plan.ts`,
 * `railway-plan.ts` and `rules-sql.ts`; the settings are in `datasets.config.ts`.
 */
import { join } from 'node:path';
import type { DuckDBConnection } from '@duckdb/node-api';
import { z } from 'zod';
import { datasetFileName } from '../../shared/dataset-files.js';
import { count, countRows, failOn, log, queryOne, queryRows, step, writeParquet } from './convert-io.js';
import { rowCountError, sqlIdent, sqlString, type OutputSummary } from './convert-plan.js';
import { conversionConfig, placeConfig, pointDataset, railwayRules, sourceDataset, type DatasetConfig, type PointDataset } from './datasets.config.js';
import {
  buildCodesOutsideSql,
  buildContainingSql,
  buildLocatedSql,
  buildMunicipalityAttributesSql,
  buildMunicipalityBoundsSql,
  buildNearestSql,
  buildNullCodeCountSql,
  buildPointListSql,
  buildPointOutputQuery,
  buildPreparedSql,
  buildResolutionStatsSql,
  buildResolvedSql,
  codesOutsideError,
  datasetTables,
  placeTables
} from './place-plan.js';
import {
  buildGeometryTypesSql,
  buildRailwayDissolvedSql,
  buildRailwayOutputQuery,
  buildRailwaySimplifiedSql,
  buildRailwaySourceCountSql,
  railwayTables,
  vertexBudgetError
} from './railway-plan.js';
import { buildUnknownCodesSql, unknownCodeError } from './rules-sql.js';

/** The files the four datasets depend on. */
export type PlaceInputs = { rawIntermediate: string; municipalitiesFile: string };

/** A written output file and what was measured on it. */
export type OutputFile = { file: string; summary: OutputSummary };

/** The path of the raw file of a dataset. */
export function rawPath(dataset: DatasetConfig): string {
  return join(conversionConfig.dirs.raw, dataset.input);
}

/** The path of the output file of a dataset. */
export function outputPath(id: string): string {
  return join(conversionConfig.dirs.dist, datasetFileName(id));
}

/** Fails, naming dataset, column and code, when a label column has a code that no label covers. */
async function checkLabels(connection: DuckDBConnection, dataset: DatasetConfig, table: string): Promise<void> {
  for (const [column, labels] of Object.entries(dataset.codeLabels ?? {})) {
    const source = dataset.columns.find((candidate) => candidate.name === column)?.source;
    if (source === undefined) throw new Error(`${dataset.id}: codeLabels names "${column}", which is not one of its columns.`);
    const uncovered = await queryRows(connection, buildUnknownCodesSql(table, source, labels), z.object({ code: z.string().nullable() }));
    failOn(unknownCodeError(dataset.id, column, uncovered.map((row) => row.code)));
  }
}

/** The tables the point datasets read: names and polygons of the municipalities. */
async function loadMunicipalityTables(connection: DuckDBConnection, inputs: PlaceInputs): Promise<void> {
  await connection.run(buildMunicipalityAttributesSql(inputs.municipalitiesFile));
  await connection.run(buildMunicipalityBoundsSql(inputs.rawIntermediate, conversionConfig));
  const attributes = await countRows(connection, placeTables.municipalityAttributes);
  const bounds = await countRows(connection, placeTables.municipalityBounds);
  log(`Municipality names: ${attributes} codes. Polygons for the point search: ${bounds}.`);
}

const resolutionStats = z.object({
  rows: count,
  by_source: count,
  by_containing: count,
  by_nearest: count,
  unresolved: count,
  source_unknown: count,
  source_differs: count,
  source_outside: count,
  on_border: count
});

const pointRow = z.object({
  name: z.string().nullable(),
  lon: z.number(),
  lat: z.number(),
  code: z.string().nullable(),
  nearest_code: z.string().nullable(),
  nearest_meters: z.number().nullable()
});

/** Prints the way the points of a dataset got their municipality code, and every point that took the nearest rule or stayed NULL. */
async function reportResolution(connection: DuckDBConnection, dataset: PointDataset): Promise<void> {
  const stats = await queryOne(connection, buildResolutionStatsSql(dataset), resolutionStats);
  log(
    `${dataset.id}: ${stats.rows} rows. Code from: source attribute ${stats.by_source}, containing polygon ${stats.by_containing}, nearest polygon within ${placeConfig.nearest.limitMeters} m ${stats.by_nearest}, none (NULL) ${stats.unresolved}.`
  );
  log(
    `  Source code not in municipalities: ${stats.source_unknown}. Source code (in municipalities) differs from the containing polygon: ${stats.source_differs}; source code but no containing polygon: ${stats.source_outside}. Points on a border of two polygons: ${stats.on_border}.`
  );
  const nearest = await queryRows(connection, buildPointListSql(dataset, placeConfig.methods.nearest), pointRow);
  for (const row of nearest) {
    log(`  nearest: ${row.name} (${row.lon}, ${row.lat}) -> ${row.code}, ${row.nearest_meters?.toFixed(1)} m`);
  }
  const unresolved = await queryRows(connection, buildPointListSql(dataset, undefined), pointRow);
  for (const row of unresolved) {
    const reach = row.nearest_code === null ? 'no polygon within reach' : `nearest ${row.nearest_code} at ${row.nearest_meters?.toFixed(1)} m`;
    log(`  NULL: ${row.name} (${row.lon}, ${row.lat}), ${reach}`);
  }
}

/** One point file: prepare, label check, spatial search, rules, write, read back, check the codes. */
async function convertPoints(connection: DuckDBConnection, id: string, inputs: PlaceInputs): Promise<OutputFile> {
  const dataset = pointDataset(id);
  const tables = datasetTables(id);
  const file = outputPath(id);
  await connection.run(buildPreparedSql(rawPath(dataset), dataset, conversionConfig));
  const sourceRows = await countRows(connection, sqlIdent(tables.prepared));
  failOn(rowCountError(`${id} (raw rows)`, sourceRows, dataset.expectedSourceRows));
  await checkLabels(connection, dataset, tables.prepared);

  await connection.run(buildContainingSql(dataset, conversionConfig));
  await connection.run(buildNearestSql(dataset, conversionConfig));
  await connection.run(buildLocatedSql(dataset));
  await connection.run(buildResolvedSql(dataset));
  const kept = await countRows(connection, sqlIdent(tables.resolved));
  log(`${id}: ${sourceRows} raw rows, ${sourceRows - kept} dropped by its rules, ${kept} kept.`);
  failOn(rowCountError(id, kept, dataset.expectedRows));
  await reportResolution(connection, dataset);

  const summary = await writeParquet(connection, {
    query: buildPointOutputQuery(dataset, conversionConfig),
    file,
    label: id,
    expected: dataset.expectedRows,
    // Checked on the file before it is published: a code outside `municipalities` fails the run and leaves no output.
    verify: async (written, summary) => {
      const outside = await queryRows(
        connection,
        buildCodesOutsideSql(`read_parquet(${sqlString(written)})`, `read_parquet(${sqlString(inputs.municipalitiesFile)})`),
        z.object({ code: z.string() })
      );
      failOn(codesOutsideError(`${id} (read back from ${file})`, outside.map((row) => row.code)));
      const nulls = await queryOne(connection, buildNullCodeCountSql(written), z.object({ null_codes: count }));
      return { ...summary, nullCodes: nulls.null_codes };
    }
  });
  return { file, summary };
}

/** `railways`: dissolve, merge, simplify, write, check the vertex budget. */
async function convertRailways(connection: DuckDBConnection): Promise<OutputFile> {
  const dataset = sourceDataset(railwayRules.datasetId);
  const file = outputPath(dataset.id);
  const sourceRows = await queryOne(connection, buildRailwaySourceCountSql(rawPath(dataset)), z.object({ n: count }));
  failOn(rowCountError(`${dataset.id} (raw rows)`, sourceRows.n, dataset.expectedSourceRows));
  await connection.run(buildRailwayDissolvedSql(rawPath(dataset), dataset, conversionConfig));
  await checkLabels(connection, dataset, railwayTables.dissolved);
  const groups = await countRows(connection, railwayTables.dissolved);
  failOn(rowCountError(`${dataset.id} (groups)`, groups, dataset.expectedRows));
  const typeRow = z.object({ geometry_type: z.string(), rows: count, vertices: count });
  const describe = async (table: string): Promise<string> => {
    const rows = await queryRows(connection, buildGeometryTypesSql(table, conversionConfig), typeRow);
    return rows.map((row) => `${row.geometry_type} ${row.rows} (${row.vertices} vertices)`).join(', ');
  };
  log(`${dataset.id}: ${sourceRows.n} sections -> ${groups} lines. Merged: ${await describe(railwayTables.dissolved)}`);
  await connection.run(buildRailwaySimplifiedSql(dataset, conversionConfig));
  log(`${dataset.id}: simplified with ${railwayRules.simplifyToleranceMeters} m. ${await describe(railwayTables.simplified)}`);
  const summary = await writeParquet(connection, {
    query: buildRailwayOutputQuery(dataset, conversionConfig),
    file,
    label: dataset.id,
    expected: dataset.expectedRows,
    verify: async (_written, read) => {
      failOn(vertexBudgetError(`${dataset.id} (read back from ${file})`, read.vertices, railwayRules.vertexBudget));
      return read;
    }
  });
  return { file, summary };
}

/** Converts the four datasets; the administrative areas must have been written. */
export async function convertPlaces(connection: DuckDBConnection, inputs: PlaceInputs): Promise<OutputFile[]> {
  await step('municipality tables for the point search', () => loadMunicipalityTables(connection, inputs));
  const outputs: OutputFile[] = [];
  for (const id of placeConfig.pointDatasets) outputs.push(await step(id, () => convertPoints(connection, id, inputs)));
  outputs.push(await step(railwayRules.datasetId, () => convertRailways(connection)));
  return outputs;
}
