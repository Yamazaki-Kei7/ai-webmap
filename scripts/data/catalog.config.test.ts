import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { catalog } from '../../shared/catalog.js';
import { datasetFileName } from '../../shared/dataset-files.js';
import { dataConfig } from '../../shared/config.js';
import { serializeCatalog } from './catalog-plan.js';
import { catalogFile, columnTextSchema, datasetTexts } from './catalog.config.js';
import { datasetIds } from './datasets.config.js';

// The tracked catalog is generated from `data/dist/`, which a fresh checkout does not have: these tests compare the file
// with the settings of the generator instead, so that a change of one without the other fails here.
describe('the tracked catalog against the settings of the generator', () => {
  it('has the datasets of datasets.config.ts, in that order', () => {
    expect(catalog.map((dataset) => dataset.id)).toEqual(datasetIds);
  });

  it('names each file by the naming rule', () => {
    for (const dataset of catalog) expect(dataset.file, dataset.id).toBe(datasetFileName(dataset.id));
  });

  it('lists, for each dataset, exactly the columns that have a text', () => {
    for (const dataset of catalog) {
      const text = datasetTexts.find((candidate) => candidate.id === dataset.id);
      expect(text, dataset.id).toBeDefined();
      expect(dataset.columns.map((column) => column.name).sort(), dataset.id).toEqual((text?.columns ?? []).map((column) => column.name).sort());
    }
  });

  it('carries the texts of the settings', () => {
    for (const dataset of catalog) {
      const text = datasetTexts.find((candidate) => candidate.id === dataset.id);
      expect(dataset.title, dataset.id).toBe(text?.title);
      expect(dataset.description, dataset.id).toBe(text?.description);
      expect(dataset.source, dataset.id).toEqual(text?.source);
      expect(dataset.notes, dataset.id).toEqual(text?.notes);
      for (const column of dataset.columns) {
        const columnText = text?.columns.find((candidate) => candidate.name === column.name);
        expect(column.description, `${dataset.id}.${column.name}`).toBe(columnText?.description);
        expect(column.unit, `${dataset.id}.${column.name}`).toBe(columnText?.unit);
      }
    }
  });

  it('lists values on exactly the flagged columns: every value for `all`, at most the top limit for `top`', () => {
    for (const dataset of catalog) {
      const text = datasetTexts.find((candidate) => candidate.id === dataset.id);
      for (const column of dataset.columns) {
        const where = `${dataset.id}.${column.name}`;
        const kind = text?.columns.find((candidate) => candidate.name === column.name)?.values;
        expect(column.topValues !== undefined, where).toBe(kind !== undefined);
        if (kind === 'all') expect(column.topValues?.length, where).toBe(column.distinctCount);
        if (kind === 'top') expect(column.topValues?.length, where).toBe(Math.min(column.distinctCount ?? 0, dataConfig.catalog.topValuesLimit));
      }
    }
  });

  it('is stored in the serialisation of the generator (a hand edit or a non-deterministic write would show here)', () => {
    expect(readFileSync(catalogFile, 'utf8')).toBe(serializeCatalog(catalog));
  });
});

describe('the texts', () => {
  it('have a description for every column of every dataset, and no column twice in one dataset', () => {
    for (const text of datasetTexts) {
      const names = text.columns.map((column) => column.name);
      expect(new Set(names).size, text.id).toBe(names.length);
      for (const column of text.columns) expect(column.description.length, `${text.id}.${column.name}`).toBeGreaterThan(0);
    }
  });

  it('flag only columns that carry values a query must match, not free text or the municipality code', () => {
    const freeText = ['address', 'station_name', 'school_name', 'city_name', 'muni_name', 'muni_code'];
    for (const text of datasetTexts) {
      for (const column of text.columns) {
        if (column.values !== undefined) expect(freeText, `${text.id}.${column.name}`).not.toContain(column.name);
      }
    }
  });

  it('are strict about their keys', () => {
    expect(columnTextSchema.safeParse({ name: 'a', description: 'A', extra: 1 }).success).toBe(false);
    expect(columnTextSchema.safeParse({ name: 'a', description: '' }).success).toBe(false);
  });
});
