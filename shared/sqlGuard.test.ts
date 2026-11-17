import { describe, expect, it } from 'vitest';
import { dataConfig, queryConfig } from './config';
import { datasetIds } from './datasets';
import {
  aggregateFunctions,
  allowedFunctions,
  conditionalFunctions,
  dateTimeFunctions,
  listFunctions,
  mathFunctions,
  parenthesisKeywords,
  spatialFunctions,
  tableFunctions,
  textFunctions,
  windowFunctions
} from './sqlFunctions';
import { forbiddenFunctionAffixes, forbiddenFunctionNames, forbiddenKeywords, validateSql } from './sqlGuard';

const geom = dataConfig.geoParquet.geometryColumn;

function accepted(sql: string): { sql: string; tables: string[] } {
  const result = validateSql(sql, datasetIds);
  if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`);
  return result;
}

function rejectionReason(sql: string): string {
  const result = validateSql(sql, datasetIds);
  if (result.ok) throw new Error('expected a rejection');
  return result.reason;
}

type AllowedCase = { name: string; sql: string };

const allowed: AllowedCase[] = [
  { name: 'plain select on a view', sql: 'SELECT station_name, passengers_per_day FROM stations' },
  {
    name: 'CTE joining two views',
    sql: `WITH s AS (SELECT muni_code, passengers_per_day FROM stations)
      SELECT m.city_name, sum(s.passengers_per_day) FROM municipalities m JOIN s USING (muni_code) GROUP BY 1`
  },
  {
    name: 'spatial functions of the app',
    sql: `SELECT ST_AsWKB(ST_Centroid(m.${geom})) AS c, ST_Area_Spheroid(m.${geom}) AS a
      FROM municipalities m JOIN stations s ON ST_Intersects(m.${geom}, s.${geom})`
  },
  { name: 'spatial predicates and measures', sql: `SELECT ST_DWithin(a.${geom}, b.${geom}, 0.1), ST_Distance(a.${geom}, b.${geom}) FROM stations a, schools b` },
  { name: 'bounding box filter', sql: `SELECT * FROM stations WHERE ST_Intersects(${geom}, ST_MakeEnvelope(139, 35, 140, 36))` },
  { name: 'SELECT * EXCLUDE', sql: `SELECT * EXCLUDE (${geom}) FROM stations` },
  { name: 'SELECT * RENAME', sql: 'SELECT * RENAME (pref_name AS pref) FROM prefectures' },
  { name: 'SELECT * REPLACE', sql: 'SELECT * REPLACE (upper(pref_name) AS pref_name) FROM prefectures' },
  { name: 'numbers in all DuckDB forms', sql: 'SELECT 1, 1.5, .5, 1e5, 1E-3, 1_000, 2.' },
  { name: 'ASCII white space of every kind', sql: 'SELECT\t1\f,\v2\r\n,3' },
  { name: 'replace() is a string function', sql: "SELECT replace(station_name, 'a', 'b') FROM stations" },
  { name: 'trailing semicolon', sql: 'SELECT 1;' },
  { name: 'trailing semicolon then white space', sql: 'SELECT 1;  \n ' },
  { name: 'trailing comment after the semicolon', sql: 'SELECT 1; --' },
  { name: 'comments before, inside and after', sql: '-- a\nSELECT /* b */ 1 /* c */ -- d' },
  { name: 'nested block comment', sql: 'SELECT /* a /* b */ still a comment */ 1' },
  { name: 'line comment ended by a carriage return', sql: 'SELECT 1 AS a --x\r, 2 AS b' },
  { name: 'forbidden word in a line comment', sql: 'SELECT 1 -- DROP TABLE stations' },
  { name: 'forbidden word in a block comment', sql: 'SELECT 1 /* COPY x TO y; read_csv */' },
  { name: 'forbidden word in a literal', sql: "SELECT * FROM stations WHERE operator = 'COPY'" },
  { name: 'lower-case forbidden word in a literal', sql: "SELECT * FROM stations WHERE operator = 'drop'" },
  { name: 'semicolon in a literal', sql: "SELECT 'a;b' AS x" },
  { name: 'E string with an escaped quote', sql: "SELECT E'it\\'s' AS x" },
  { name: 'lower-case e string', sql: "SELECT e'x\\'y' AS x" },
  { name: 'doubled quote in a literal', sql: "SELECT 'it''s' AS x" },
  { name: 'Japanese text literal', sql: "SELECT * FROM municipalities WHERE city_name = '札幌市'" },
  { name: 'Japanese unquoted alias', sql: 'SELECT 1 AS 人口' },
  {
    name: 'aliases that contain a forbidden word as part of a longer word',
    sql: 'SELECT 1 AS updated_at, 2 AS settlement, 3 AS loader, 4 AS copyright, 5 AS reset_count, 6 AS created, 7 AS usefulness'
  },
  { name: 'mixed upper and lower case', sql: 'sElEcT Station_Name FrOm StAtIoNs' },
  // A comment is replaced by a space, so this is the two words `co` and `py` (DuckDB tokenises it the same way), not `copy`.
  { name: 'comment between letters', sql: 'SELECT 1 AS co/**/py' },
  { name: 'quoted view name', sql: 'SELECT * FROM "stations"' },
  { name: 'quoted identifier with a forbidden keyword inside', sql: 'SELECT 1 AS "drop"' },
  { name: 'separator literal with a dash', sql: "SELECT split_part(line_name, ' - ', 1) FROM railways" },
  { name: 'name that only contains read_ inside', sql: 'SELECT 1 AS already_read_count' },
  {
    name: 'aggregates with FILTER',
    sql: 'SELECT count(*) FILTER (WHERE passengers_per_day > 100) AS n, avg(passengers_per_day) FILTER (WHERE operator IS NOT NULL) FROM stations'
  },
  {
    name: 'window function with PARTITION BY and ORDER BY',
    sql: 'SELECT row_number() OVER (PARTITION BY pref_name ORDER BY passengers_per_day DESC) AS r, lag(passengers_per_day) OVER (ORDER BY station_name) FROM stations'
  },
  { name: 'CAST to DECIMAL', sql: 'SELECT CAST(passengers_per_day AS DECIMAL(10, 2)), try_cast(muni_code AS INTEGER) FROM stations' },
  { name: 'method-style call of an allowed function', sql: 'SELECT station_name.upper() FROM stations' },
  { name: 'range table function', sql: 'SELECT * FROM range(10)' },
  { name: 'unnest of a list', sql: 'SELECT unnest(list_value(1, 2)) AS v' },
  { name: 'IN list', sql: 'SELECT * FROM stations WHERE muni_code IN (1, 2) OR muni_code NOT IN (3)' },
  { name: 'EXISTS subquery', sql: 'SELECT * FROM municipalities m WHERE EXISTS (SELECT 1 FROM stations s WHERE s.muni_code = m.muni_code)' },
  { name: 'subquery in FROM and a lateral join', sql: 'SELECT * FROM (SELECT 1 AS a) t, LATERAL (SELECT t.a + 1 AS b) u' },
  { name: 'DISTINCT ON', sql: 'SELECT DISTINCT ON (pref_name) pref_name, station_name FROM stations' },
  { name: 'ordered aggregate with ORDER BY inside', sql: "SELECT string_agg(station_name, ',' ORDER BY station_name) FROM stations" },
  { name: 'extract and interval', sql: "SELECT extract(year FROM DATE '2020-01-01'), INTERVAL (1) DAY" }
];

describe('validateSql: accepted SQL', () => {
  it.each(allowed)('accepts $name', ({ sql }) => {
    const result = validateSql(sql, datasetIds);
    expect(result.ok, result.ok ? '' : result.reason).toBe(true);
  });

  it('lists the referenced views once each, in the order of the known tables', () => {
    const result = accepted('SELECT * FROM schools, STATIONS s JOIN stations t ON true, "municipalities"');
    expect(result.tables).toEqual(['municipalities', 'stations', 'schools']);
  });

  it('matches a quoted view name exactly (case-sensitive)', () => {
    expect(accepted('SELECT * FROM "stations"').tables).toEqual(['stations']);
    expect(accepted('SELECT * FROM "STATIONS"').tables).toEqual([]);
  });

  it('does not list views that appear only in comments or literals', () => {
    expect(accepted("SELECT 'stations' /* schools */ -- railways").tables).toEqual([]);
  });

  it('uses the known tables it is given', () => {
    const result = validateSql('SELECT * FROM foo, bar', ['bar', 'baz', 'foo']);
    expect(result).toEqual({ ok: true, sql: 'SELECT * FROM foo, bar', tables: ['bar', 'foo'] });
  });
});

describe('validateSql: returned sql', () => {
  it('removes comments, the trailing semicolon and the outer white space', () => {
    expect(accepted('  -- a\nSELECT /* b */ 1 AS x; -- c\n').sql).toBe('SELECT   1 AS x');
  });

  it('drops a trailing line comment so the sql can be wrapped as a subquery', () => {
    const { sql } = accepted('SELECT 1 AS x -- note');
    expect(sql).toBe('SELECT 1 AS x');
    expect(`SELECT * FROM (${sql}) t`).toBe('SELECT * FROM (SELECT 1 AS x) t');
  });

  it('replaces a comment by one space', () => {
    expect(accepted('SELECT 1 AS co/**/py').sql).toBe('SELECT 1 AS co py');
  });

  it('replaces a nested comment as a whole', () => {
    expect(accepted('SELECT /* a /* b */ c */ 1').sql).toBe('SELECT   1');
  });

  it('keeps literals and quoted identifiers unchanged', () => {
    const sql = `SELECT 'it''s -- not a comment' AS "a--b", E'x\\'y' FROM stations`;
    expect(accepted(sql).sql).toBe(sql);
  });

  it('removes only one trailing semicolon (a second one is rejected)', () => {
    expect(accepted('SELECT 1;').sql).toBe('SELECT 1');
    expect(rejectionReason('SELECT 1;;')).toContain('Only one');
  });
});

