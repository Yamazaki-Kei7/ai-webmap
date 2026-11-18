import { describe, expect, it } from 'vitest';
import { dataConfig } from '../../shared/config.js';
import { datasetIds } from '../../shared/datasets.js';
import {
  adminAreaConfig,
  conversionConfig,
  conversionConfigSchema,
  datasetConfig,
  datasetConfigSchema,
  datasetConfigs,
  landPriceRules,
  placeConfig,
  pointDataset,
  railwayRules,
  sourceDataset,
  sourceDatasetSchema,
  stationRules
} from './datasets.config.js';

describe('datasetConfigs', () => {
  it('has the five source datasets (prefectures is derived from municipalities), the point ones in the order of the run', () => {
    expect(datasetConfigs.map((config) => config.id)).toEqual(['municipalities', 'land_prices', 'stations', 'railways', 'schools']);
    expect(placeConfig.pointDatasets).toEqual(['land_prices', 'stations', 'schools']);
  });

  it('uses only ids that shared/datasets.ts defines', () => {
    for (const config of datasetConfigs) expect(datasetIds).toContain(config.id);
    expect(datasetIds).toContain('prefectures');
  });

  it('has the key of municipalities among its columns, mapped to the code attribute', () => {
    expect(datasetConfig('municipalities').columns).toContainEqual({ name: adminAreaConfig.codeColumn, source: adminAreaConfig.codeSource });
  });

  it('refuses a dataset that is not filled in', () => {
    expect(() => datasetConfig('prefectures')).toThrow(/prefectures/);
  });

  it('gives every dataset of task 1.4 an order, a source row count and an output row count, and the point ones a label column', () => {
    for (const id of [...placeConfig.pointDatasets, railwayRules.datasetId]) {
      expect(() => sourceDataset(id)).not.toThrow();
    }
    for (const id of placeConfig.pointDatasets) expect(() => pointDataset(id)).not.toThrow();
  });

  it('refuses a source dataset without an order or without its row counts', () => {
    const { orderBy: _orderBy, ...withoutOrder } = datasetConfig('land_prices');
    expect(sourceDatasetSchema.safeParse(withoutOrder).success).toBe(false);
  });

  it('has a label for every code column, on columns that exist, and no label twice for the same code', () => {
    for (const config of datasetConfigs) {
      const names = config.columns.map((column) => column.name);
      for (const [column, labels] of Object.entries(config.codeLabels ?? {})) {
        expect(names, `${config.id}.${column}`).toContain(column);
        expect(Object.keys(labels).length, `${config.id}.${column}`).toBeGreaterThan(0);
        expect(new Set(Object.values(labels)).size, `${config.id}.${column}`).toBe(Object.values(labels).length);
      }
    }
  });

  it('names output columns once per dataset, and keeps the label column and the order keys inside the dataset', () => {
    for (const id of placeConfig.pointDatasets) {
      const config = pointDataset(id);
      const names = config.columns.map((column) => column.name);
      expect(new Set(names).size).toBe(names.length);
      expect(names).toContain(config.labelColumn);
      expect(names).not.toContain(placeConfig.codeColumn);
      expect(config.orderBy.length).toBeGreaterThan(0);
    }
  });

  it('refers, in every rule, to a column that exists in its dataset (a rule on a missing column would silently not apply)', () => {
    expect(pointDataset(landPriceRules.datasetId).columns.map((column) => column.name)).toContain(landPriceRules.rateColumn);
    expect(pointDataset(stationRules.datasetId).columns.map((column) => column.name)).toContain(stationRules.passengersColumn);
  });

  it('rejects an id that is not a dataset id, an unknown key and an empty column list', () => {
    const valid = { id: 'municipalities', input: 'N03/x.shp', columns: [{ name: 'a', source: 'A' }] };
    expect(datasetConfigSchema.safeParse(valid).success).toBe(true);
    expect(datasetConfigSchema.safeParse({ ...valid, id: 'not_a_dataset' }).success).toBe(false);
    expect(datasetConfigSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    expect(datasetConfigSchema.safeParse({ ...valid, columns: [] }).success).toBe(false);
  });
});

describe('conversionConfig', () => {
  it('has the output format of shared/config.ts', () => {
    expect(conversionConfig.parquet).toEqual({
      rowGroupSize: dataConfig.geoParquet.rowGroupSize,
      compression: dataConfig.geoParquet.compression
    });
  });

  it('keeps the inputs, the intermediate and the outputs in three different folders', () => {
    const { raw, work, dist } = conversionConfig.dirs;
    expect(new Set([raw, work, dist]).size).toBe(3);
  });

  it('has the municipality code as the one column name of the key, the sort key of the point files and the first column of municipalities', () => {
    expect(adminAreaConfig.codeColumn).toBe(dataConfig.geoParquet.pointSortKey);
    expect(placeConfig.codeColumn).toBe(adminAreaConfig.codeColumn);
    expect(datasetConfig('municipalities').columns[0]?.name).toBe(adminAreaConfig.codeColumn);
  });

  it('snaps the input of mapshaper', () => {
    expect(conversionConfig.mapshaper.snap).toBe(true);
  });

  it('is accepted by its own schema and rejects a non-positive threshold or an unknown method', () => {
    expect(conversionConfigSchema.safeParse(conversionConfig).success).toBe(true);
    expect(conversionConfigSchema.safeParse({ ...conversionConfig, island: { minAreaSquareMeters: 0 } }).success).toBe(false);
    expect(conversionConfigSchema.safeParse({ ...conversionConfig, simplify: { method: 'other', intervalMeters: 1 } }).success).toBe(false);
  });
});
