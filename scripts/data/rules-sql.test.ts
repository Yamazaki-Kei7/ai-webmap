import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { queryRows } from './convert-io.js';
import { sqlIdent, sqlString } from './convert-plan.js';
import { landPriceRules, placeConfig, stationRules, type DatasetConfig } from './datasets.config.js';
import {
  buildUnknownCodesSql,
  changeRateSql,
  chosenCodeSql,
  codeMethodSql,
  labelSql,
  locatedColumns,
  outputColumnSql,
  passengersSql,
  stationKeptSql,
  unknownCodeError
} from './rules-sql.js';
import { evaluate, openMemoryDatabase } from './sql-test-support.js';

const labels = { '1': '国', '2': '都道府県' };

describe('label expansion', () => {
  it('turns a code into its label, and an unlisted code into NULL', async () => {
    const rows = [[sqlString('1')], [sqlString('2')], [sqlString('9')], ['NULL']];
    expect(await evaluate(['code'], rows, labelSql(sqlIdent('code'), labels))).toEqual(['国', '都道府県', 'NULL', 'NULL']);
  });

  it('keeps a quote in a label intact', async () => {
    expect(await evaluate(['code'], [[sqlString('1')]], labelSql(sqlIdent('code'), { '1': "O'Hara" }))).toEqual(["O'Hara"]);
  });
});

describe('unknown codes', () => {
  async function unknownIn(values: string[]): Promise<(string | null)[]> {
    const connection = await openMemoryDatabase();
    await connection.run('CREATE TABLE t (code VARCHAR)');
    for (const value of values) await connection.run(`INSERT INTO t VALUES (${value})`);
    const rows = await queryRows(connection, buildUnknownCodesSql('t', 'code', labels), z.object({ code: z.string().nullable() }));
    return rows.map((row) => row.code);
  }

  it('finds each code that has no label once', async () => {
    expect(await unknownIn([sqlString('1'), sqlString('7'), sqlString('7'), sqlString('2'), sqlString('8')])).toEqual(['7', '8']);
  });

  it('counts a NULL code as unknown (no label column may be NULL)', async () => {
    expect(await unknownIn([sqlString('1'), 'NULL'])).toEqual([null]);
  });

  it('finds nothing when every code has a label', async () => {
    expect(await unknownIn([sqlString('1'), sqlString('2')])).toEqual([]);
  });

  it('names the dataset, the column and the code in the message, and says nothing when there is no unknown code', () => {
    const message = unknownCodeError('schools', 'school_type', ['16099', null]);
    expect(message).toContain('schools');
    expect(message).toContain('school_type');
    expect(message).toContain("'16099'");
    expect(message).toContain('NULL');
    expect(unknownCodeError('schools', 'school_type', [])).toBeUndefined();
  });
});

describe('land price change rate (selection status)', () => {
  const rows = [
    ['3.1', '1'], // continued
    ['0.0', '1'], // a real 0.0 stays
    ['-2.5', '2'], // changed standard-site number
    ['0.0', '4'], // added this year
    ['0.0', '5'], // suspended
    ['1.5', '5'], // any value of a suspended point is dropped
    ['NULL', '1'] // no value stays NULL
  ];

  it('is NULL for the new and suspended points and the source value otherwise', async () => {
    expect(await evaluate(['rate', 'status'], rows, changeRateSql('rate', 'status', landPriceRules))).toEqual(['3.1', '0.0', '-2.5', 'NULL', 'NULL', 'NULL', 'NULL']);
  });
});

describe('station passengers (duplicate code, existence code)', () => {
  // value, duplicate, existence
  const rows = [
    ['1770430', '1', '1'], // this line's row, data present
    ['0', '1', '1'], // a real 0
    ['0', '1', '2'], // no data
    ['0', '1', '3'], // not disclosed
    ['0', '2', '1'], // recorded on another line's row
    ['500', '2', '1'], // another line's row, even with a number
    ['0', '3', '4'], // no station
    ['NULL', '1', '1']
  ];

  it('keeps the number only where it is this line row and the data exists; a real 0 stays 0', async () => {
    expect(await evaluate(['value', 'dup', 'ex'], rows, passengersSql('value', 'dup', 'ex', stationRules))).toEqual([
      '1770430', '0', 'NULL', 'NULL', 'NULL', 'NULL', 'NULL', 'NULL'
    ]);
  });

  it('drops the rows that say no station and keeps the others, including an unknown code', async () => {
    const existence = [['1'], ['2'], ['3'], ['4'], ['NULL']];
    expect(await evaluate(['ex'], existence, stationKeptSql('ex', stationRules))).toEqual(['true', 'true', 'true', 'false', 'true']);
  });
});