// The names, prefixes, suffixes and keywords the rules require, written out here so removing one from the constants fails a test.
const requiredKeywords = [
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'UPSERT', 'CREATE', 'DROP', 'ALTER', 'TRUNCATE', 'ATTACH', 'DETACH',
  'COPY', 'EXPORT', 'IMPORT', 'INSTALL', 'LOAD', 'SET', 'RESET', 'PRAGMA', 'CALL', 'USE', 'CHECKPOINT', 'VACUUM',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'TRANSACTION', 'PREPARE', 'EXECUTE', 'DEALLOCATE'
];
const requiredNames = [
  'glob', 'query', 'query_table', 'sniff_csv', 'st_read', 'st_read_meta', 'st_readosm', 'st_drivers', 'load_extension',
  'getenv', 'st_transform', 'json_execute_serialized_sql', 'json_serialize_sql', 'json_deserialize_sql', 'enable_logging',
  'disable_logging', 'truncate_duckdb_logs', 'checkpoint', 'force_checkpoint', 'arrow_scan_dumb', 'which_secret',
  'sql_auto_complete', 'check_peg_parser', 'test_all_types', 'test_vector_types'
];
const requiredPrefixes = ['read_', 'parquet_', 'duckdb_', 'iceberg_', 'delta_', 'pragma_', 'st_read'];
const requiredSuffixes = ['_scan', '_query', '_sql'];

