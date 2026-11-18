import { z } from 'zod';
import { catalog } from './catalog.js';
import { dataConfig } from './config.js';
import { datasetFileName } from './dataset-files.js';

/**
 * The files of the app's private dataset bucket: one definition for the backend, the frontend and scripts.
 * No Building Block is imported here. The dataset list comes from the catalog.
 */

export { datasetFileName };

export const datasetIds: string[] = catalog.map((dataset) => dataset.id);

export const datasetFileNames: string[] = catalog.map((dataset) => dataset.file);

// Not part of the dataset list.
// `eh` is the DuckDB-WASM bundle kind (exception handling); the version is in the name so that a new
// version is a new object.
export const duckdbBundleKind = 'eh';
export const duckdbWasmFileName = `duckdb-${duckdbBundleKind}-${dataConfig.duckdbWasmVersion}.wasm`;

/** Every file an administrator may upload: the datasets and the DuckDB-WASM binary. */
export const uploadableFiles: string[] = [...datasetFileNames, duckdbWasmFileName];

export const wasmContentType = 'application/wasm';
// The registered media type of Parquet (IANA, `application/vnd.apache.parquet`). The browser reads the
// files with fetch and does not use the type, so it matters only as the stored object's metadata.
export const parquetContentType = 'application/vnd.apache.parquet';

/** The content type of an uploadable file, decided here from its name; undefined for any other name. */
export function uploadContentType(file: string): string | undefined {
  if (file === duckdbWasmFileName) return wasmContentType;
  if (datasetFileNames.includes(file)) return parquetContentType;
  return undefined;
}

/**
 * The object key of an uploadable file in the bucket. The only place a key is made: the signed
 * download URLs and the signed upload URL both use it, and a caller never supplies a key.
 */
export function objectKey(file: string): string {
  return file;
}

/** The name of a file in an upload request: exactly one of `uploadableFiles` (case-sensitive, no trimming). */
export const uploadFileSchema = z.string().refine((file) => uploadableFiles.includes(file));

/** The refusal of an upload request that names a file that may not be uploaded. */
export const uploadErrors = {
  InvalidFile: 'InvalidUploadFileException'
} as const;

export const uploadStatus = {
  badRequest: 400
} as const;

/** Does not echo the input. */
export const invalidUploadFileMessage = 'Invalid file name';
