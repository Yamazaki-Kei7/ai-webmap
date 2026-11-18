import { FileBucket } from '@aws-blocks/blocks';
import { objectKey, uploadContentType } from '../shared/datasets.js';
import { urlConfig } from '../shared/config.js';
import { scope } from './scope.js';

// The private bucket of the dataset files and the DuckDB-WASM binary. Not exported from `index.ts`.
// The only way to an object is a signed URL issued by the API to an allowed user (the block turns
// all public access off, encrypts at rest and enforces TLS). Not versioned: an object is replaced by
// uploading it again (a new DuckDB-WASM version has a new file name).
export const datasetsBucket = new FileBucket(scope, 'datasets', {
  versioned: false,
  // The browser downloads whole files with fetch (no Range request). Uploads are made by a script with
  // a signed URL, not by a browser, so there is no PUT here.
  corsRules: [{ allowedOrigins: ['*'], allowedMethods: ['GET', 'HEAD'] }]
});

/** `FileBucket` takes the lifetime of a signed URL in seconds, the unit of `urlConfig`. */
const signedUrlOptions = { expiresIn: urlConfig.signedUrlTtlSeconds };

/** A signed download URL of an uploadable file. Does not check that the object exists. */
export function signedDownloadUrl(file: string): Promise<string> {
  return datasetsBucket.getUrl(objectKey(file), signedUrlOptions);
}

/**
 * A signed upload URL of exactly one uploadable file.
 * The content type is passed for the local mock only, which binds it to the URL and refuses another one.
 * On AWS the presigner leaves `content-type` unsigned (source: s3-request-presigner `prepareRequest`), so
 * the uploader must itself send `Content-Type` equal to `uploadContentType(file)` and S3 stores what it is sent.
 * Unverified for a real upload on AWS: the SDK's default request-checksum calculation may put the checksum of an
 * empty body in the URL's query (read from source, not run); to be tried with a real PUT at the first deploy.
 */
export function signedUploadUrl(file: string): Promise<string> {
  return datasetsBucket.putUrl(objectKey(file), { ...signedUrlOptions, contentType: uploadContentType(file) });
}