describe('forbidden lists', () => {
  it('pin the keywords (REPLACE is checked after OR)', () => {
    expect([...forbiddenKeywords].sort()).toEqual([...requiredKeywords].sort());
  });

  it('pin the function names', () => {
    expect([...forbiddenFunctionNames].sort()).toEqual([...requiredNames].sort());
  });

  it('pin the prefixes and suffixes', () => {
    expect([...forbiddenFunctionAffixes.prefixes].sort()).toEqual([...requiredPrefixes].sort());
    expect([...forbiddenFunctionAffixes.suffixes].sort()).toEqual([...requiredSuffixes].sort());
  });
});


// The allow list written out, so adding or removing a name fails a test (the names are checked against DuckDB in `scripts/sql/sql-functions.test.ts`).
const expected_aggregateFunctions = ['count', 'sum', 'avg', 'mean', 'min', 'max', 'median', 'mode', 'quantile_cont', 'quantile_disc', 'stddev', 'stddev_samp', 'stddev_pop', 'variance', 'var_samp', 'var_pop', 'string_agg', 'list', 'array_agg', 'first', 'last', 'any_value', 'arg_max', 'arg_min', 'bool_and', 'bool_or', 'count_if', 'corr', 'covar_pop', 'covar_samp', 'regr_slope', 'regr_intercept', 'regr_r2'];
const expected_windowFunctions = ['row_number', 'rank', 'dense_rank', 'ntile', 'percent_rank', 'cume_dist', 'lag', 'lead', 'first_value', 'last_value', 'nth_value'];
const expected_mathFunctions = ['abs', 'round', 'floor', 'ceil', 'ceiling', 'trunc', 'sqrt', 'cbrt', 'power', 'pow', 'exp', 'ln', 'log', 'log10', 'log2', 'mod', 'sign', 'greatest', 'least', 'pi', 'radians', 'degrees', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'isnan', 'isinf', 'isfinite'];
const expected_conditionalFunctions = ['coalesce', 'nullif', 'ifnull', 'if', 'typeof'];
const expected_textFunctions = ['length', 'lower', 'upper', 'trim', 'ltrim', 'rtrim', 'substring', 'substr', 'left', 'right', 'replace', 'concat', 'concat_ws', 'contains', 'starts_with', 'ends_with', 'prefix', 'suffix', 'strpos', 'instr', 'split_part', 'lpad', 'rpad', 'reverse', 'regexp_matches', 'regexp_replace', 'regexp_extract', 'format', 'printf', 'md5'];
const expected_dateTimeFunctions = ['date_part', 'date_trunc', 'date_diff', 'datediff', 'date_add', 'strftime', 'strptime', 'year', 'month', 'day', 'make_date', 'epoch'];
const expected_listFunctions = ['list_value', 'list_extract', 'list_contains', 'len', 'array_length', 'list_sort', 'list_distinct'];
const expected_tableFunctions = ['range', 'generate_series', 'unnest'];
const expected_spatialFunctions = ['st_point', 'st_x', 'st_y', 'st_xmin', 'st_xmax', 'st_ymin', 'st_ymax', 'st_area', 'st_area_spheroid', 'st_length', 'st_length_spheroid', 'st_perimeter', 'st_distance', 'st_distance_sphere', 'st_distance_spheroid', 'st_dwithin', 'st_dwithin_spheroid', 'st_intersects', 'st_contains', 'st_within', 'st_covers', 'st_coveredby', 'st_touches', 'st_overlaps', 'st_crosses', 'st_disjoint', 'st_equals', 'st_intersection', 'st_difference', 'st_union', 'st_union_agg', 'st_collect', 'st_envelope', 'st_envelope_agg', 'st_extent', 'st_extent_agg', 'st_centroid', 'st_pointonsurface', 'st_buffer', 'st_simplify', 'st_simplifypreservetopology', 'st_convexhull', 'st_isvalid', 'st_makevalid', 'st_geometrytype', 'st_npoints', 'st_numgeometries', 'st_astext', 'st_aswkb', 'st_geomfromtext', 'st_geomfromwkb', 'st_geomfromgeojson', 'st_asgeojson', 'st_flipcoordinates', 'st_hilbert', 'st_makeenvelope'];
const expected_parenthesisKeywords = ['in', 'exists', 'as', 'over', 'filter', 'within', 'values', 'using', 'on', 'and', 'or', 'not', 'from', 'join', 'where', 'then', 'else', 'when', 'case', 'between', 'any', 'all', 'some', 'lateral', 'cast', 'try_cast', 'extract', 'interval', 'with', 'by', 'having', 'union', 'intersect', 'except', 'distinct', 'is', 'like', 'ilike', 'select', 'group', 'order', 'limit', 'offset', 'qualify', 'materialized', 'recursive', 'row', 'struct_pack', 'decimal', 'numeric', 'varchar', 'char', 'columns', 'exclude', 'rename'];

