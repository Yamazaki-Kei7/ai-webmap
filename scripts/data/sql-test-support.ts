import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { z } from 'zod';
import { sqlIdent } from './convert-plan.js';

/** Helpers of the SQL tests: an in-memory DuckDB with the core only (no extension), and the expression runner. */

export async function openMemoryDatabase(): Promise<DuckDBConnection> {
  const instance = await DuckDBInstance.create(':memory:');
  return instance.connect();
}

/** Evaluates one SQL expression over the given rows in an in-memory DuckDB (core only; no extension). */
export async function evaluate(columns: string[], rows: string[][], expression: string): Promise<string[]> {
  const connection = await openMemoryDatabase();
  const values = rows.map((row) => `(${row.join(', ')})`).join(', ');
  const reader = await connection.runAndReadAll(`SELECT (${expression})::VARCHAR AS result FROM (VALUES ${values}) AS t(${columns.map(sqlIdent).join(', ')})`);
  return reader.getRowObjectsJson().map((row) => z.object({ result: z.string().nullable() }).parse(row).result ?? 'NULL');
}
