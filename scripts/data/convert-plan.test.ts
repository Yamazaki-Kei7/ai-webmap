import { DuckDBInstance } from '@duckdb/node-api';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  assignedMapshaperExpression,
  buildMapshaperArgs,
  buildPartContactsSql,
  buildPartFlagsSql,
  tables,
  formatSummaryLine,
  missingRawFileMessage,
  muniNameSql,
  prefCodeSql,
  rowCountError,
  sqlIdent,
  sqlString,
  unassignedByNameSql,
  unassignedDisagreementSql,
  unassignedCheckError,
  unassignedSql
} from './convert-plan.js';
import { adminAreaConfig, conversionConfig } from './datasets.config.js';
import { evaluate } from './sql-test-support.js';

const { citySource, wardSource, codeSource } = adminAreaConfig;

describe('SQL quoting', () => {
  it('doubles the quote characters', () => {
    expect(sqlString("a'b")).toBe("'a''b'");
    expect(sqlIdent('a"b')).toBe('"a""b"');
  });
});

describe('unassigned areas', () => {
  it('selects the codes that end in 000, and the city name 所属未定地, in SQL', async () => {
    const rows = [
      [sqlString('13000'), sqlString('所属未定地')],
      [sqlString('13101'), sqlString('千代田区')],
      [sqlString('01100'), sqlString('札幌市')],
      [sqlString('46000'), sqlString('所属未定地')]
    ];
    const columns = [codeSource, citySource];
    expect(await evaluate(columns, rows, unassignedSql(adminAreaConfig))).toEqual(['true', 'false', 'false', 'true']);
    expect(await evaluate(columns, rows, unassignedByNameSql(adminAreaConfig))).toEqual(['true', 'false', 'false', 'true']);
  });

  it('gives the same condition to mapshaper as a JavaScript expression that keeps the assigned rows', () => {
    expect(assignedMapshaperExpression(adminAreaConfig)).toBe('!N03_007.endsWith("000")');
  });
});

describe('attribute expressions', () => {
  it('builds muni_name: the city, followed by the ward when there is one', async () => {
    const rows = [
      [sqlString('札幌市'), sqlString('中央区')],
      [sqlString('千代田区'), 'NULL'],
      [sqlString('小笠原村'), 'NULL']
    ];
    expect(await evaluate([citySource, wardSource], rows, muniNameSql(adminAreaConfig))).toEqual(['札幌市中央区', '千代田区', '小笠原村']);
  });

  it('derives the prefecture code from the first two digits of the municipality code', async () => {
    const rows = [[sqlString('01101')], [sqlString('13421')], [sqlString('47382')]];
    expect(await evaluate(['muni_code'], rows, prefCodeSql(sqlIdent('muni_code'), adminAreaConfig))).toEqual(['01', '13', '47']);
  });
});

describe('buildMapshaperArgs', () => {
  const args = buildMapshaperArgs('in dir/N03 x.shp', "out'dir/o.geojson", conversionConfig, adminAreaConfig);

  it('starts with the heap size of the launcher, then the input with snapping right after it', () => {
    expect(args.slice(0, 4)).toEqual([`${conversionConfig.mapshaper.heapGb}gb`, '-i', 'in dir/N03 x.shp', 'snap']);
  });

  it('leaves the snapping out when it is switched off', () => {
    const off = buildMapshaperArgs('in.shp', 'out.geojson', { ...conversionConfig, mapshaper: { ...conversionConfig.mapshaper, snap: false } }, adminAreaConfig);
    expect(off).not.toContain('snap');
  });

  it('simplifies before it dissolves, and writes GeoJSON to the given path', () => {
    const simplify = args.indexOf('-simplify');
    const dissolve = args.indexOf('-dissolve');
    expect(simplify).toBeGreaterThan(0);
    expect(dissolve).toBeGreaterThan(simplify);
    expect(args.slice(-3)).toEqual(['-o', "out'dir/o.geojson", 'format=geojson']);
  });

  it('keeps the unassigned-area filter before the simplification', () => {
    expect(args.indexOf('-filter')).toBeLessThan(args.indexOf('-simplify'));
    expect(args[args.indexOf('-filter') + 1]).toBe(assignedMapshaperExpression(adminAreaConfig));
  });

  it('passes paths as single arguments untouched (no shell quoting)', () => {
    expect(args).toContain('in dir/N03 x.shp');
    expect(args).toContain("out'dir/o.geojson");
  });
});