describe('allow list is pinned', () => {
  const groups: [string, readonly string[], readonly string[]][] = [
    ['aggregateFunctions', aggregateFunctions, expected_aggregateFunctions],
    ['windowFunctions', windowFunctions, expected_windowFunctions],
    ['mathFunctions', mathFunctions, expected_mathFunctions],
    ['conditionalFunctions', conditionalFunctions, expected_conditionalFunctions],
    ['textFunctions', textFunctions, expected_textFunctions],
    ['dateTimeFunctions', dateTimeFunctions, expected_dateTimeFunctions],
    ['listFunctions', listFunctions, expected_listFunctions],
    ['tableFunctions', tableFunctions, expected_tableFunctions],
    ['spatialFunctions', spatialFunctions, expected_spatialFunctions],
    ['parenthesisKeywords', parenthesisKeywords, expected_parenthesisKeywords],
  ];

  it.each(groups)('%s lists exactly the expected names', (_name, actual, expected) => {
    expect([...actual].sort()).toEqual([...expected].sort());
  });

  it('allowedFunctions is every group except the keywords', () => {
    const expected = groups.filter(([name]) => name !== 'parenthesisKeywords').flatMap(([, , names]) => names);
    expect([...allowedFunctions].sort()).toEqual([...expected].sort());
  });
});

describe('allow list', () => {
  const callable = [...allowedFunctions, ...parenthesisKeywords];

  it('has lower-case names without duplicates', () => {
    expect(callable.map((name) => name.toLowerCase())).toEqual(callable);
    expect(new Set(callable).size).toBe(callable.length);
  });

  it('shares no name with the forbidden lists', () => {
    const upperKeywords = new Set(forbiddenKeywords);
    for (const name of callable) {
      expect(forbiddenFunctionNames, name).not.toContain(name);
      expect(upperKeywords.has(name.toUpperCase()), name).toBe(false);
      expect(
        forbiddenFunctionAffixes.prefixes.some((prefix) => name.startsWith(prefix)) ||
          forbiddenFunctionAffixes.suffixes.some((suffix) => name.endsWith(suffix)),
        name
      ).toBe(false);
    }
  });

  it('accepts a call of every allowed function', () => {
    for (const name of allowedFunctions) {
      const result = validateSql(`SELECT ${name}(1)`, datasetIds);
      expect(result.ok, `${name}: ${result.ok ? '' : result.reason}`).toBe(true);
    }
  });
});