describe('the municipality code of a point', () => {
  const known = `SELECT * FROM (VALUES ('13101'), ('13102'), ('22138')) AS k(code)`;
  const limit = placeConfig.nearest.limitMeters;
  const { sourceCode, containingCode, nearestCode, nearestMeters } = locatedColumns;
  const columns = [sourceCode, containingCode, nearestCode, nearestMeters];
  const text = (value: string | undefined): string => (value === undefined ? 'NULL' : sqlString(value));
  const point = (source?: string, containing?: string, nearest?: string, meters?: number): string[] => [
    text(source),
    text(containing),
    text(nearest),
    meters === undefined ? 'NULL' : String(meters)
  ];

  const cases: { name: string; row: string[]; code: string; method: string }[] = [
    { name: 'the source code, when it is a code of municipalities', row: point('13101', '13102', '22138', 5), code: '13101', method: placeConfig.methods.source },
    { name: 'the containing polygon, when the source code is not in municipalities (a former ward)', row: point('22131', '22138'), code: '22138', method: placeConfig.methods.containing },
    { name: 'the containing polygon, when the point has no source code at all (a station)', row: point(undefined, '13102', '13101', 40), code: '13102', method: placeConfig.methods.containing },
    { name: 'the nearest polygon, when none contains the point and it is within the limit', row: point(undefined, undefined, '13101', 300), code: '13101', method: placeConfig.methods.nearest },
    { name: 'the nearest polygon at exactly the limit', row: point(undefined, undefined, '13101', limit), code: '13101', method: placeConfig.methods.nearest },
    { name: 'NULL beyond the limit', row: point(undefined, undefined, '13101', limit + 0.5), code: 'NULL', method: 'NULL' },
    { name: 'NULL when there is no polygon in reach', row: point(undefined, undefined), code: 'NULL', method: 'NULL' },
    { name: 'NULL when the unknown source code has neither a containing nor a near polygon (a code that joins to nothing is never kept)', row: point('99999', undefined, undefined), code: 'NULL', method: 'NULL' },
    { name: 'the nearest polygon for an unknown source code outside every polygon', row: point('99999', undefined, '22138', 10), code: '22138', method: placeConfig.methods.nearest }
  ];

  it.each(cases)('gives $name', async ({ row, code, method }) => {
    expect(await evaluate(columns, [row], chosenCodeSql(known, limit))).toEqual([code]);
    expect(await evaluate(columns, [row], codeMethodSql(known, limit))).toEqual([method]);
  });
});

describe('the type of an output column', () => {
  async function typeOf(column: DatasetConfig['columns'][number], overrides: Record<string, (source: string) => string>): Promise<string> {
    const connection = await openMemoryDatabase();
    await connection.run(`CREATE TABLE t (src VARCHAR)`);
    await connection.run(`INSERT INTO t VALUES ('7')`);
    const sql = `SELECT typeof(${sqlIdent(column.name)}) AS type FROM (SELECT ${outputColumnSql({ id: 'x', input: 'x', columns: [column] }, column, 'r', overrides)} FROM t r)`;
    const [row] = await queryRows(connection, sql, z.object({ type: z.string() }));
    return row?.type ?? '';
  }

  it('comes out with the configured type, with a plain source and with a rule', async () => {
    expect(await typeOf({ name: 'n', source: 'src', type: 'INTEGER' }, {})).toBe('INTEGER');
    expect(await typeOf({ name: 'n', source: 'src', type: 'DOUBLE' }, { n: (source) => `CASE WHEN ${source} = '7' THEN ${source} END` })).toBe('DOUBLE');
  });

  it('keeps the source type when none is configured', async () => {
    expect(await typeOf({ name: 'n', source: 'src' }, {})).toBe('VARCHAR');
  });
});
