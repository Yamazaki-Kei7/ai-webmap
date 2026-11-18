/**
 * Puts the data files (the six Parquet files and the DuckDB-WASM binary) into the bucket of the local mock or of a
 * sandbox, then downloads every object again and compares it with the source (see README, "データのバケット").
 * Run from the repository root with `npm run data:upload`; flags are in `upload-args.ts`.
 * Production is not a target: the files are put there with the AWS CLI.
 * Credentials: the admin pair of `scripts/seed/seed-env.ts` (environment, then `.env`). Nothing secret is printed.
 * `--dry-run` prints the plan and contacts nothing: no config file, no credentials, no client.
 */
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { api as ApiClientType, authApi as AuthApiType } from 'aws-blocks';
import { devServerPort, missingCredentialsMessage, readSeedRole } from '../seed/seed-env.js';
import { parseUploadArgs } from './upload-args.js';
import { runDataUpload, type FlowDeps } from './upload-flow.js';
import { makeSignedUrlRequests } from './upload-http.js';
import { buildPlan, installCommand, planLine, type PlanItem, type WasmInstall } from './upload-plan.js';
import { clientConfigFile, clientUrlEnvNames, guardTarget } from './upload-target.js';
import { readInstalledWasm } from './upload-wasm.js';

/** Prints one error line and returns the failing exit code. */
function fail(message: string): number {
  console.error(message);
  return 1;
}

async function readSource(path: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
  return existsSync(path) ? readFile(path) : undefined;
}

/**
 * The client logs the API address it uses on its first call. Only the environment and the host are printed by this
 * command, so that one line is dropped, and then `console.log` is restored. If the client's wording changes, the filter
 * no longer matches and the line (the API base address, no signature or token) is printed.
 */
function dropClientAddressLogOnce(): void {
  const original = console.log;
  console.log = (...args: Parameters<typeof console.log>) => {
    if (typeof args[0] === 'string' && args[0].startsWith('[Blocks] Using API')) {
      console.log = original;
      return;
    }
    original(...args);
  };
}

/** The calls of the flow: the typed client for the API (it uses the cookie jar), `plainFetch` for the signed URLs. */
function makeDeps(api: typeof ApiClientType, authApi: typeof AuthApiType, plainFetch: typeof fetch, username: string, password: string): FlowDeps {
  return {
    signIn: async () => (await authApi.setAuthState({ action: 'signIn', username, password })).state === 'signedIn',
    signOut: async () => {
      await authApi.setAuthState({ action: 'signOut' });
    },
    createUpload: (name) => api.createDatasetUpload(name),
    getSources: () => api.getDatasetSources(),
    ...makeSignedUrlRequests(plainFetch),
    log: (line) => console.log(line),
    logError: (line) => console.error(line),
  };
}

async function main(): Promise<number> {
  const parsed = parseUploadArgs(process.argv.slice(2));
  if (!parsed.ok) return fail(parsed.message);
  const { target, dryRun, verifyOnly } = parsed.options;

  let wasm: WasmInstall;
  try {
    wasm = readInstalledWasm();
  } catch {
    return fail(`@duckdb/duckdb-wasm is not installed or unreadable. Run \`${installCommand}\`.`);
  }
  let items: PlanItem[];
  try {
    const plan = await buildPlan({ readFile: readSource, wasm });
    if (!plan.ok) return fail(plan.problems.join('\n'));
    items = plan.items;
  } catch (error) {
    // The name only: a message could carry a path.
    return fail(`A source file could not be read (${error instanceof Error ? error.name : 'an error'}). Nothing was uploaded.`);
  }

  if (dryRun) {
    for (const item of items) console.log(planLine(item));
    console.log('Dry run: nothing was contacted and no credentials were read.');
    return 0;
  }

  // The guard reads the config file once. The URL it checked is handed to the client through the variable the client
  // reads first, so the client does not read the file again (the dev server or a deploy could change it meanwhile).
  const guard = guardTarget({
    target,
    env: process.env,
    configText: existsSync(clientConfigFile) ? readFileSync(clientConfigFile, 'utf8') : undefined,
  });
  if (!guard.ok) return fail(guard.message);
  const { apiUrl, environment, host } = guard.guarded;
  console.log(`Target: ${environment}, host ${host}`);

  const credentials = readSeedRole('admin');
  if ('missing' in credentials) return fail(missingCredentialsMessage(credentials.missing));

  const { installCookieJar, isServerRunning } = await import('@aws-blocks/blocks/utils');
  if (environment === 'local' && !(await isServerRunning(devServerPort))) {
    return fail(`No dev server is listening on port ${devServerPort}. Start it with \`npm run dev\`.`);
  }
  // Node's fetch keeps no cookies; the session cookie is needed between the sign-in and the calls after it.
  // The original `fetch` is taken first: the jar patches the global one for every host, and a signed URL must not get the cookie.
  const plainFetch = globalThis.fetch;
  installCookieJar();
  process.env[clientUrlEnvNames.apiUrl] = apiUrl;
  dropClientAddressLogOnce();
  const { api, authApi } = await import('aws-blocks');

  const { username, password } = credentials.credentials;
  return runDataUpload({ items, verifyOnly, deps: makeDeps(api, authApi, plainFetch, username, password) });
}

try {
  process.exitCode = await main();
} catch (error) {
  // Only the error's name: a message could carry an address.
  console.error(error instanceof Error ? `The command failed: ${error.name}.` : 'The command failed.');
  process.exitCode = 1;
}