describe('validateSql: forbidden keywords', () => {
  it.each(requiredKeywords)('rejects %s and names it', (keyword) => {
    expect(rejectionReason(`SELECT 1 ${keyword} x`)).toBe(`The keyword ${keyword} is not allowed.`);
    expect(rejectionReason(`select 1 ${keyword.toLowerCase()} x`)).toBe(`The keyword ${keyword} is not allowed.`);
  });

  it('rejects the keyword inside a CTE and after a comment', () => {
    expect(rejectionReason('WITH a AS (SELECT 1) /* x */ DELETE FROM a')).toContain('DELETE');
  });

  it('rejects OR REPLACE, also split by a comment or new lines', () => {
    expect(rejectionReason('SELECT 1 OR REPLACE x')).toBe('The keyword OR REPLACE is not allowed.');
    expect(rejectionReason('SELECT 1 or /* c */ replace\nx')).toBe('The keyword OR REPLACE is not allowed.');
  });

  it('rejects statements that start with a forbidden keyword as not starting with SELECT or WITH', () => {
    expect(rejectionReason('CREATE OR REPLACE VIEW v AS SELECT 1')).toContain('must start with SELECT or WITH');
  });
});

describe('validateSql: statement shape', () => {
  const denied: { name: string; sql: string; reason: string }[] = [
    { name: 'two statements', sql: 'SELECT 1; SELECT 2', reason: 'Only one SELECT or WITH statement is allowed.' },
    { name: 'semicolon, comment, then code', sql: 'SELECT 1; -- c\nSELECT 2', reason: 'Only one' },
    { name: 'two semicolons', sql: 'SELECT 1;; ', reason: 'Only one' },
    { name: 'semicolon first', sql: ';SELECT 1', reason: 'Only one' },
    { name: 'EXPLAIN', sql: 'EXPLAIN SELECT 1', reason: 'must start with SELECT or WITH' },
    { name: 'DESCRIBE', sql: 'DESCRIBE stations', reason: 'must start with SELECT or WITH' },
    { name: 'SUMMARIZE', sql: 'SUMMARIZE stations', reason: 'must start with SELECT or WITH' },
    { name: 'SHOW', sql: 'SHOW TABLES', reason: 'must start with SELECT or WITH' },
    { name: 'PIVOT', sql: 'PIVOT stations ON x USING sum(y)', reason: 'must start with SELECT or WITH' },
    { name: 'FROM-first syntax', sql: 'FROM stations SELECT *', reason: 'must start with SELECT or WITH' },
    { name: 'parenthesised select', sql: '(SELECT 1)', reason: 'must start with SELECT or WITH' },
    { name: 'only a comment', sql: '-- SELECT 1', reason: 'must start with SELECT or WITH' },
    { name: 'only a semicolon', sql: ';', reason: 'must start with SELECT or WITH' }
  ];

  it.each(denied)('rejects $name', ({ sql, reason }) => {
    expect(rejectionReason(sql)).toContain(reason);
  });
});

describe('validateSql: parentheses', () => {
  const unbalanced = [
    'SELECT pref_name, geom FROM prefectures) AS q, (SELECT 1 AS one',
    'SELECT (1',
    'SELECT 1)',
    'SELECT ((1)',
    'SELECT 1 FROM (SELECT 2))'
  ];

  it.each(unbalanced)('rejects %s', (sql) => {
    expect(rejectionReason(sql)).toBe('Parentheses are not balanced.');
  });

  it('accepts balanced nesting, and parentheses inside strings and quoted names', () => {
    expect(validateSql("SELECT ((1 + 2) * (3)) AS x FROM (SELECT 1) AS a, (SELECT (2)) AS b", datasetIds).ok).toBe(true);
    expect(validateSql("SELECT ')' AS a, '(' AS b, 1 AS \"c)\"", datasetIds).ok).toBe(true);
  });
});

describe('validateSql: forbidden function names (second layer)', () => {
  const prefixExamples = forbiddenFunctionAffixes.prefixes.map((prefix) => `${prefix}something`);
  const suffixExamples = forbiddenFunctionAffixes.suffixes.map((suffix) => `something${suffix}`);
  const names = [...requiredNames, ...prefixExamples, ...suffixExamples, 'read_csv', 'read_parquet', 'read_text', 'sqlite_scan', 'st_readshp'];

  it.each(names)('rejects %s as a plain and as a quoted identifier, in any case', (name) => {
    for (const sql of [
      `SELECT * FROM ${name}()`,
      `SELECT * FROM ${name.toUpperCase()}()`,
      `SELECT * FROM "${name}"()`,
      `SELECT * FROM "${name.toUpperCase()}"()`,
      `SELECT x.${name}() FROM stations x`,
      `SELECT 1 AS ${name}`
    ]) {
      const reason = rejectionReason(sql);
      // CHECKPOINT is also a keyword, which is checked first.
      expect(reason).toMatch(/^The (function or name .+ is not allowed; use the views and the allowed functions\.|keyword CHECKPOINT is not allowed\.)$/);
      expect(reason).not.toContain('SELECT');
    }
  });

  it('names the exact function for an exact match', () => {
    expect(rejectionReason("SELECT * FROM st_read('x')")).toContain('The function or name st_read is');
    expect(rejectionReason('SELECT * FROM json_execute_serialized_sql()')).toContain('The function or name json_execute_serialized_sql is');
  });

  it('names the pattern for a prefix or suffix match', () => {
    expect(rejectionReason('SELECT * FROM read_csv()')).toContain('The function or name read_... is');
    expect(rejectionReason('SELECT * FROM sqlite_scan()')).toContain('The function or name ..._scan is');
  });

  it('rejects read_parquet inside a CTE', () => {
    expect(rejectionReason("WITH a AS (SELECT * FROM read_parquet('x')) SELECT * FROM a")).toContain('read_');
  });

  it('decodes a doubled quote inside a quoted identifier before the check', () => {
    expect(rejectionReason('SELECT * FROM "read_csv""x"')).toContain('read_');
  });
});