describe('unassigned conditions disagreement', () => {
  it('counts a NULL on one side as a disagreement, and agreeing rows as none', async () => {
    const rows = [
      [sqlString('13000'), sqlString('所属未定地')], // agree: unassigned
      [sqlString('13101'), sqlString('千代田区')], // agree: assigned
      [sqlString('13000'), sqlString('千代田区')], // disagree
      [sqlString('13101'), sqlString('所属未定地')], // disagree
      ['NULL', sqlString('千代田区')], // NULL code side
      [sqlString('13101'), 'NULL'] // NULL name side
    ];
    expect(await evaluate([codeSource, citySource], rows, unassignedDisagreementSql(adminAreaConfig))).toEqual([
      'false', 'false', 'true', 'true', 'true', 'true'
    ]);
  });
});

describe('part contacts (vertex equality)', () => {
  async function contacts(vertices: { part: number; code: string; x: number; y: number }[]): Promise<number[]> {
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    await connection.run(`CREATE TABLE ${tables.partVertices} (part_id BIGINT, muni_code VARCHAR, x DOUBLE, y DOUBLE)`);
    for (const v of vertices) {
      await connection.run(`INSERT INTO ${tables.partVertices} VALUES (${v.part}, ${sqlString(v.code)}, ${v.x}, ${v.y})`);
    }
    await connection.run(buildPartContactsSql(adminAreaConfig));
    const reader = await connection.runAndReadAll(`SELECT part_id FROM ${tables.partContacts} ORDER BY part_id`);
    return reader.getRowObjectsJson().map((row) => z.object({ part_id: z.coerce.number() }).parse(row).part_id);
  }

  it('puts both parts in contact when they share a vertex and have different codes', async () => {
    expect(await contacts([{ part: 1, code: 'A', x: 1, y: 2 }, { part: 2, code: 'B', x: 1, y: 2 }])).toEqual([1, 2]);
  });

  it('does not count a shared vertex between parts of the same code', async () => {
    expect(await contacts([{ part: 1, code: 'A', x: 1, y: 2 }, { part: 2, code: 'A', x: 1, y: 2 }])).toEqual([]);
  });

  it('does not count parts that share nothing, or vertices that differ in the last bit', async () => {
    expect(await contacts([{ part: 1, code: 'A', x: 1, y: 2 }, { part: 2, code: 'B', x: 1 + Number.EPSILON, y: 2 }])).toEqual([]);
  });

  it('keeps only the parts in contact when others are present', async () => {
    expect(
      await contacts([
        { part: 1, code: 'A', x: 1, y: 2 },
        { part: 2, code: 'B', x: 1, y: 2 },
        { part: 3, code: 'A', x: 9, y: 9 }
      ])
    ).toEqual([1, 2]);
  });
});

