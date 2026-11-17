/**
 * Converts the raw data into the six files of `data/dist/`. Run from the repository root: `npm run data:convert`.
 * Reads only `data/raw/`, writes only `data/work/` and `data/dist/`.
 *
 *  1. DuckDB (spatial): the un-simplified polygons with the output attributes -> `data/work/` (the point-in-polygon search of step 5).
 *  2. mapshaper: simplify all polygons together (shared edges once), dissolve by municipality code -> GeoJSON in `data/work/`.
 *  3. DuckDB: drop small islands (the largest part of a municipality always stays), repair, write `municipalities`.
 *  4. DuckDB: dissolve the municipalities by prefecture, repair, write `prefectures`.
 *  5. DuckDB (`convert-places.ts`): `land_prices`, `stations`, `schools` (points with a municipality) and `railways` (lines).
 *  6. DuckDB (`catalog-write.ts`): the catalog `shared/catalog.json`, measured on the six files just written.
 * The settings are in `datasets.config.ts`; the pure parts (arguments, SQL, checks) are in `convert-plan.ts` and the plan modules.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { DuckDBConnection } from '@duckdb/node-api';
import { z } from 'zod';
import { datasetFileName } from '../../shared/dataset-files.js';
import { writeCatalog } from './catalog-write.js';
import { count, failOn, log, openDatabase, queryOne, queryRows, step, writeParquet } from './convert-io.js';
import { convertPlaces, outputPath, rawPath } from './convert-places.js';
import {
  buildAreasSql,
  buildCopySql,
  buildInvalidCountSql,
  buildKeptOnlyByRankSql,
  buildMapshaperArgs,
  buildMunicipalitiesOutputQuery,
  buildMunicipalitiesSimplifiedSql,
  buildPartContactsSql,
  buildPartCountsSql,
  buildPartFlagsSql,
  buildPartVerticesSql,
  buildPartsSql,
  buildPrefecturesOutputQuery,
  buildPrefecturesSimplifiedSql,
  buildRawIntermediateQuery,
  buildRepairSql,
  buildUnassignedCountsSql,
  formatSummaryLine,
  missingRawFileMessage,
  rowCountError,
  sqlIdent,
  tables,
  unassignedCheckError,
  type OutputSummary
} from './convert-plan.js';
import { adminAreaConfig, conversionConfig, datasetConfig, datasetConfigs, datasetIds } from './datasets.config.js';

/** Starts mapshaper's large-heap launcher with Node and an argument array (no shell). Resolves when it exits with 0. */
function runMapshaper(args: string[]): Promise<void> {
  const launcher = createRequire(import.meta.url).resolve(conversionConfig.mapshaper.launcherModule);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [launcher, ...args], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`mapshaper failed (${code === null ? `signal ${signal}` : `exit code ${code}`}).`));
    });
  });
}

async function checkUnassignedAreas(connection: DuckDBConnection, input: string): Promise<void> {
  const counts = await queryOne(
    connection,
    buildUnassignedCountsSql(input, adminAreaConfig),
    z.object({ rows: count, codes: count, by_code_rows: count, by_name_rows: count, mismatch_rows: count, unassigned_codes: count })
  );
  failOn(
    unassignedCheckError(
      {
        byCodeRows: counts.by_code_rows,
        byNameRows: counts.by_name_rows,
        mismatchRows: counts.mismatch_rows
      },
      adminAreaConfig
    )
  );
  log(
    `Raw: ${counts.rows} polygons, ${counts.codes} codes. Unassigned areas (code and name agree): ${counts.by_code_rows} polygons, ${counts.unassigned_codes} codes, excluded.`
  );
}