function notAllowed(name: string): string {
  return `The function or name ${name} is not allowed; use the views and the allowed functions.`;
}

describe('validateSql: calls must be in the allow list', () => {
  const notAllowedNames = ['json_each', 'json_tree', 'summary', 'histogram', 'pg_timezone_names', 'repeat', 'icu_calendar_names', 'current_setting'];

  it.each(notAllowedNames)('rejects a call of %s, plain, after a dot and in a subquery', (name) => {
    expect(rejectionReason(`SELECT * FROM ${name}()`)).toBe(notAllowed(name));
    expect(rejectionReason(`SELECT x.${name}() FROM stations x`)).toBe(notAllowed(name));
    expect(rejectionReason(`SELECT * FROM (SELECT ${name.toUpperCase()}(1)) t`)).toBe(notAllowed(name.toUpperCase()));
  });

  it('does not reject the same word when it is not a call', () => {
    expect(validateSql('SELECT 1 AS summary, 2 AS histogram FROM stations', datasetIds).ok).toBe(true);
  });

  it('sees a call across white space and comments', () => {
    expect(rejectionReason('SELECT json_each /* c */ (1)')).toContain('json_each');
    expect(rejectionReason('SELECT json_each\n  (1)')).toContain('json_each');
  });

  it('rejects a quoted function name', () => {
    expect(rejectionReason('SELECT "count"(*) FROM stations')).toBe('Quoted function names are not allowed.');
    expect(rejectionReason('SELECT * FROM "stations" ("a")')).toBe('Quoted function names are not allowed.');
  });

  it('cuts a long function name to 64 characters', () => {
    const name = 'a'.repeat(100);
    expect(rejectionReason(`SELECT ${name}(1)`)).toBe(notAllowed('a'.repeat(64)));
  });
});

describe('validateSql: literals and quoted identifiers that point at data', () => {
  const reason = 'String literals and quoted names may not contain paths, URLs or file names.';
  const denied: { name: string; sql: string }[] = [
    { name: 'FROM a csv file', sql: "SELECT * FROM 'data.csv'" },
    { name: 'FROM a quoted parquet file', sql: 'SELECT * FROM "data.parquet"' },
    { name: 'https URL', sql: "SELECT * FROM 'https://example.com/a'" },
    { name: 's3 URL', sql: "SELECT * FROM 's3://bucket/key'" },
    { name: 'absolute path', sql: "SELECT * FROM '/etc/passwd'" },
    { name: 'relative path', sql: "SELECT * FROM '../x/secret'" },
    { name: 'home path', sql: "SELECT * FROM '~x'" },
    { name: 'home path after a space', sql: "SELECT * FROM ' ~x'" },
    { name: 'Windows drive path', sql: "SELECT * FROM 'C:\\x'" },
    { name: 'compressed file', sql: "SELECT * FROM 'x.csv.gz'" },
    { name: 'file name with a query string', sql: "SELECT * FROM 'x.csv?v=1'" },
    { name: 'quoted file name with a query string', sql: 'SELECT * FROM "x.json?v=1"' },
    { name: 'question mark alone', sql: "SELECT 'what?'" },
    { name: 'unknown extension', sql: "SELECT * FROM 'x.geojsonseq'" },
    { name: 'E string with a URL', sql: "SELECT * FROM E'http://x'" },
    { name: 'E string with an escaped quote and a file', sql: "SELECT * FROM E'it\\'s.csv'" },
    { name: 'quoted identifier with a URL', sql: 'SELECT * FROM "https://x"' },
    { name: 'URL in the select list', sql: "SELECT 'ftp://x' AS u" },
    { name: 'dot and a letter anywhere', sql: "SELECT 'a.b' AS x" }
  ];

  it.each(denied)('rejects $name', ({ sql }) => {
    expect(rejectionReason(sql)).toBe(reason);
  });

  it('rejects an E string with an escape sequence that could hide a path', () => {
    expect(rejectionReason("SELECT E'\\x2fetc'")).toContain('Escape sequences');
    expect(rejectionReason("SELECT E'\\u002fetc'")).toContain('Escape sequences');
    expect(rejectionReason("SELECT E'\\057etc'")).toContain('Escape sequences');
  });

  it('treats an E string new-line escape as a space', () => {
    expect(rejectionReason("SELECT * FROM E'~\\n'")).toBe(reason);
    expect(validateSql("SELECT E'a\\nb'", datasetIds).ok).toBe(true);
  });

  it('allows ordinary literals', () => {
    expect(validateSql("SELECT 'csv' AS y, 'file' AS z, 'a. b' AS w, 3.5 AS n, '2020-01-01' AS d", datasetIds).ok).toBe(true);
  });

  it('rejects two adjacent string literals (DuckDB joins them)', () => {
    const message = 'Adjacent string literals are not allowed.';
    expect(rejectionReason("SELECT * FROM 't'\n'v'")).toBe(message);
    expect(rejectionReason("SELECT * FROM 'a' -- c\n'b'")).toBe(message);
    expect(rejectionReason("SELECT 'a' /* c */ 'b'")).toBe(message);
    expect(rejectionReason("SELECT E'a' 'b'")).toBe(message);
  });

  it('allows string literals separated by a comma or an operator', () => {
    expect(validateSql("SELECT 'a', 'b', 'a' || 'b'", datasetIds).ok).toBe(true);
  });
});

