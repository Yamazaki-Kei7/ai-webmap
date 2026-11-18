/**
 * The plan of `npm run data:upload`: for every uploadable file, where its bytes come from, its content type and
 * what they hash to. File access is injected, so the plan is built (and tested) without `data/` or `node_modules`.
 * The object names are `uploadableFiles` of `shared/datasets.ts` and nothing else.
 */
import { createHash } from 'node:crypto';
import { dataConfig } from '../../shared/config.js';
import { duckdbWasmFileName, uploadableFiles, uploadContentType } from '../../shared/datasets.js';
import { conversionConfig } from './datasets.config.js';

export type PlanItem = {
  name: string;
  sourcePath: string;
  contentType: string;
  bytes: Uint8Array<ArrayBuffer>;
  sha256: string;
};

/** Where the DuckDB-WASM binary is installed, and which version that package is. */
export type WasmInstall = { path: string; version: string };

export type PlanInput = {
  /** Reads a file, or returns undefined when it does not exist. */
  readFile: (path: string) => Promise<Uint8Array<ArrayBuffer> | undefined>;
  wasm: WasmInstall;
};

export type PlanResult = { ok: true; items: PlanItem[] } | { ok: false; problems: string[] };

export const convertCommand = 'npm run data:convert';
export const installCommand = 'npm install';

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The refusal when the installed package is not the version the app is configured for; undefined when they agree. */
export function wasmVersionProblem(installedVersion: string): string | undefined {
  if (installedVersion === dataConfig.duckdbWasmVersion) return undefined;
  return (
    `The installed @duckdb/duckdb-wasm is ${installedVersion}, but the app is configured for ${dataConfig.duckdbWasmVersion} ` +
    `(object ${duckdbWasmFileName}). Make duckdbWasmVersion in shared/config.ts and the installed package the same version.`
  );
}

function sourcePathOf(name: string, wasm: WasmInstall): string {
  return name === duckdbWasmFileName ? wasm.path : `${conversionConfig.dirs.dist}/${name}`;
}

function missingProblem(name: string, sourcePath: string): string {
  const fix = name === duckdbWasmFileName ? installCommand : convertCommand;
  return `Missing source for ${name}: ${sourcePath}. Make it with \`${fix}\`.`;
}

/** Builds the plan for all uploadable files, or lists every problem. Nothing is uploaded unless every source exists. */
export async function buildPlan({ readFile, wasm }: PlanInput): Promise<PlanResult> {
  const problems: string[] = [];
  const versionProblem = wasmVersionProblem(wasm.version);
  if (versionProblem !== undefined) problems.push(versionProblem);

  const items: PlanItem[] = [];
  for (const name of uploadableFiles) {
    const sourcePath = sourcePathOf(name, wasm);
    const bytes = await readFile(sourcePath);
    if (bytes === undefined) {
      problems.push(missingProblem(name, sourcePath));
      continue;
    }
    const contentType = uploadContentType(name);
    if (contentType === undefined) {
      problems.push(`No content type is defined for ${name}.`);
      continue;
    }
    items.push({ name, sourcePath, contentType, bytes, sha256: sha256Hex(bytes) });
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, items };
}

/** One printable line per planned object: name, source path, content type, size, hash. */
export function planLine(item: PlanItem): string {
  return `${item.name}  ${item.sourcePath}  ${item.contentType}  ${item.bytes.byteLength} bytes  sha256 ${item.sha256}`;
}
