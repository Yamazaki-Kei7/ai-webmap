import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  aggregateFunctions,
  conditionalFunctions,
  dateTimeFunctions,
  listFunctions,
  mathFunctions,
  tableFunctions,
  textFunctions,
  windowFunctions
} from '../../shared/sqlFunctions.js';
import { openMemoryDatabase } from '../data/sql-test-support.js';

/**
 * The non-spatial names of the SQL guard's allow list exist in DuckDB and are not table functions (except the three
 * listed ones). In-memory database, no extension, no INSTALL / LOAD. The spatial names are checked in Task 2.2.
 */

const nonSpatial: readonly string[] = [
  ...aggregateFunctions,
  ...windowFunctions,
  ...mathFunctions,
  ...conditionalFunctions,
  ...textFunctions,
  ...dateTimeFunctions,
  ...listFunctions,
  ...tableFunctions
];

/** Names the parser handles itself (not in `duckdb_functions()`): one query each, to show they run. */
const syntaxLevelQueries: Record<string, string> = {
  row_number: 'SELECT row_number() OVER ()',
  rank: 'SELECT rank() OVER (ORDER BY 1)',
  dense_rank: 'SELECT dense_rank() OVER (ORDER BY 1)',
  ntile: 'SELECT ntile(2) OVER (ORDER BY 1)',
  percent_rank: 'SELECT percent_rank() OVER (ORDER BY 1)',
  cume_dist: 'SELECT cume_dist() OVER (ORDER BY 1)',
  lag: 'SELECT lag(1) OVER (ORDER BY 1)',
  lead: 'SELECT lead(1) OVER (ORDER BY 1)',
  first_value: 'SELECT first_value(1) OVER (ORDER BY 1)',
  last_value: 'SELECT last_value(1) OVER (ORDER BY 1)',
  nth_value: 'SELECT nth_value(1, 1) OVER (ORDER BY 1)',
  coalesce: 'SELECT coalesce(NULL, 1)',
  ifnull: 'SELECT ifnull(NULL, 1)',
  if: 'SELECT if(true, 1, 2)'
};

const functionRow = z.object({ function_name: z.string(), function_type: z.string() });

describe('allow list against DuckDB', () => {
  const typesByName = new Map<string, string[]>();
  let runQuery: (sql: string) => Promise<void>;

  beforeAll(async () => {
    const connection = await openMemoryDatabase();
    await connection.run('SET autoinstall_known_extensions=false');
    await connection.run('SET autoload_known_extensions=false');
    const reader = await connection.runAndReadAll('SELECT DISTINCT function_name, function_type FROM duckdb_functions()');
    for (const row of reader.getRowObjectsJson().map((item) => functionRow.parse(item))) {
      typesByName.set(row.function_name, [...(typesByName.get(row.function_name) ?? []), row.function_type]);
    }
    runQuery = async (sql) => {
      await connection.runAndReadAll(sql);
    };
  });

  it('has every non-spatial name, as a function or as syntax that runs', async () => {
    const unlisted = nonSpatial.filter((name) => !typesByName.has(name));
    expect(unlisted.sort()).toEqual(Object.keys(syntaxLevelQueries).sort());
    for (const sql of Object.values(syntaxLevelQueries)) await runQuery(sql);
  });

  it('has no table function except the listed ones', () => {
    const tableLike = nonSpatial.filter((name) => (typesByName.get(name) ?? []).some((type) => type.startsWith('table')));
    expect(tableLike.sort()).toEqual([...tableFunctions].sort());
  });
});
