import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { catalogSchema, type Catalog } from '../../shared/catalog-schema.js';
import { dataConfig } from '../../shared/config.js';
import {
  assembleDataset,
  bboxOf,
  buildDescribeSql,
  buildDistinctCountSql,
  buildExtentSql,
  buildGeometryTypesSql,
  buildStatsSql,
  buildTopValuesSql,
  catalogColumnType,
  checkColumnTexts,
  geometryFamilyOf,
  listedValuesLimit,
  missingDatasetFileMessage,
  parquetRelation,
  roundOutward,
  serializeCatalog,
  type MeasuredDataset
} from './catalog-plan.js';
import type { DatasetText } from './catalog.config.js';
import { count, queryRows } from './convert-io.js';
import { measureColumn } from './catalog-write.js';
import { openMemoryDatabase } from './sql-test-support.js';

describe('the catalog type of a DuckDB column', () => {
  async function describedTypes(columns: string): Promise<Record<string, string>> {
    const connection = await openMemoryDatabase();
    await connection.run(`CREATE TABLE t (${columns})`);
    const rows = await queryRows(connection, buildDescribeSql('t'), z.object({ column_name: z.string(), column_type: z.string() }));
    return Object.fromEntries(rows.map((row) => [row.column_name, row.column_type]));
  }

  it('maps text to string, integer and floating types to number, and BOOLEAN to boolean', async () => {
    const types = await describedTypes(
      'a VARCHAR, b INTEGER, c BIGINT, d DOUBLE, e FLOAT, f HUGEINT, g UTINYINT, h SMALLINT, i BOOLEAN'
    );
    const mapped = Object.entries(types).map(([name, type]) => catalogColumnType('d', name, type));
    expect(mapped).toEqual(['string', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'boolean']);
  });

  it('fails on any other type, naming the dataset, the column and the type', async () => {
    const types = await describedTypes('ok VARCHAR, day DATE, price DECIMAL(10, 2), tags INTEGER[], raw BLOB');
    for (const column of ['day', 'price', 'tags', 'raw']) {
      const type = types[column] ?? '';
      expect(type).not.toBe('');
      expect(() => catalogColumnType('stations', column, type)).toThrow(`Dataset "stations", column "${column}": the type ${type} `);
    }
  });
});

describe('the geometry family of a file', () => {
  it('maps point, line and polygon types, multi-part ones included', () => {
    expect(geometryFamilyOf('d', ['POINT'])).toBe('point');
    expect(geometryFamilyOf('d', ['LINESTRING', 'MULTILINESTRING'])).toBe('line');
    expect(geometryFamilyOf('d', ['MULTILINESTRING'])).toBe('line');
    expect(geometryFamilyOf('d', ['POLYGON'])).toBe('polygon');
    expect(geometryFamilyOf('d', ['MULTIPOLYGON'])).toBe('polygon');
    expect(geometryFamilyOf('d', ['POLYGON', 'MULTIPOLYGON'])).toBe('polygon');
  });

  it('fails when a file mixes two families, naming the dataset', () => {
    expect(() => geometryFamilyOf('mixed', ['POINT', 'LINESTRING'])).toThrow(/mixed.*mixes/);
    expect(() => geometryFamilyOf('mixed', ['MULTIPOLYGON', 'LINESTRING'])).toThrow(/mixed/);
  });

  it('fails on a type that is none of the families and on a file without geometry', () => {
    expect(() => geometryFamilyOf('d', ['GEOMETRYCOLLECTION'])).toThrow(/GEOMETRYCOLLECTION/);
    expect(() => geometryFamilyOf('d', ['MULTIPOINT'])).toThrow(/MULTIPOINT/);
    expect(() => geometryFamilyOf('d', [])).toThrow(/no geometry/);
  });
});

