import { describe, expect, it } from 'vitest';
import { dataConfig } from './config';
import {
  datasetFileName,
  datasetFileNames,
  datasetIds,
  duckdbWasmFileName,
  objectKey,
  uploadableFiles,
  uploadContentType,
  uploadFileSchema
} from './datasets';

describe('dataset ids and file names', () => {
  it('lists the six datasets in order', () => {
    expect(datasetIds).toEqual(['municipalities', 'prefectures', 'land_prices', 'stations', 'railways', 'schools']);
  });

  it('names each dataset file <id>.parquet, all different', () => {
    expect(datasetFileNames).toEqual([
      'municipalities.parquet',
      'prefectures.parquet',
      'land_prices.parquet',
      'stations.parquet',
      'railways.parquet',
      'schools.parquet'
    ]);
    expect(new Set(datasetFileNames).size).toBe(datasetFileNames.length);
    expect(datasetFileName('schools')).toBe('schools.parquet');
  });
});

describe('derivation from the catalog', () => {
  it('names each file of the catalog by the naming rule of the ids', () => {
    expect(datasetFileNames).toEqual(datasetIds.map(datasetFileName));
  });
});

describe('DuckDB-WASM file name', () => {
  it('contains the bundle kind and the configured version, and is not a dataset file', () => {
    expect(duckdbWasmFileName).toContain(`-eh-${dataConfig.duckdbWasmVersion}`);
    expect(duckdbWasmFileName.endsWith('.wasm')).toBe(true);
    expect(datasetFileNames).not.toContain(duckdbWasmFileName);
  });
});

describe('uploadable files', () => {
  it('are the six dataset files and the wasm file', () => {
    expect([...uploadableFiles].sort()).toEqual([...datasetFileNames, duckdbWasmFileName].sort());
    expect(uploadableFiles).toHaveLength(7);
  });

  it('each have a content type, and wasm and Parquet differ', () => {
    for (const file of uploadableFiles) expect(uploadContentType(file)).toBeTruthy();
    expect(uploadContentType(duckdbWasmFileName)).toBe('application/wasm');
    expect(uploadContentType('stations.parquet')).toBe('application/vnd.apache.parquet');
  });

  it('have no content type for another name', () => {
    expect(uploadContentType('other.parquet')).toBeUndefined();
    expect(uploadContentType('')).toBeUndefined();
  });

  it('map to keys that are different and carry no path part', () => {
    const keys = uploadableFiles.map(objectKey);
    expect(new Set(keys).size).toBe(uploadableFiles.length);
    for (const key of keys) {
      expect(key).not.toContain('/');
      expect(key).not.toContain('..');
    }
  });
});

describe('uploadFileSchema', () => {
  it.each(uploadableFiles)('accepts %s', (file) => {
    expect(uploadFileSchema.safeParse(file).success).toBe(true);
  });

  type RejectedInput = string | number | null | undefined | { file: string } | string[];
  const rejected: [string, RejectedInput][] = [
    ['an unknown name', 'unknown.parquet'],
    ['a path out of the directory', '../municipalities.parquet'],
    ['a path under a directory', 'a/municipalities.parquet'],
    ['a path with a leading slash', '/municipalities.parquet'],
    ['another case', 'Municipalities.parquet'],
    ['the wasm name in another case', duckdbWasmFileName.toUpperCase()],
    ['a name with a trailing space', 'municipalities.parquet '],
    ['a name with a leading space', ' municipalities.parquet'],
    ['an id without the extension', 'municipalities'],
    ['the empty string', ''],
    ['a very long string', 'a'.repeat(100_000)],
    ['a number', 1],
    ['null', null],
    ['undefined', undefined],
    ['an object', { file: 'municipalities.parquet' }],
    ['an array of an allowed name', ['municipalities.parquet']]
  ];
  it.each(rejected)('rejects %s', (_label, value) => {
    expect(uploadFileSchema.safeParse(value).success).toBe(false);
  });
});
