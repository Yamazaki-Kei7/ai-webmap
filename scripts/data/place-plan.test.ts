import type { DuckDBConnection } from '@duckdb/node-api';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { queryRows } from './convert-io.js';
import { conversionConfig, placeConfig, pointDataset } from './datasets.config.js';
import {
  buildCodesOutsideSql,
  buildPointOutputQuery,
  buildResolutionStatsSql,
  buildResolvedSql,
  codesOutsideError,
  datasetTables,
  nearestMarginDegrees,
  pointColumnNames,
  sourceAttributes,
  datasetRules
} from './place-plan.js';
import { openMemoryDatabase } from './sql-test-support.js';

/** The nullable text of a SQL value. */
const text = (value: string | undefined): string => (value === undefined ? 'NULL' : `'${value}'`);

/** The tables the rules read, as hand-made tables with plain columns (no geometry, no extension). */
async function createCommon(connection: DuckDBConnection, id: string, preparedColumns: string): Promise<void> {
  const tables = datasetTables(id);
  await connection.run(`CREATE TABLE municipality_attributes (muni_code VARCHAR, city_name VARCHAR, pref_name VARCHAR)`);
  await connection.run(
    `INSERT INTO municipality_attributes VALUES ('13101', '千代田区', '東京都'), ('13102', '中央区', '東京都'), ('22138', '浜松市', '静岡県')`
  );
  await connection.run(`CREATE TABLE ${tables.prepared} (${preparedColumns})`);
  await connection.run(
    `CREATE TABLE ${tables.located} (row_id BIGINT, containing_code VARCHAR, containing_codes BIGINT, nearest_code VARCHAR, nearest_distance_m DOUBLE)`
  );
}

/** One output row as the JSON reader gives it: text, numbers or NULL. */
const outputRow = z.record(z.string(), z.union([z.string(), z.number()]).nullable());

describe('schools: the municipality, the labels, the order', () => {
  const dataset = pointDataset('schools');
  const preparedColumns =
    'row_id BIGINT, P29_004 VARCHAR, P29_003 VARCHAR, P29_006 VARCHAR, P29_005 VARCHAR, P29_001 VARCHAR, P29_002 VARCHAR, P29_008 VARCHAR, source_code VARCHAR, geom VARCHAR, lon DOUBLE, lat DOUBLE';

  async function run(): Promise<z.infer<typeof outputRow>[]> {
    const connection = await openMemoryDatabase();
    await createCommon(connection, dataset.id, preparedColumns);
    const school = (id: number, name: string, type: string, admin: string, source: string, schoolCode: string, campus: string): string =>
      `(${id}, '${name}', '${type}', '${admin}', '住所${id}', '${source}', '${schoolCode}', '${campus}', '${source}', 'g${id}', ${id}.5, 35.0)`;
    await connection.run(`INSERT INTO schools_prepared VALUES
      ${school(1, '第二小', '16001', '3', '13102', 'B0002', '00')},
      ${school(2, '旧区の中学', '16002', '3', '22131', 'B0001', '00')},
      ${school(3, '桟橋の学校', '16004', '4', '99999', 'B0003', '00')},
      ${school(4, '第一小 本校', '16001', '3', '13101', 'A0001', '01')},
      ${school(5, '第一小 分校', '16001', '3', '13101', 'A0001', '02')}`);
    // row 2 (former ward code): the containing polygon decides; row 3: nothing contains it and the nearest is 1500 m away.
    await connection.run(`INSERT INTO schools_located VALUES
      (1, '13101', 1, NULL, NULL), (2, '22138', 1, NULL, NULL), (3, NULL, NULL, '13101', 1500.0), (4, '13102', 1, NULL, NULL), (5, '13101', 1, NULL, NULL)`);
    await connection.run(buildResolvedSql(dataset));
    return queryRows(connection, buildPointOutputQuery(dataset, conversionConfig), outputRow);
  }

  it('writes the dataset columns, then code, city and prefecture, then the geometry', async () => {
    const [first] = await run();
    expect(Object.keys(first ?? {})).toEqual([...pointColumnNames(dataset), conversionConfig.geometryColumn]);
  });

  it('keeps a known source code even when the containing polygon differs, and takes the polygon for an unknown source code', async () => {
    const rows = await run();
    const byName = new Map(rows.map((row) => [row['school_name'], row]));
    expect(byName.get('第二小')).toMatchObject({ muni_code: '13102', city_name: '中央区', pref_name: '東京都' });
    expect(byName.get('旧区の中学')).toMatchObject({ muni_code: '22138', city_name: '浜松市', pref_name: '静岡県' });
    // The source code 13101 stays although the polygon of row 4 is 13102.
    expect(byName.get('第一小 本校')).toMatchObject({ muni_code: '13101', city_name: '千代田区' });
  });

  it('leaves code, city and prefecture NULL for a point beyond the limit, and the other columns intact', async () => {
    const rows = await run();
    const pier = rows.find((row) => row['school_name'] === '桟橋の学校');
    expect(pier).toMatchObject({ muni_code: null, city_name: null, pref_name: null, school_type: '高等学校', admin_type: '民間', address: '住所3' });
  });

  it('turns the type and administrator codes into labels', async () => {
    const rows = await run();
    expect(rows.find((row) => row['school_name'] === '第二小')).toMatchObject({ school_type: '小学校', admin_type: '市区町村' });
    expect(rows.find((row) => row['school_name'] === '旧区の中学')).toMatchObject({ school_type: '中学校' });
  });

  it('orders by code (NULL last), then school code and campus code', async () => {
    const rows = await run();
    expect(rows.map((row) => row['school_name'])).toEqual(['第一小 本校', '第一小 分校', '第二小', '旧区の中学', '桟橋の学校']);
  });

  it('counts how the codes were found', async () => {
    const connection = await openMemoryDatabase();
    await createCommon(connection, dataset.id, preparedColumns);
    await connection.run(`INSERT INTO schools_prepared VALUES
      (1, 'a', '16001', '3', 'x', '13101', 'S1', '00', '13101', 'g', 1.0, 35.0),
      (2, 'b', '16001', '3', 'x', '22131', 'S2', '00', '22131', 'g', 2.0, 35.0),
      (3, 'c', '16001', '3', 'x', '99999', 'S3', '00', '99999', 'g', 3.0, 35.0)`);
    await connection.run(`INSERT INTO schools_located VALUES (1, '13102', 1, NULL, NULL), (2, '22138', 2, NULL, NULL), (3, NULL, NULL, NULL, NULL)`);
    await connection.run(buildResolvedSql(dataset));
    const [stats] = await queryRows(connection, buildResolutionStatsSql(dataset), z.record(z.string(), z.coerce.number()));
    expect(stats).toEqual({ rows: 3, by_source: 1, by_containing: 1, by_nearest: 0, unresolved: 1, source_unknown: 2, source_differs: 1, source_outside: 0, on_border: 1 });
  });
});

