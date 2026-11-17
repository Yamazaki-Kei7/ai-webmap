import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { catalog } from './catalog.js';
import {
  bboxSchema,
  catalogColumnSchema,
  catalogDatasetSchema,
  catalogSchema,
  maxListedValues,
  parseCatalog,
  type JsonValue
} from './catalog-schema.js';
import { dataConfig } from './config.js';

const column: Record<string, JsonValue> = { name: 'n', type: 'number', description: 'A number', stats: { min: 1, max: 2 } };
const textColumn: Record<string, JsonValue> = { name: 's', type: 'string', description: 'A text' };
const source: Record<string, JsonValue> = { name: 'Source', url: 'https://example.com/source', year: '2026', license: 'CC BY 4.0' };
const dataset: Record<string, JsonValue> = {
  id: 'things',
  title: 'Things',
  description: 'One row is a thing.',
  file: 'things.parquet',
  geometryType: 'point',
  featureCount: 3,
  bbox: [130, 30, 140, 40],
  source,
  columns: [column, textColumn],
  notes: ['Be careful.']
};

const accepted = (value: JsonValue): boolean => catalogSchema.safeParse(value).success;
const datasetAccepted = (overrides: Record<string, JsonValue>): boolean => accepted([{ ...dataset, ...overrides }]);
const columnAccepted = (overrides: Record<string, JsonValue>): boolean => datasetAccepted({ columns: [{ ...textColumn, ...overrides }] });