async function main(): Promise<void> {
  const { dirs, workFiles } = conversionConfig;
  const municipalities = datasetConfig('municipalities');
  const input = rawPath(municipalities);
  for (const dataset of datasetConfigs) {
    if (!existsSync(rawPath(dataset))) throw new Error(missingRawFileMessage(rawPath(dataset), conversionConfig));
  }
  mkdirSync(dirs.work, { recursive: true });
  mkdirSync(dirs.dist, { recursive: true });

  const rawIntermediate = join(dirs.work, workFiles.municipalitiesRaw);
  const simplified = join(dirs.work, workFiles.municipalitiesSimplified);
  const municipalitiesFile = outputPath('municipalities');
  const prefecturesFile = outputPath('prefectures');
  // A failed run must not leave the files of an earlier run looking like its own result. (A file of this run reaches
  // `data/dist/` only after its checks passed: `writeParquet` writes it to `data/work/` first.)
  for (const file of [rawIntermediate, simplified, ...datasetIds.map((id) => join(dirs.dist, datasetFileName(id)))]) rmSync(file, { force: true });

  const connection = await openDatabase();
  await step('check unassigned areas', () => checkUnassignedAreas(connection, input));

  await step('write the un-simplified intermediate', async () => {
    const query = buildRawIntermediateQuery(input, municipalities, conversionConfig, adminAreaConfig);
    await connection.run(buildCopySql(query, rawIntermediate, conversionConfig));
    await connection.run(buildAreasSql(rawIntermediate, municipalities, adminAreaConfig));
    const areas = await queryOne(connection, `SELECT count(*) AS n FROM ${tables.areas}`, z.object({ n: count }));
    failOn(rowCountError('Municipality attributes (one row per code)', areas.n, adminAreaConfig.expectedRows.municipalities));
  });

  await step('simplify and dissolve with mapshaper', () =>
    runMapshaper(buildMapshaperArgs(input, simplified, conversionConfig, adminAreaConfig))
  );

  const municipalityRows = await step('municipalities', async () => {
    await connection.run(buildPartsSql(simplified, conversionConfig, adminAreaConfig));
    await connection.run(buildPartVerticesSql(adminAreaConfig, conversionConfig));
    await connection.run(buildPartContactsSql(adminAreaConfig));
    await connection.run(buildPartFlagsSql(conversionConfig, adminAreaConfig));
    const parts = await queryOne(
      connection,
      buildPartCountsSql(conversionConfig),
      z.object({ parts: count, kept: count, small_kept: count, dropped_m2: count })
    );
    log(
      `Parts: ${parts.parts} after mapshaper, ${parts.kept} kept (${parts.small_kept} of them small, kept because they touch another municipality), ${parts.parts - parts.kept} dropped as islands (${Math.round(parts.dropped_m2)} m2).`
    );
    const onlyByRank = await queryRows(
      connection,
      buildKeptOnlyByRankSql(conversionConfig, adminAreaConfig),
      z.object({ code: z.string(), name: z.string(), area_m2: count })
    );
    log(`Municipalities kept only because their largest part is a small island: ${onlyByRank.length}`);
    for (const row of onlyByRank) log(`  ${row.code} ${row.name} (${Math.round(row.area_m2)} m2)`);
    await connection.run(buildMunicipalitiesSimplifiedSql(conversionConfig, adminAreaConfig));
    return repairAndWrite({
      connection,
      source: tables.municipalitiesSimplified,
      repaired: tables.municipalitiesRepaired,
      keys: [adminAreaConfig.codeColumn],
      label: 'municipalities',
      expected: adminAreaConfig.expectedRows.municipalities,
      outputQuery: (repaired) => buildMunicipalitiesOutputQuery(repaired, municipalities, conversionConfig, adminAreaConfig),
      file: municipalitiesFile
    });
  });

  const prefectureRows = await step('prefectures', async () => {
    // Dissolved from the municipalities as they are written, so that the prefectural borders are the municipal ones.
    await connection.run(buildPrefecturesSimplifiedSql(tables.municipalitiesRepaired, conversionConfig, adminAreaConfig));
    return repairAndWrite({
      connection,
      source: tables.prefecturesSimplified,
      repaired: tables.prefecturesRepaired,
      keys: [adminAreaConfig.prefCodeColumn, adminAreaConfig.prefNameColumn],
      label: 'prefectures',
      expected: adminAreaConfig.expectedRows.prefectures,
      outputQuery: (repaired) => buildPrefecturesOutputQuery(repaired, conversionConfig, adminAreaConfig),
      file: prefecturesFile
    });
  });

  const placeOutputs = await convertPlaces(connection, { rawIntermediate, municipalitiesFile });

  log('');
  const outputs = [
    { file: municipalitiesFile, summary: municipalityRows },
    { file: prefecturesFile, summary: prefectureRows },
    ...placeOutputs
  ];
  for (const { file, summary } of outputs) {
    log(formatSummaryLine(file, summary));
    if (summary.invalid > 0) log(`  WARNING: ${summary.invalid} invalid geometries remain in ${file} (not repaired).`);
  }
  await step('catalog', () => writeCatalog(connection));

  log(`Intermediate for the point-in-polygon join: ${rawIntermediate} (${statSync(rawIntermediate).size.toLocaleString('en-US')} bytes)`);
}

type RepairAndWrite = {
  connection: DuckDBConnection;
  source: string;
  repaired: string;
  keys: string[];
  label: string;
  expected: number;
  outputQuery: (repairedTable: string) => string;
  file: string;
};

/** Counts the invalid geometries, repairs them, counts again, checks the row count, writes the file, reads it back (`writeParquet`). */
async function repairAndWrite(options: RepairAndWrite): Promise<OutputSummary> {
  const { connection, source, repaired, keys, label, expected, outputQuery, file } = options;
  const invalidSql = (table: string): string => buildInvalidCountSql(table, conversionConfig);
  const invalidSchema = z.object({ invalid: count });
  const before = await queryOne(connection, invalidSql(source), invalidSchema);
  await connection.run(buildRepairSql(source, repaired, keys, conversionConfig));
  const after = await queryOne(connection, invalidSql(repaired), invalidSchema);
  log(`${label}: invalid geometries ${before.invalid} before the repair, ${after.invalid} after.`);
  const rows = await queryOne(connection, `SELECT count(*) AS n FROM ${sqlIdent(repaired)}`, z.object({ n: count }));
  failOn(rowCountError(label, rows.n, expected));
  return writeParquet(connection, { query: outputQuery(repaired), file, label, expected });
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? `data:convert failed: ${error.message}` : 'data:convert failed.');
  process.exitCode = 1;
}