describe('land prices: the change rate and the source code', () => {
  const dataset = pointDataset('land_prices');
  const preparedColumns =
    'row_id BIGINT, L01_008 INTEGER, L01_009 DOUBLE, L01_002 VARCHAR, L01_025 VARCHAR, L01_001 VARCHAR, L01_003 VARCHAR, L01_010 INTEGER, source_code VARCHAR, geom VARCHAR, lon DOUBLE, lat DOUBLE';

  it('nulls the rate of new and suspended points, labels the use, and keeps every row and its source code', async () => {
    const connection = await openMemoryDatabase();
    await createCommon(connection, dataset.id, preparedColumns);
    const site = (id: number, price: number, rate: number, use: string, status: number, code: string): string =>
      `(${id}, ${price}, ${rate}, '${use}', '東京都　住所${id}', '${code}', '00${id}', ${status}, '${code}', 'g', ${id}.0, 35.0)`;
    await connection.run(`INSERT INTO land_prices_prepared VALUES
      ${site(1, 459000, 3.1, '000', 1, '13101')}, ${site(2, 83000, 0, '005', 1, '13101')}, ${site(3, 2880, 0, '003', 4, '13102')}, ${site(4, 530, 0, '013', 5, '13102')}, ${site(5, 9700, 0, '009', 5, '99999')}`);
    // Row 5 has an unknown source code and no containing polygon: its code is NULL, its price stays.
    await connection.run(`INSERT INTO land_prices_located VALUES (1, '13101', 1, NULL, NULL), (2, '13101', 1, NULL, NULL), (3, '13102', 1, NULL, NULL), (4, '13102', 1, NULL, NULL), (5, NULL, NULL, NULL, NULL)`);
    await connection.run(buildResolvedSql(dataset));
    const rows = await queryRows(connection, buildPointOutputQuery(dataset, conversionConfig), outputRow);
    expect(rows.map((row) => row['yoy_change_pct'])).toEqual([3.1, 0, null, null, null]);
    expect(rows.map((row) => row['land_use'])).toEqual(['住宅地', '商業地', '宅地見込地', '林地', '工業地']);
    expect(rows.map((row) => row['price_yen_per_m2'])).toEqual([459000, 83000, 2880, 530, 9700]);
    expect(rows.map((row) => row['muni_code'])).toEqual(['13101', '13101', '13102', '13102', null]);
  });
});