describe('validateSql: lexing errors', () => {
  const denied: { name: string; sql: string; reason: string }[] = [
    { name: 'unterminated literal', sql: "SELECT 'abc", reason: 'string literal that is not closed' },
    { name: 'literal ending in a doubled quote only', sql: "SELECT 'abc''", reason: 'string literal that is not closed' },
    { name: 'unterminated E string', sql: "SELECT E'abc\\'", reason: 'string literal that is not closed' },
    { name: 'E string ending with a backslash', sql: "SELECT E'abc\\", reason: 'string literal that is not closed' },
    { name: 'unterminated quoted identifier', sql: 'SELECT "abc', reason: 'quoted identifier that is not closed' },
    { name: 'unterminated block comment', sql: 'SELECT 1 /* abc', reason: 'comment that is not closed' },
    { name: 'unterminated nested block comment', sql: 'SELECT 1 /* a /* b */ c', reason: 'comment that is not closed' },
    { name: 'slash star slash is not a closed comment', sql: 'SELECT 1 /*/', reason: 'comment that is not closed' }
  ];

  it.each(denied)('rejects $name', ({ sql, reason }) => {
    expect(rejectionReason(sql)).toContain(reason);
  });

  it('does not let an unclosed line comment hide the rest of the file', () => {
    expect(validateSql('SELECT 1 -- x', datasetIds).ok).toBe(true);
  });
});

describe('validateSql: dollar signs', () => {
  const message = 'Dollar signs are not allowed; use single-quoted strings.';

  it.each([
    ['dollar-quoted string', 'SELECT $$x$$'],
    ['tagged dollar-quoted string', 'SELECT $t$ x $t$ AS y'],
    ['positional parameter', 'SELECT $1'],
    ['lone dollar', 'SELECT $'],
    ['dollar in an identifier', 'SELECT 1 AS a$b'],
    ['dollar in a number-like word', 'SELECT 1$x']
  ])('rejects a %s', (_name, sql) => {
    expect(rejectionReason(sql)).toBe(message);
  });

  it('allows a dollar sign inside a literal, a quoted identifier and a comment', () => {
    expect(validateSql('SELECT \'$$\' AS "a$$" -- $$', datasetIds).ok).toBe(true);
  });
});

describe('validateSql: ST_Transform is not allowed', () => {
  it('rejects ST_Transform (the data is lon/lat; use the _spheroid functions)', () => {
    expect(rejectionReason(`SELECT ST_Transform(${geom}, 'EPSG:4326', 'EPSG:3857') FROM stations`)).toBe(notAllowed('st_transform'));
  });
});

