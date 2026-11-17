import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { queryRows } from './convert-io.js';
import { conversionConfig, railwayRules, sourceDataset } from './datasets.config.js';
import { buildRailwayOutputQuery, railwayTables, vertexBudgetError } from './railway-plan.js';
import { openMemoryDatabase } from './sql-test-support.js';

const dataset = sourceDataset(railwayRules.datasetId);

describe('railways output', () => {
  it('labels the two codes and orders by operator, line name, then the two codes', async () => {
    const connection = await openMemoryDatabase();
    await connection.run(`CREATE TABLE ${railwayTables.simplified} (N02_003 VARCHAR, N02_004 VARCHAR, N02_002 VARCHAR, N02_001 VARCHAR, geom VARCHAR)`);
    await connection.run(`INSERT INTO ${railwayTables.simplified} VALUES
      ('山手線', '東日本旅客鉄道', '2', '11', 'g1'),
      ('1号線浅草線', '東京都', '3', '12', 'g2'),
      ('東横線', '東急電鉄', '4', '12', 'g3'),
      ('東横線', '東急電鉄', '4', '21', 'g4'),
      ('東海道新幹線', '東海旅客鉄道', '1', '11', 'g5')`);
    const rows = await queryRows(
      connection,
      buildRailwayOutputQuery(dataset, conversionConfig),
      z.object({ line_name: z.string(), operator: z.string(), operator_type: z.string(), railway_type: z.string(), geom: z.string() })
    );
    expect(Object.keys(rows[0] ?? {})).toEqual([...dataset.columns.map((column) => column.name), conversionConfig.geometryColumn]);
    expect(rows.map((row) => `${row.operator}/${row.line_name}/${row.railway_type}`)).toEqual([
      '東京都/1号線浅草線/普通鉄道',
      '東急電鉄/東横線/普通鉄道',
      '東急電鉄/東横線/軌道',
      '東日本旅客鉄道/山手線/普通鉄道JR',
      '東海旅客鉄道/東海道新幹線/普通鉄道JR'
    ]);
    expect(rows.map((row) => row.operator_type)).toEqual(['公営鉄道', '民営鉄道', '民営鉄道', 'JR在来線', 'JRの新幹線']);
  });
});

describe('railways vertex budget', () => {
  it('accepts a vertex count within the budget and names both numbers when it is over', () => {
    expect(vertexBudgetError('railways', railwayRules.vertexBudget, railwayRules.vertexBudget)).toBeUndefined();
    const message = vertexBudgetError('railways', railwayRules.vertexBudget + 1, railwayRules.vertexBudget);
    expect(message).toContain(String(railwayRules.vertexBudget + 1));
    expect(message).toContain(String(railwayRules.vertexBudget));
  });
});
