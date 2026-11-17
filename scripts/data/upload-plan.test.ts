import { describe, expect, it } from 'vitest';
import { dataConfig } from '../../shared/config.js';
import { datasetFileNames, duckdbWasmFileName, uploadableFiles, uploadContentType } from '../../shared/datasets.js';
import { conversionConfig } from './datasets.config.js';
import { buildPlan, convertCommand, installCommand, planLine, sha256Hex, wasmVersionProblem, type WasmInstall } from './upload-plan.js';

const wasm: WasmInstall = { path: 'node_modules/pkg/dist/the.wasm', version: dataConfig.duckdbWasmVersion };

/** Every source exists, with bytes that depend on the path. */
const allFiles = async (path: string): Promise<Uint8Array<ArrayBuffer> | undefined> => new TextEncoder().encode(`bytes of ${path}`);

function problemsOf(result: Awaited<ReturnType<typeof buildPlan>>): string[] {
  if (result.ok) throw new Error('expected problems');
  return result.problems;
}

describe('buildPlan', () => {
  it('has one item per uploadable name, in that order', async () => {
    const result = await buildPlan({ readFile: allFiles, wasm });
    if (!result.ok) throw new Error('expected a plan');
    expect(result.items.map((item) => item.name)).toEqual(uploadableFiles);
    expect(result.items).toHaveLength(datasetFileNames.length + 1);
  });

  it('takes the content type of each name from uploadContentType', async () => {
    const result = await buildPlan({ readFile: allFiles, wasm });
    if (!result.ok) throw new Error('expected a plan');
    for (const item of result.items) expect(item.contentType).toBe(uploadContentType(item.name));
  });

  it('reads the Parquet files from the dist directory and the wasm from the installed package', async () => {
    const result = await buildPlan({ readFile: allFiles, wasm });
    if (!result.ok) throw new Error('expected a plan');
    for (const item of result.items) {
      expect(item.sourcePath).toBe(item.name === duckdbWasmFileName ? wasm.path : `${conversionConfig.dirs.dist}/${item.name}`);
    }
  });

  it('hashes and measures the bytes it read', async () => {
    const result = await buildPlan({ readFile: allFiles, wasm });
    if (!result.ok) throw new Error('expected a plan');
    const [first] = result.items;
    expect(first.bytes.byteLength).toBe(new TextEncoder().encode(`bytes of ${first.sourcePath}`).byteLength);
    expect(first.sha256).toBe(sha256Hex(first.bytes));
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(planLine(first)).toContain(first.sha256);
  });

  it('names every missing source, with the command that makes it, and returns no items', async () => {
    const [missingParquet] = datasetFileNames;
    const readFile = async (path: string) => (path.endsWith(missingParquet) || path === wasm.path ? undefined : allFiles(path));
    const problems = problemsOf(await buildPlan({ readFile, wasm }));
    expect(problems).toHaveLength(2);
    expect(problems.find((problem) => problem.includes(missingParquet))).toContain(convertCommand);
    expect(problems.find((problem) => problem.includes(wasm.path))).toContain(installCommand);
  });

  it('refuses a wasm whose installed version is not the configured one, naming both', async () => {
    const problems = problemsOf(await buildPlan({ readFile: allFiles, wasm: { ...wasm, version: '0.0.1' } }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('0.0.1');
    expect(problems[0]).toContain(dataConfig.duckdbWasmVersion);
    expect(problems[0]).toContain('shared/config.ts');
  });
});

describe('wasmVersionProblem', () => {
  it('accepts exactly the configured version', () => {
    expect(wasmVersionProblem(dataConfig.duckdbWasmVersion)).toBeUndefined();
  });

  it('refuses any other version, also one that only differs by a suffix, naming both versions and the object', () => {
    for (const installed of ['9.9.9', `${dataConfig.duckdbWasmVersion}-dev1`, '']) {
      const message = wasmVersionProblem(installed) ?? '';
      expect(message).toContain(`installed @duckdb/duckdb-wasm is ${installed}`);
      expect(message).toContain(`configured for ${dataConfig.duckdbWasmVersion}`);
      expect(message).toContain(duckdbWasmFileName);
      expect(message).toContain('shared/config.ts');
    }
  });
});