describe('the catalog of the repository', () => {
  it('has the six datasets', () => {
    expect(catalog).toHaveLength(6);
    expect(new Set(catalog.map((entry) => entry.id)).size).toBe(6);
  });

  it('lists the attribute columns only, never the geometry column', () => {
    for (const entry of catalog) {
      expect(entry.columns.map((c) => c.name), entry.id).not.toContain(dataConfig.geoParquet.geometryColumn);
    }
  });

  it('lists top values by count descending, then value ascending, within the limit, never more rows than the dataset has', () => {
    let checked = 0;
    for (const entry of catalog) {
      for (const c of entry.columns) {
        if (c.topValues === undefined) continue;
        checked += 1;
        const where = `${entry.id}.${c.name}`;
        expect(c.topValues.length, where).toBeLessThanOrEqual(maxListedValues);
        expect(c.topValues.reduce((sum, v) => sum + v.count, 0), where).toBeLessThanOrEqual(entry.featureCount);
        for (let i = 1; i < c.topValues.length; i += 1) {
          const before = c.topValues[i - 1];
          const after = c.topValues[i];
          if (before === undefined || after === undefined) throw new Error('unreachable');
          const ordered = before.count > after.count || (before.count === after.count && before.value < after.value);
          expect(ordered, `${where}: ${before.value} before ${after.value}`).toBe(true);
        }
        expect(c.distinctCount ?? -1, where).toBeGreaterThanOrEqual(c.topValues.length);
        // A list is either complete, or cut at the top-values limit.
        expect([c.distinctCount, dataConfig.catalog.topValuesLimit], where).toContain(c.topValues.length);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('has a range for every number column, and no top values on a number column', () => {
    for (const entry of catalog) {
      for (const c of entry.columns) {
        if (c.type === 'number') {
          expect(c.stats, `${entry.id}.${c.name}`).toBeDefined();
          expect(c.topValues, `${entry.id}.${c.name}`).toBeUndefined();
        }
      }
    }
  });

  // Japan's islands reach from Yonaguni (about 122.9 E) to Minamitorishima (about 154.0 E), and from the Okinotorishima
  // reef (about 20.4 N) to the north of Etorofu (about 45.6 N). The limits are written here, not taken from the code.
  it('keeps every bounding box inside the rough extent of Japan, and every dataset has at least one row', () => {
    for (const entry of catalog) {
      const [minLon, minLat, maxLon, maxLat] = entry.bbox;
      expect(minLon, entry.id).toBeGreaterThanOrEqual(122);
      expect(maxLon, entry.id).toBeLessThanOrEqual(154.5);
      expect(minLat, entry.id).toBeGreaterThanOrEqual(20);
      expect(maxLat, entry.id).toBeLessThanOrEqual(46);
      expect(minLon, entry.id).toBeLessThan(maxLon);
      expect(minLat, entry.id).toBeLessThan(maxLat);
      expect(entry.featureCount, entry.id).toBeGreaterThan(0);
    }
  });

  it('stays within the size limit (minified JSON, in characters)', () => {
    expect(JSON.stringify(catalog).length).toBeLessThanOrEqual(dataConfig.catalog.maxJsonChars);
  });

  it('does not import anything that only runs in Node (it also runs in the browser)', () => {
    for (const file of ['./catalog-schema.ts', './catalog.ts', './mapSpec.ts']) {
      expect(readFileSync(new URL(file, import.meta.url), 'utf8'), file).not.toMatch(/from 'node:/);
    }
  });
});

describe('the catalog schema', () => {
  it('accepts a valid dataset, and several', () => {
    expect(accepted([dataset])).toBe(true);
    expect(accepted([dataset, { ...dataset, id: 'other', file: 'other.parquet' }])).toBe(true);
    expect(parseCatalog([dataset])[0]?.id).toBe('things');
  });

  it('rejects an empty catalog and a catalog that is not a list', () => {
    expect(accepted([])).toBe(false);
    expect(accepted(dataset)).toBe(false);
  });

  it('rejects a dataset id used twice and a file name used twice', () => {
    expect(accepted([dataset, { ...dataset, file: 'other.parquet' }])).toBe(false);
    expect(accepted([dataset, { ...dataset, id: 'other' }])).toBe(false);
  });

  it.each(['Things', '1things', 'my-things', 'my things', 'things;drop', 'thingsé', '', '_things', 'things.x'])(
    'rejects the id %j, which is not a plain lower-case SQL identifier',
    (id) => {
      expect(datasetAccepted({ id })).toBe(false);
    }
  );

  it.each(['a', 'things', 'land_prices', 'a1', 'z_9'])('accepts the id %j', (id) => {
    expect(datasetAccepted({ id })).toBe(true);
  });

  it('rejects a column name used twice inside a dataset, and accepts the same name in two datasets', () => {
    expect(datasetAccepted({ columns: [textColumn, { ...textColumn, description: 'Again' }] })).toBe(false);
    expect(accepted([dataset, { ...dataset, id: 'other', file: 'other.parquet' }])).toBe(true);
  });

  it('rejects an empty column list', () => {
    expect(datasetAccepted({ columns: [] })).toBe(false);
  });

  it('rejects an unknown key at every level', () => {
    expect(accepted([{ ...dataset, extra: 1 }])).toBe(false);
    expect(datasetAccepted({ columns: [{ ...textColumn, extra: 1 }] })).toBe(false);
    expect(datasetAccepted({ source: { ...source, extra: 1 } })).toBe(false);
    expect(columnAccepted({ stats: { min: 1, max: 2, extra: 3 }, type: 'number' })).toBe(false);
  });

  it('rejects a missing required key', () => {
    for (const key of ['id', 'title', 'description', 'file', 'geometryType', 'featureCount', 'bbox', 'source', 'columns']) {
      const { [key]: _removed, ...rest } = dataset;
      expect(accepted([rest]), key).toBe(false);
    }
    expect(columnAccepted({ description: '' })).toBe(false);
  });

  it('rejects a geometry type that is not a family, and a row count that is not a positive integer', () => {
    expect(datasetAccepted({ geometryType: 'multipolygon' })).toBe(false);
    expect(datasetAccepted({ featureCount: 0 })).toBe(false);
    expect(datasetAccepted({ featureCount: 1.5 })).toBe(false);
  });

  it('rejects a source url that is not http(s)', () => {
    expect(datasetAccepted({ source: { ...source, url: 'javascript:alert(1)' } })).toBe(false);
    expect(datasetAccepted({ source: { ...source, url: 'not a url' } })).toBe(false);
  });
});

describe('the column schema', () => {
  it('rejects stats with min greater than max, and accepts min equal to max', () => {
    expect(catalogColumnSchema.safeParse({ ...column, stats: { min: 2, max: 1 } }).success).toBe(false);
    expect(catalogColumnSchema.safeParse({ ...column, stats: { min: 2, max: 2 } }).success).toBe(true);
  });

  it('rejects stats on a string column and top values on a number column', () => {
    expect(catalogColumnSchema.safeParse({ ...textColumn, stats: { min: 1, max: 2 } }).success).toBe(false);
    expect(catalogColumnSchema.safeParse({ ...column, topValues: [{ value: 'a', count: 1 }], distinctCount: 1 }).success).toBe(false);
  });

  it('rejects topValues without distinctCount, and distinctCount without topValues', () => {
    expect(catalogColumnSchema.safeParse({ ...textColumn, topValues: [{ value: 'a', count: 1 }] }).success).toBe(false);
    expect(catalogColumnSchema.safeParse({ ...textColumn, distinctCount: 1 }).success).toBe(false);
    expect(catalogColumnSchema.safeParse({ ...textColumn, topValues: [{ value: 'a', count: 1 }], distinctCount: 1 }).success).toBe(true);
  });

  it('rejects a distinctCount below the number of listed values, and a value listed twice', () => {
    const two = [{ value: 'a', count: 2 }, { value: 'b', count: 1 }];
    expect(catalogColumnSchema.safeParse({ ...textColumn, topValues: two, distinctCount: 1 }).success).toBe(false);
    expect(catalogColumnSchema.safeParse({ ...textColumn, topValues: [two[0], two[0]], distinctCount: 2 }).success).toBe(false);
  });

  it('rejects more top values than the limit, and a count that is not a positive integer', () => {
    const many = Array.from({ length: maxListedValues + 1 }, (_, i) => ({ value: `v${i}`, count: 1 }));
    expect(catalogColumnSchema.safeParse({ ...textColumn, topValues: many, distinctCount: many.length }).success).toBe(false);
    expect(catalogColumnSchema.safeParse({ ...textColumn, topValues: many.slice(0, -1), distinctCount: many.length }).success).toBe(true);
    expect(catalogColumnSchema.safeParse({ ...textColumn, topValues: [{ value: 'a', count: 0 }], distinctCount: 1 }).success).toBe(false);
  });

  it('rejects a type that is none of string, number and boolean, and a NaN range', () => {
    expect(catalogColumnSchema.safeParse({ ...textColumn, type: 'date' }).success).toBe(false);
    expect(catalogColumnSchema.safeParse({ ...column, stats: { min: Number.NaN, max: 1 } }).success).toBe(false);
  });
});

describe('the bbox schema', () => {
  it('accepts an ordered box inside the longitude and latitude ranges', () => {
    expect(bboxSchema.safeParse([130, 30, 140, 40]).success).toBe(true);
    expect(bboxSchema.safeParse([-180, -90, 180, 90]).success).toBe(true);
  });

  it('rejects a box that is not ordered', () => {
    expect(bboxSchema.safeParse([140, 30, 130, 40]).success).toBe(false);
    expect(bboxSchema.safeParse([130, 40, 140, 30]).success).toBe(false);
  });

  it('rejects a box outside the longitude or latitude range', () => {
    expect(bboxSchema.safeParse([130, 30, 181, 40]).success).toBe(false);
    expect(bboxSchema.safeParse([-181, 30, 140, 40]).success).toBe(false);
    expect(bboxSchema.safeParse([130, -91, 140, 40]).success).toBe(false);
    expect(bboxSchema.safeParse([130, 30, 140, 91]).success).toBe(false);
  });

  it('rejects a box with the wrong number of values or a value that is not a number', () => {
    expect(bboxSchema.safeParse([130, 30, 140]).success).toBe(false);
    expect(bboxSchema.safeParse([130, 30, 140, 40, 1]).success).toBe(false);
    expect(bboxSchema.safeParse([130, 30, 140, '40']).success).toBe(false);
    expect(catalogDatasetSchema.safeParse({ ...dataset, bbox: [140, 30, 130, 40] }).success).toBe(false);
  });
});
