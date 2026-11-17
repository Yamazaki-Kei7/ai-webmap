import { renameSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { z } from 'zod';
import { buildCopySql, buildFileSummarySql, rowCountError, type OutputSummary } from './convert-plan.js';
import { conversionConfig } from './datasets.config.js';

/** The parts of the data commands that touch a database or the console: shared by `convert.ts`, `convert-places.ts` and `catalog.ts`. */

export const count = z.coerce.number();

export async function queryRows<T>(connection: DuckDBConnection, sql: string, schema: z.ZodType<T>): Promise<T[]> {
  const reader = await connection.runAndReadAll(sql);
  return reader.getRowObjectsJson().map((row) => schema.parse(row));
}

export async function queryOne<T>(connection: DuckDBConnection, sql: string, schema: z.ZodType<T>): Promise<T> {
  const [row] = await queryRows(connection, sql, schema);
  if (row === undefined) throw new Error('A query that must return one row returned none.');
  return row;
}

/** An in-memory DuckDB with the spatial extension loaded; prints the engine and extension versions. */
export async function openDatabase(): Promise<DuckDBConnection> {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  // Installed once by DuckDB itself (the only download of this command); a later run finds it in place.
  await connection.run('INSTALL spatial');
  await connection.run('LOAD spatial');
  const version = await queryOne(
    connection,
    `SELECT version() AS engine, (SELECT extension_version FROM duckdb_extensions() WHERE extension_name = 'spatial') AS spatial`,
    z.object({ engine: z.string(), spatial: z.string() })
  );
  log(`DuckDB ${version.engine}, spatial extension ${version.spatial}`);
  return connection;
}

/** Throws the message of a failed check. */
export function failOn(message: string | undefined): void {
  if (message !== undefined) throw new Error(message);
}

export function log(message: string): void {
  console.log(message);
}

/** Runs a step and prints how long it took. */
export async function step<T>(label: string, run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  log(`[${label}]`);
  const result = await run();
  log(`[${label}] done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  return result;
}

/** The rows of a table, counted. */
export async function countRows(connection: DuckDBConnection, relation: string): Promise<number> {
  const row = await queryOne(connection, `SELECT count(*) AS n FROM ${relation}`, z.object({ n: count }));
  return row.n;
}

/** Where a file is written before its checks pass: `<tempDir>/<name>.partial`. */
export function partialPath(tempDir: string, file: string): string {
  return join(tempDir, `${basename(file)}${conversionConfig.partialSuffix}`);
}

/**
 * Writes a query as Parquet to a temporary name in `tempDir`, runs `check` on it, and moves it to `file` only when the
 * check passes. A failing check (it throws) removes the temporary file and does not touch `file`: a file that failed one
 * of the run's checks is never published. A file that was already at `file` stays. The conversion clears `data/dist/`
 * before it starts, so a failed run leaves no file of an earlier run; the files it published itself in earlier steps stay.
 */
export async function publishChecked<T>(
  connection: DuckDBConnection,
  options: { query: string; file: string; tempDir: string; check: (written: string) => Promise<T> }
): Promise<T> {
  const { query, file, tempDir, check } = options;
  const written = partialPath(tempDir, file);
  rmSync(written, { force: true });
  try {
    await connection.run(buildCopySql(query, written, conversionConfig));
    const result = await check(written);
    // `tempDir` and the folder of `file` must be on one volume: across two volumes the rename fails with `EXDEV`,
    // safely (the partial file is removed below and the run fails).
    renameSync(written, file);
    return result;
  } catch (error) {
    rmSync(written, { force: true });
    throw error;
  }
}

/**
 * Writes a query as a GeoParquet file through `publishChecked`. The checks run on the written file, before it is
 * published: its row count must be the expected one (the file itself, not the table), then `verify` (if given) may
 * throw or return the summary to report (for example with more fields).
 */
export async function writeParquet(
  connection: DuckDBConnection,
  options: {
    query: string;
    file: string;
    label: string;
    expected: number;
    verify?: (written: string, summary: OutputSummary) => Promise<OutputSummary>;
  }
): Promise<OutputSummary> {
  const { query, file, label, expected, verify } = options;
  const summary = await publishChecked(connection, {
    query,
    file,
    tempDir: conversionConfig.dirs.work,
    check: async (written) => {
      const read = await queryOne(
        connection,
        buildFileSummarySql(written, conversionConfig),
        z.object({ rows: count, vertices: count, invalid: count })
      );
      failOn(rowCountError(`${label} (read back from ${file})`, read.rows, expected));
      const base = { ...read, bytes: statSync(written).size };
      return verify === undefined ? base : verify(written, base);
    }
  });
  return summary;
}