describe('kept parts (decision 4: every municipality survives; only real islands go)', () => {
  type Part = { code: string; id: number; area: number; touches?: boolean };

  /** Runs the flags SQL over hand-made tables (no geometry, no extension) and returns the kept part ids. */
  async function keptIds(parts: Part[]): Promise<number[]> {
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    await connection.run(`CREATE TABLE ${tables.parts} (muni_code VARCHAR, part_id BIGINT, area_m2 DOUBLE)`);
    await connection.run(`CREATE TABLE ${tables.partContacts} (part_id BIGINT)`);
    for (const part of parts) {
      await connection.run(`INSERT INTO ${tables.parts} VALUES (${sqlString(part.code)}, ${part.id}, ${part.area})`);
      if (part.touches === true) await connection.run(`INSERT INTO ${tables.partContacts} VALUES (${part.id})`);
    }
    await connection.run(buildPartFlagsSql(conversionConfig, adminAreaConfig));
    const reader = await connection.runAndReadAll(`SELECT part_id FROM ${tables.partFlags} WHERE kept ORDER BY part_id`);
    return reader.getRowObjectsJson().map((row) => z.object({ part_id: z.coerce.number() }).parse(row).part_id);
  }

  const small = conversionConfig.island.minAreaSquareMeters / 10;
  const large = conversionConfig.island.minAreaSquareMeters * 10;

  it('keeps a large part and drops a small island of the same municipality', async () => {
    expect(await keptIds([{ code: 'A', id: 1, area: large }, { code: 'A', id: 2, area: small }])).toEqual([1]);
  });

  it('keeps the largest part of a municipality whose parts are all below the threshold', async () => {
    expect(await keptIds([{ code: 'A', id: 1, area: small }, { code: 'A', id: 2, area: small / 2 }])).toEqual([1]);
  });

  it('keeps a municipality whose only part is small', async () => {
    expect(await keptIds([{ code: 'A', id: 1, area: small }])).toEqual([1]);
  });

  it('keeps a small part that touches another municipality (a land enclave)', async () => {
    expect(await keptIds([{ code: 'A', id: 1, area: large }, { code: 'A', id: 2, area: small, touches: true }])).toEqual([1, 2]);
  });

  it('drops a small part that touches nothing, and one that touches only its own code (no contact row)', async () => {
    // Touching only the own code gives no contact (the contact SQL joins on a different code), so it is a plain island.
    expect(await keptIds([{ code: 'A', id: 1, area: large }, { code: 'A', id: 2, area: small }, { code: 'B', id: 3, area: large }])).toEqual([1, 3]);
  });

  it('ranks parts of equal area deterministically: the lower id is the largest', async () => {
    const parts: Part[] = [{ code: 'A', id: 7, area: small }, { code: 'A', id: 3, area: small }];
    expect(await keptIds(parts)).toEqual([3]);
    expect(await keptIds([...parts].reverse())).toEqual([3]);
  });

  it('judges each municipality on its own', async () => {
    expect(
      await keptIds([
        { code: 'A', id: 1, area: small },
        { code: 'B', id: 2, area: large },
        { code: 'B', id: 3, area: small }
      ])
    ).toEqual([1, 2]);
  });
});

describe('checks', () => {
  it('accepts unassigned conditions that agree and refuses ones that do not', () => {
    expect(unassignedCheckError({ byCodeRows: 141, byNameRows: 141, mismatchRows: 0 }, adminAreaConfig)).toBeUndefined();
    const message = unassignedCheckError({ byCodeRows: 141, byNameRows: 140, mismatchRows: 1 }, adminAreaConfig);
    expect(message).toContain('141 by code');
    expect(message).toContain('140 by name');
  });

  it('accepts the expected row count and names both numbers when it differs', () => {
    expect(rowCountError('municipalities', 1898, 1898)).toBeUndefined();
    const message = rowCountError('municipalities', 1897, 1898);
    expect(message).toContain('municipalities');
    expect(message).toContain('1897');
    expect(message).toContain('1898');
  });

  it('names the command that fetches the raw data', () => {
    const message = missingRawFileMessage('data/raw/N03/N03-20260101.shp', conversionConfig);
    expect(message).toContain('data/raw/N03/N03-20260101.shp');
    expect(message).toContain(conversionConfig.downloadCommand);
  });

  it('formats the summary of an output file on one line', () => {
    expect(formatSummaryLine('data/dist/a.parquet', { rows: 1898, vertices: 146225, bytes: 1386001, invalid: 0 })).toBe(
      'data/dist/a.parquet: rows 1,898, vertices 146,225, bytes 1,386,001, invalid geometries 0'
    );
  });

  it('adds the number of NULL municipality codes for a point file', () => {
    expect(formatSummaryLine('data/dist/p.parquet', { rows: 10, vertices: 10, bytes: 2000, invalid: 0, nullCodes: 3 })).toBe(
      'data/dist/p.parquet: rows 10, vertices 10, bytes 2,000, invalid geometries 0, NULL muni_code 3'
    );
  });
});