describe('the bounding box', () => {
  it('rounds the minimum down and the maximum up, at the configured number of decimals', () => {
    const decimals = dataConfig.catalog.bboxDecimals;
    const step = 10 ** -decimals;
    const [minLon, minLat, maxLon, maxLat] = bboxOf({ minLon: 127.652285, minLat: 26.193265, maxLon: 145.583041, maxLat: 45.416338 });
    expect(minLon).toBeLessThanOrEqual(127.652285);
    expect(minLat).toBeLessThanOrEqual(26.193265);
    expect(maxLon).toBeGreaterThanOrEqual(145.583041);
    expect(maxLat).toBeGreaterThanOrEqual(45.416338);
    // Never further out than one step.
    expect(127.652285 - minLon).toBeLessThan(step * 1.0001);
    expect(maxLon - 145.583041).toBeLessThan(step * 1.0001);
    expect(String(minLon).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(decimals);
  });

  it('keeps a value that is already at the precision, even when it is stored a hair below it', () => {
    expect(roundOutward(127.65228, 5, 'down')).toBe(127.65228);
    expect(roundOutward(127.65228, 5, 'up')).toBe(127.65228);
    expect(roundOutward(24.04587, 5, 'down')).toBe(24.04587);
    expect(roundOutward(127.65228000000001, 5, 'up')).toBe(127.65228);
  });

  it('moves a value with more decimals outward, also below zero', () => {
    expect(roundOutward(1.234561, 5, 'down')).toBe(1.23456);
    expect(roundOutward(1.234561, 5, 'up')).toBe(1.23457);
    expect(roundOutward(-1.234561, 5, 'down')).toBe(-1.23457);
    expect(roundOutward(-1.234561, 5, 'up')).toBe(-1.23456);
  });
});

describe('the measuring SQL', () => {
  const rowSchema = z.object({ value: z.string(), count });

  async function withTable(createSql: string): Promise<Awaited<ReturnType<typeof openMemoryDatabase>>> {
    const connection = await openMemoryDatabase();
    await connection.run(createSql);
    return connection;
  }

  it('finds the minimum and maximum of the non-NULL values of a number column', async () => {
    const connection = await withTable('CREATE TABLE t AS SELECT * FROM (VALUES (5), (NULL), (-2), (9), (NULL)) AS v(n)');
    const [row] = await queryRows(connection, buildStatsSql('t', 'n'), z.object({ min: z.number().nullable(), max: z.number().nullable() }));
    expect(row).toEqual({ min: -2, max: 9 });
  });

  it('returns NULL for the range of a column with no value', async () => {
    const connection = await withTable('CREATE TABLE t (n INTEGER)');
    await connection.run('INSERT INTO t VALUES (NULL), (NULL)');
    const [row] = await queryRows(connection, buildStatsSql('t', 'n'), z.object({ min: z.number().nullable(), max: z.number().nullable() }));
    expect(row).toEqual({ min: null, max: null });
  });

  it('lists top values by count descending, then value ascending, without NULL', async () => {
    const connection = await withTable(
      `CREATE TABLE t AS SELECT * FROM (VALUES ('b'), ('a'), ('b'), ('c'), ('a'), ('d'), (NULL), (NULL), (NULL), ('c')) AS v(s)`
    );
    // b, a and c have two rows each, d one; the three NULL rows are not a value.
    const rows = await queryRows(connection, buildTopValuesSql('t', 's', 10), rowSchema);
    expect(rows).toEqual([
      { value: 'a', count: 2 },
      { value: 'b', count: 2 },
      { value: 'c', count: 2 },
      { value: 'd', count: 1 }
    ]);
  });

  it('keeps only the limit when there are more values, the most frequent ones', async () => {
    const connection = await withTable(`CREATE TABLE t AS SELECT 'v' || lpad((i % 7)::VARCHAR, 2, '0') AS s FROM range(30) r(i)`);
    // 30 rows over 7 values: v00 and v01 appear 5 times, the others 4 times each (v02 .. v06 start the tail of the ties).
    const rows = await queryRows(connection, buildTopValuesSql('t', 's', 3), rowSchema);
    expect(rows).toEqual([
      { value: 'v00', count: 5 },
      { value: 'v01', count: 5 },
      { value: 'v02', count: 4 }
    ]);
    const [distinct] = await queryRows(connection, buildDistinctCountSql('t', 's'), z.object({ distinct_count: count }));
    expect(distinct?.distinct_count).toBe(7);
  });

  it('lists nothing and counts zero distinct values for an all-NULL column', async () => {
    const connection = await withTable('CREATE TABLE t (s VARCHAR)');
    await connection.run('INSERT INTO t VALUES (NULL), (NULL)');
    expect(await queryRows(connection, buildTopValuesSql('t', 's', 10), rowSchema)).toEqual([]);
    const [distinct] = await queryRows(connection, buildDistinctCountSql('t', 's'), z.object({ distinct_count: count }));
    expect(distinct?.distinct_count).toBe(0);
  });

  it('turns a number column into text for the top values, and quotes a column name that needs it', async () => {
    const connection = await withTable(`CREATE TABLE t AS SELECT * FROM (VALUES (1), (1), (2)) AS v("odd name")`);
    expect(await queryRows(connection, buildTopValuesSql('t', 'odd name', 5), rowSchema)).toEqual([
      { value: '1', count: 2 },
      { value: '2', count: 1 }
    ]);
  });

  it('builds the spatial queries over the configured geometry column and the file relation', () => {
    const relation = parquetRelation("data/dist/it's.parquet");
    expect(relation).toBe("read_parquet('data/dist/it''s.parquet')");
    expect(buildExtentSql(relation, 'geom')).toContain('ST_XMin("geom")');
    expect(buildExtentSql(relation, 'geom')).toContain(relation);
    expect(buildGeometryTypesSql(relation, 'geom')).toContain('ST_GeometryType("geom")');
  });
});

const columnTexts = [
  { name: 'a', description: 'A' },
  { name: 'n', description: 'N', unit: 'm' }
];

const text: DatasetText = {
  id: 'things',
  title: 'Things',
  description: 'One row is a thing.',
  source: { name: 'Source', url: 'https://example.com/source', year: '2026', license: 'CC BY 4.0' },
  columns: columnTexts,
  notes: ['Be careful.']
};

const measured: MeasuredDataset = {
  file: 'things.parquet',
  geometryType: 'point',
  featureCount: 3,
  bbox: [1, 2, 3, 4],
  columns: [
    { name: 'a', type: 'string' },
    { name: 'n', type: 'number', stats: { min: 1, max: 2 } }
  ]
};

describe('the values of a string column', () => {
  async function measured(valuesKind: 'all' | 'top' | undefined, distinct: number) {
    const connection = await openMemoryDatabase();
    await connection.run(`CREATE TABLE t AS SELECT 'v' || lpad((i % ${distinct})::VARCHAR, 2, '0') AS s FROM range(${distinct * 2}) r(i)`);
    return measureColumn(connection, 't', 'things', { name: 's', type: 'string' }, valuesKind);
  }

  it('lists every distinct value of an `all` column, more than the top limit', async () => {
    const distinct = dataConfig.catalog.topValuesLimit + 3;
    const column = await measured('all', distinct);
    expect(column.distinctCount).toBe(distinct);
    expect(column.topValues).toHaveLength(distinct);
    expect(column.topValues?.every((entry) => entry.count === 2)).toBe(true);
  });

  it('fails for an `all` column with more distinct values than the all-values limit, naming dataset and column', async () => {
    await expect(measured('all', dataConfig.catalog.allValuesLimit + 1)).rejects.toThrow(/Dataset "things", column "s"/);
    expect((await measured('all', dataConfig.catalog.allValuesLimit)).topValues).toHaveLength(dataConfig.catalog.allValuesLimit);
  });

  it('lists only the top-values limit for a `top` column, and still counts every distinct value', async () => {
    const distinct = dataConfig.catalog.allValuesLimit + 5;
    const column = await measured('top', distinct);
    expect(column.topValues).toHaveLength(dataConfig.catalog.topValuesLimit);
    expect(column.distinctCount).toBe(distinct);
  });

  it('measures no values for a column that is not flagged', async () => {
    const column = await measured(undefined, 3);
    expect(column.topValues).toBeUndefined();
    expect(column.distinctCount).toBeUndefined();
  });

  it('picks the limit by kind, and fails only for `all` above its limit', () => {
    expect(listedValuesLimit('d', 'c', 'top', 1_000)).toBe(dataConfig.catalog.topValuesLimit);
    expect(listedValuesLimit('d', 'c', 'all', 3)).toBe(dataConfig.catalog.allValuesLimit);
    expect(() => listedValuesLimit('d', 'c', 'all', dataConfig.catalog.allValuesLimit + 1)).toThrow(/Dataset "d", column "c"/);
  });
});

describe('the merge of measurements and texts', () => {
  it('builds a dataset that the catalog schema accepts, columns in the order of the file', () => {
    const dataset = assembleDataset(text, measured);
    expect(catalogSchema.safeParse([dataset]).success).toBe(true);
    expect(dataset.columns.map((column) => column.name)).toEqual(['a', 'n']);
    expect(dataset.columns[1]).toEqual({ name: 'n', type: 'number', description: 'N', unit: 'm', stats: { min: 1, max: 2 } });
    expect(dataset.notes).toEqual(['Be careful.']);
  });

  it('takes the column order from the file, not from the texts', () => {
    const reversed = assembleDataset({ ...text, columns: [...columnTexts].reverse() }, measured);
    expect(reversed.columns.map((column) => column.name)).toEqual(['a', 'n']);
  });

  it('leaves out the notes and the unit when the texts have none', () => {
    const { notes: _notes, ...withoutNotes } = text;
    const dataset = assembleDataset({ ...withoutNotes, columns: [{ name: 'a', description: 'A' }, { name: 'n', description: 'N' }] }, measured);
    expect('notes' in dataset).toBe(false);
    expect('unit' in (dataset.columns[1] ?? {})).toBe(false);
  });

  it('fails when the file has a column without a text, naming dataset and column', () => {
    const extra: MeasuredDataset = { ...measured, columns: [...measured.columns, { name: 'extra', type: 'string' }] };
    expect(() => assembleDataset(text, extra)).toThrow(/things.*without a text: extra/);
  });

  it('fails when a text describes a column the file does not have, naming dataset and column', () => {
    const missing: DatasetText = { ...text, columns: [...columnTexts, { name: 'ghost', description: 'G' }] };
    expect(() => assembleDataset(missing, measured)).toThrow(/things.*does not have: ghost/);
  });

  it('names both problems at once', () => {
    expect(() =>
      checkColumnTexts('things', [{ name: 'a', type: 'string' }], [{ name: 'b', description: 'B' }])
    ).toThrow(/without a text: a.*does not have: b/);
  });

  it('fails on a text twice and on top values asked for a column that is not a string', () => {
    expect(() =>
      checkColumnTexts('things', [{ name: 'a', type: 'string' }], [{ name: 'a', description: 'A' }, { name: 'a', description: 'A2' }])
    ).toThrow(/twice: a/);
    expect(() =>
      checkColumnTexts('things', [{ name: 'n', type: 'number' }], [{ name: 'n', description: 'N', values: 'top' }])
    ).toThrow(/values are asked for column n.*number/);
  });

  it('carries the top values and the distinct count into the column', () => {
    const withValues: MeasuredDataset = {
      ...measured,
      columns: [{ name: 'a', type: 'string', topValues: [{ value: 'x', count: 2 }], distinctCount: 4 }, measured.columns[1] ?? { name: 'n', type: 'number' }]
    };
    const dataset = assembleDataset(text, withValues);
    expect(dataset.columns[0]).toMatchObject({ topValues: [{ value: 'x', count: 2 }], distinctCount: 4 });
  });
});

describe('the serialisation', () => {
  const catalog: Catalog = catalogSchema.parse([assembleDataset(text, measured)]);

  it('is 2-space indented, ends with one newline, and reads back to the same catalog', () => {
    const json = serializeCatalog(catalog);
    expect(json.endsWith('}\n]\n')).toBe(true);
    expect(json.endsWith('\n\n')).toBe(false);
    expect(json).toContain('\n  {\n    "id": "things",');
    expect(catalogSchema.parse(JSON.parse(json))).toEqual(catalog);
  });

  it('writes the keys in the order of the schema, whatever order the object was built in', () => {
    const shuffled = Object.fromEntries(Object.entries(catalog[0] ?? {}).reverse());
    const validated = catalogSchema.parse([shuffled]);
    expect(Object.keys(validated[0] ?? {})).toEqual(['id', 'title', 'description', 'file', 'geometryType', 'featureCount', 'bbox', 'source', 'columns', 'notes']);
    expect(serializeCatalog(validated)).toBe(serializeCatalog(catalog));
  });

  it('keeps Japanese text as it is, not as escapes', () => {
    const japanese = catalogSchema.parse([assembleDataset({ ...text, title: '駅別乗降客数' }, measured)]);
    expect(serializeCatalog(japanese)).toContain('"title": "駅別乗降客数"');
  });
});

describe('the message for a missing dataset file', () => {
  it('names the file and the command that writes it', () => {
    const message = missingDatasetFileMessage('data/dist/x.parquet', 'npm run data:convert');
    expect(message).toContain('data/dist/x.parquet');
    expect(message).toContain('npm run data:convert');
  });
});