describe('validateSql: white space and numbers', () => {
  it.each([
    ['U+200B', '\u200b'],
    ['U+2060', '\u2060'],
    ['U+FEFF', '\ufeff'],
    ['U+00A0', '\u00a0'],
    ['U+3000', '\u3000'],
    ['U+2028', '\u2028'],
    ['U+2029', '\u2029'],
    ['U+1680', '\u1680']
  ])('rejects %s between FROM and a view name', (_name, space) => {
    expect(rejectionReason(`SELECT * FROM${space}stations`)).toBe('Only ASCII white space is allowed between words.');
  });

  it('rejects such a character inside a word, but allows it in a literal, a quoted name and a comment', () => {
    expect(rejectionReason('SELECT 1 AS a\u200bb')).toContain('ASCII white space');
    expect(validateSql("SELECT '\u3000' AS \"a\u200b\" -- \u00a0", datasetIds).ok).toBe(true);
  });

  it.each(['SELECT 1json_each(1)', 'SELECT 1abc', 'SELECT 1_a', 'SELECT 1e', 'SELECT 1.5x', 'SELECT 1é'])('rejects a number followed by a name: %s', (sql) => {
    expect(rejectionReason(sql)).toBe('A number may not be followed directly by a name.');
  });

  it('lexes a non-ASCII word with its trailing E as one word (not an E string)', () => {
    // `€E` is one identifier, so `'a\\'` is a plain string whose backslash is rejected as a path; an E string would be unterminated.
    expect(rejectionReason("SELECT 1 AS €E'a\\'")).toBe('String literals and quoted names may not contain paths, URLs or file names.');
    expect(rejectionReason("SELECT 1 AS é1E'a\\'")).toBe('String literals and quoted names may not contain paths, URLs or file names.');
  });
});

describe('validateSql: bypasses found in review r0 (fake paths)', () => {
  const file = "'/tmp/x/secret.txt'";
  const bypasses: { name: string; sql: string }[] = [
    { name: 'dollar after an ASCII word hides code', sql: `SELECT 1 AS a$$, (SELECT content FROM read_text(${file})) AS b$$` },
    { name: 'dollar after a word hides a second statement', sql: "SELECT 1 AS a$$; COPY (SELECT 42) TO '/tmp/x/out1.csv'; SELECT 1 AS b$$" },
    { name: 'dollar after a non-ASCII word hides code', sql: `SELECT 1 AS €$$, (SELECT content FROM read_text(${file})) AS €$$` },
    { name: 'non-ASCII dollar tag hides code', sql: `SELECT $é$'$é$ AS x, (SELECT content FROM read_text($p$/tmp/x/secret.txt$p$)) AS y, $é$'$é$ AS z` },
    { name: 'dynamic SQL through json_execute_serialized_sql', sql: `SELECT * FROM json_execute_serialized_sql('{"error":false,"statements":[]}')` },
    { name: 'enable_logging writes files', sql: "SELECT * FROM enable_logging(storage = 'file', storage_path = '../x/logs')" },
    { name: 'disable_logging', sql: 'SELECT * FROM disable_logging()' },
    { name: 'truncate_duckdb_logs', sql: 'SELECT * FROM truncate_duckdb_logs()' },
    { name: 'quoted checkpoint', sql: 'SELECT * FROM "checkpoint"()' },
    { name: 'file name with a query string (single quotes)', sql: "SELECT * FROM '../x/t.csv?x'" },
    { name: 'file name with a query string (double quotes)', sql: 'SELECT * FROM "../x/t.json?x"' },
    { name: 'string continuation across a new line', sql: "SELECT * FROM '../x/t.cs'\n'v'" },
    { name: 'string continuation across a comment', sql: "SELECT * FROM '../x/t.cs' -- c\n'v'" },
    { name: 'line comment ended by a carriage return', sql: `SELECT 1 AS a --x\r, (SELECT content FROM read_text(${file})) AS b` },
    { name: 'nested block comment opens a literal', sql: `SELECT 1 AS a /* /* */ '*/, (SELECT content FROM read_text($$/tmp/x/secret.txt$$)) AS b --'` }
  ];

  it.each(bypasses)('rejects $name', ({ sql }) => {
    expect(validateSql(sql, datasetIds).ok).toBe(false);
  });
});

describe('validateSql: length and empty input', () => {
  it('rejects empty and white-space-only SQL', () => {
    expect(rejectionReason('')).toBe('The SQL is empty.');
    expect(rejectionReason(' \n\t ')).toBe('The SQL is empty.');
  });

  it('accepts exactly the maximum length and rejects one more', () => {
    const base = 'SELECT 1 AS x';
    const atLimit = `${base}${' '.repeat(queryConfig.maxSqlChars - base.length)}`;
    expect(atLimit).toHaveLength(queryConfig.maxSqlChars);
    expect(validateSql(atLimit, datasetIds).ok).toBe(true);
    const reason = rejectionReason(`${atLimit} `);
    expect(reason).toBe(`The SQL is longer than ${queryConfig.maxSqlChars} characters.`);
  });

  it('never echoes the SQL in a reason', () => {
    const secret = 'zzzsecretzzz';
    expect(rejectionReason(`SELECT '${secret}' FROM 'x.csv'`)).not.toContain(secret);
    expect(rejectionReason(`SELECT 1 AS "${secret}" DROP`)).not.toContain(secret);
  });
});
