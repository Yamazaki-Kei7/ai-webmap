/**
 * Where the installed DuckDB-WASM binary is and which version of the package it belongs to.
 * The package exports the wasm file but not its `package.json`, so the version is read from the file next to `dist/`.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { z } from 'zod';
import { duckdbBundleKind } from '../../shared/datasets.js';
import type { WasmInstall } from './upload-plan.js';

/** The wasm file of the bundle kind, as a package specifier. */
export const wasmPackageSpecifier = `@duckdb/duckdb-wasm/dist/duckdb-${duckdbBundleKind}.wasm`;

const packageJsonSchema = z.object({ version: z.string().min(1) });

/** The path as a working-directory-relative one when it lies below it (for the plan's printout), else absolute. */
function displayPath(absolute: string): string {
  const relative = path.relative(process.cwd(), absolute);
  return relative.startsWith('..') || path.isAbsolute(relative) ? absolute : relative;
}

/** Throws when the package is not installed. */
export function readInstalledWasm(): WasmInstall {
  const wasmPath = createRequire(import.meta.url).resolve(wasmPackageSpecifier);
  const packageRoot = path.dirname(path.dirname(wasmPath));
  const { version } = packageJsonSchema.parse(JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')));
  return { path: displayPath(wasmPath), version };
}