describe('stations: the stations that do not exist, the passenger rule, no source code', () => {
  const dataset = pointDataset('stations');
  const preparedColumns =
    'row_id BIGINT, S12_001 VARCHAR, S12_002 VARCHAR, S12_003 VARCHAR, S12_061 INTEGER, S12_058 INTEGER, S12_059 INTEGER, source_code VARCHAR, geom VARCHAR, lon DOUBLE, lat DOUBLE';

  it('drops the rows that say no station, keeps the number only where the rule allows it, and takes codes from the spatial results', async () => {
    const connection = await openMemoryDatabase();
    await createCommon(connection, dataset.id, preparedColumns);
    await connection.run(`INSERT INTO stations_prepared VALUES
      (1, '渋谷', '東急電鉄', '東横線', 1770430, 1, 1, NULL, 'g', 139.0, 35.0),
      (2, '渋谷', '東急電鉄', '銀座線', 0, 2, 1, NULL, 'g', 139.0, 35.0),
      (3, '東根室', '北海道旅客鉄道', '根室線', 0, 3, 4, NULL, 'g', 140.0, 35.0),
      (4, '桟橋', '東京港', '連絡線', 0, 1, 1, NULL, 'g', 141.0, 35.0),
      (5, '駅D', '会社', '線', 0, 1, 1, NULL, 'g', 142.0, 35.0)`);
    // 3: dropped. 4: not contained, nearest within the limit. 5: beyond the limit. 1 and 2: contained.
    await connection.run(`INSERT INTO stations_located VALUES
      (1, '13101', 1, NULL, NULL), (2, '13101', 1, NULL, NULL), (3, '13101', 1, NULL, NULL), (4, NULL, NULL, '13102', 120.5), (5, NULL, NULL, '13102', 2400.0)`);
    await connection.run(buildResolvedSql(dataset));
    const rows = await queryRows(connection, buildPointOutputQuery(dataset, conversionConfig), outputRow);
    expect(rows.map((row) => row['station_name'])).toEqual(['渋谷', '渋谷', '桟橋', '駅D']);
    expect(rows.map((row) => row['passengers_per_day'])).toEqual([1770430, null, 0, 0]);
    expect(rows.map((row) => row['muni_code'])).toEqual(['13101', '13101', '13102', null]);
    expect(rows.map((row) => row['city_name'])).toEqual(['千代田区', '千代田区', '中央区', null]);
    // Within a code the order follows station name, operator, line.
    expect(rows.slice(0, 2).map((row) => row['line_name'])).toEqual(['東横線', '銀座線']);
  });
});

describe('codes that are not in municipalities', () => {
  it('finds the codes of an output that municipalities lacks, ignores NULL, and says nothing when all are there', async () => {
    const connection = await openMemoryDatabase();
    await connection.run(`CREATE TABLE municipalities (muni_code VARCHAR)`);
    await connection.run(`INSERT INTO municipalities VALUES ('13101'), ('13102')`);
    await connection.run(`CREATE TABLE output (muni_code VARCHAR)`);
    await connection.run(`INSERT INTO output VALUES ('13101'), (NULL), ('99999'), ('99999'), ('00000')`);
    const outside = await queryRows(connection, buildCodesOutsideSql('output', 'municipalities'), z.object({ code: z.string() }));
    expect(outside.map((row) => row.code)).toEqual(['00000', '99999']);
    expect(codesOutsideError('schools', outside.map((row) => row.code))).toContain('99999');
    expect(codesOutsideError('schools', [])).toBeUndefined();
  });

  it('still finds a foreign code when the reference table holds a NULL code', async () => {
    const connection = await openMemoryDatabase();
    await connection.run(`CREATE TABLE municipalities (muni_code VARCHAR)`);
    await connection.run(`INSERT INTO municipalities VALUES ('13101'), (NULL)`);
    await connection.run(`CREATE TABLE output (muni_code VARCHAR)`);
    await connection.run(`INSERT INTO output VALUES ('13101'), ('99999')`);
    const outside = await queryRows(connection, buildCodesOutsideSql('output', 'municipalities'), z.object({ code: z.string() }));
    expect(outside.map((row) => row.code)).toEqual(['99999']);
  });
});

/** Metres in one degree of latitude / of longitude at a latitude (degrees), by the series of the WGS84 ellipsoid (not by the helper under test). */
const metersPerLatitudeDegree = (latitude: number): number => {
  const phi = (latitude * Math.PI) / 180;
  return 111132.954 - 559.822 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
};
const metersPerLongitudeDegree = (latitude: number): number => {
  const phi = (latitude * Math.PI) / 180;
  return 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi) + 0.118 * Math.cos(5 * phi);
};

describe('settings derived for the spatial search', () => {
  // The SQL box test is in the space whose east-west axis is scaled by cos(latitude): a polygon at the limit to the
  // east or to the north must stay a candidate over the latitudes of Japan (24 to 46 degrees).
  it.each([24, 35, 45, 46])('keeps a polygon exactly the limit away to the east and to the north as a candidate at latitude %i', (latitude) => {
    const margin = nearestMarginDegrees(conversionConfig);
    const limit = placeConfig.nearest.limitMeters;
    const east = (limit / metersPerLongitudeDegree(latitude)) * Math.cos((latitude * Math.PI) / 180);
    const north = limit / metersPerLatitudeDegree(latitude);
    expect(east).toBeLessThanOrEqual(margin);
    expect(north).toBeLessThanOrEqual(margin);
  });

  it('reads each source attribute once, including the ones of the rules and the order keys', () => {
    const dataset = pointDataset('land_prices');
    const attributes = sourceAttributes(dataset, datasetRules(dataset.id));
    expect(new Set(attributes).size).toBe(attributes.length);
    for (const name of [...dataset.columns.map((column) => column.source), 'L01_010', ...dataset.orderBy]) expect(attributes).toContain(name);
  });
});
