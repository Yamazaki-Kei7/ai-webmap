/**
 * The work of `npm run data:upload` after the plan and the target are settled: sign in, upload one object at a time,
 * verify by downloading every object again, and always sign out. Every network call is injected, so the flow runs
 * against fakes in tests.
 *
 * What is printed: object names, sizes, hashes, content types and HTTP status codes. Never a signed URL, a cookie, a
 * credential or a whole response body (the reason of a failed upload comes from `failureReason`). An error thrown by
 * an injected call is reported by its name only.
 */
import { datasetFileName, duckdbWasmFileName } from '../../shared/datasets.js';
import { sha256Hex, type PlanItem } from './upload-plan.js';
import { failureReason } from './upload-reason.js';

export type PutResult = { status: number; body: string };
export type GetResult = { status: number; contentType: string | undefined; bytes: Uint8Array };
export type DatasetSources = { sources: { id: string; url: string }[]; wasmUrl: string };

export type FlowDeps = {
  /** True when signed in. */
  signIn: () => Promise<boolean>;
  signOut: () => Promise<void>;
  createUpload: (name: string) => Promise<{ url: string }>;
  put: (url: string, contentType: string, bytes: Uint8Array<ArrayBuffer>) => Promise<PutResult>;
  getSources: () => Promise<DatasetSources>;
  get: (url: string) => Promise<GetResult>;
  log: (line: string) => void;
  logError: (line: string) => void;
};

export type FlowInput = { items: PlanItem[]; verifyOnly: boolean; deps: FlowDeps };

export const exitCodes = { ok: 0, failed: 1 } as const;

const isSuccess = (status: number): boolean => status >= 200 && status < 300;

type Attempt<T> = { ok: true; value: T } | { ok: false; errorName: string };

/** Runs one injected call; a throw becomes the error's name (its message could carry a URL). */
async function attempt<T>(call: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    return { ok: false, errorName: error instanceof Error ? error.name : 'an error' };
  }
}

/** The media type of a Content-Type header value, for comparison (parameters and case do not count). */
function mediaType(value: string): string {
  return value.split(';')[0].trim().toLowerCase();
}

async function uploadAll({ items, deps }: Pick<FlowInput, 'items' | 'deps'>): Promise<boolean> {
  const uploaded: string[] = [];
  for (const item of items) {
    const alreadyUploaded = uploaded.length > 0 ? uploaded.join(', ') : 'none';
    const result = await attempt(async () => {
      const { url } = await deps.createUpload(item.name);
      return deps.put(url, item.contentType, item.bytes);
    });
    if (!result.ok) {
      deps.logError(`Upload of ${item.name} failed: the request did not complete (${result.errorName}). Already uploaded: ${alreadyUploaded}.`);
      return false;
    }
    if (!isSuccess(result.value.status)) {
      const reason = failureReason(result.value.body);
      deps.logError(
        `Upload of ${item.name} failed: HTTP ${result.value.status}${reason === undefined ? '' : ` (${reason})`}. Already uploaded: ${alreadyUploaded}.`,
      );
      return false;
    }
    uploaded.push(item.name);
    deps.log(`uploaded  ${item.name}  ${item.bytes.byteLength} bytes`);
  }
  return true;
}

/** What differs between the planned object and what came back; empty when they are the same. */
function differences(item: PlanItem, result: GetResult): string[] {
  if (!isSuccess(result.status)) return [`download failed: HTTP ${result.status}`];
  const found: string[] = [];
  if (result.bytes.byteLength !== item.bytes.byteLength) found.push(`size ${result.bytes.byteLength} != ${item.bytes.byteLength}`);
  const actualHash = sha256Hex(result.bytes);
  if (actualHash !== item.sha256) found.push(`sha256 ${actualHash} != ${item.sha256}`);
  const actualType = result.contentType === undefined ? undefined : mediaType(result.contentType);
  if (actualType !== mediaType(item.contentType)) found.push(`content-type ${result.contentType ?? 'none'} != ${item.contentType}`);
  return found;
}

/** The download URL of every uploadable file by object name. */
function urlsByName(sources: DatasetSources): Map<string, string> {
  const urls = new Map(sources.sources.map((source) => [datasetFileName(source.id), source.url]));
  urls.set(duckdbWasmFileName, sources.wasmUrl);
  return urls;
}

/** Downloads every object and compares it with the plan. Every object is checked, also after a failure. */
async function verifyAll({ items, deps }: Pick<FlowInput, 'items' | 'deps'>): Promise<boolean> {
  const sources = await attempt(deps.getSources);
  if (!sources.ok) {
    deps.logError(`Could not get the download addresses (${sources.errorName}).`);
    return false;
  }
  const urls = urlsByName(sources.value);
  let verified = 0;
  for (const item of items) {
    const url = urls.get(item.name);
    let found: string[];
    if (url === undefined) {
      found = ['no download URL for this object'];
    } else {
      const downloaded = await attempt(() => deps.get(url));
      found = downloaded.ok ? differences(item, downloaded.value) : [`download did not complete (${downloaded.errorName})`];
    }
    if (found.length === 0) {
      verified++;
      deps.log(`verify    ${item.name}  ${item.bytes.byteLength} bytes  ok`);
    } else {
      deps.logError(`verify    ${item.name}  ${item.bytes.byteLength} bytes  DIFFERS: ${found.join('; ')}`);
    }
  }
  deps.log(`Verified ${verified} of ${items.length} objects.`);
  return verified === items.length;
}

/** The whole run; the exit code. Signs out in every case after the sign-in was tried. */
export async function runDataUpload({ items, verifyOnly, deps }: FlowInput): Promise<number> {
  try {
    const signedIn = await attempt(deps.signIn);
    if (!signedIn.ok || !signedIn.value) {
      deps.logError('Sign-in failed. Check the admin credentials and that the user is on the allowed and admin lists (README).');
      return exitCodes.failed;
    }
    if (!verifyOnly && !(await uploadAll({ items, deps }))) return exitCodes.failed;
    return (await verifyAll({ items, deps })) ? exitCodes.ok : exitCodes.failed;
  } finally {
    const signedOut = await attempt(deps.signOut);
    if (!signedOut.ok) deps.logError(`Sign-out failed (${signedOut.errorName}).`);
  }
}
