import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { dataConfig } from '../../shared/config.js';
import { duckdbBundleKind } from '../../shared/datasets.js';
import { readInstalledWasm } from './upload-wasm.js';

const dependencyName = '@duckdb/duckdb-wasm';
/** A pinned version: major.minor.patch with an optional pre-release suffix. */
const pinnedVersion = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const rootPackageSchema = z.object({ dependencies: z.record(z.string(), z.string()) });

describe('the DuckDB-WASM version', () => {
  const installed = readInstalledWasm();
  const declared = rootPackageSchema.parse(JSON.parse(readFileSync('package.json', 'utf8'))).dependencies[dependencyName];

  it('is pinned in package.json: a version (a pre-release such as 1.2.3-dev4.0 is fine), not range syntax, a tag or a wildcard', () => {
    expect(declared).toMatch(pinnedVersion);
    for (const range of ['^1.2.3', '~1.2.3', '>=1.2.3', '<2.0.0', '=1.2.3', '1.2.x', '1.x', '*', 'x', '1.2.3 - 2.0.0', '1.2.3 || 2.0.0', 'latest', 'next']) {
      expect(range).not.toMatch(pinnedVersion);
    }
    expect('1.2.3-dev4.0').toMatch(pinnedVersion);
  });

  it('is the same in shared/config.ts, the installed package and package.json', () => {
    expect({ configured: dataConfig.duckdbWasmVersion, installed: installed.version, declared }).toEqual({
      configured: declared,
      installed: declared,
      declared,
    });
  });

  it('has the wasm file of the bundle kind installed', () => {
    expect(installed.path.endsWith(`duckdb-${duckdbBundleKind}.wasm`)).toBe(true);
    expect(existsSync(installed.path)).toBe(true);
  });
});
