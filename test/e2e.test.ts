/**
 * End-to-end tests — call the backend through the typed client the frontend uses.
 *
 * Run:  npm run test:e2e
 *
 * Structure:
 *   - Setup (seeds the user, starts the dev server, imports the client) — don't touch
 *   - Client namespaces: exactly `api` and `authApi`
 *   - Auth tests: sign-up and the other account actions are rejected (signed out
 *     and signed in); the seeded users can sign in and out
 *   - Access tests: every `api` method refuses a signed-out caller and a signed-in
 *     user who is not on the allowed list; allowed users and admins are served
 *   - Dataset tests: signed download URLs for allowed users; upload URLs for admins only; an upload
 *     round trip and the refusal of a wrong content type (they replace one real object and put it back)
 *
 * The seeded users (admin, allowed, denied) and the local lists are created by
 * `npm run seed:users` before the dev server starts (see README). When a dev
 * server is already running, nothing is seeded.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { installCookieJar, isServerRunning } from '@aws-blocks/blocks/utils';
// Imported from the block itself: it is the only entry that exports the error names under the browser condition.
import { AuthBasicErrors } from '@aws-blocks/bb-auth-basic';
import { ApiError } from '@aws-blocks/blocks/client';
import { z } from 'zod';
import type { AgentStreamChunk } from '@aws-blocks/blocks';
import type { api as ApiClientType, authApi as AuthApiType } from 'aws-blocks';
import { llmModeEnvName, llmModes, type LlmMode } from '../aws-blocks/llm-mode.js';
import { accessErrors, accessStatus } from '../shared/access.js';
import { agentConfig, mapConfig, resultConfig } from '../shared/config.js';
import { conversationErrors, conversationStatus } from '../shared/conversation.js';
import type { MapContext } from '../shared/mapSpec.js';
import { stripMapState } from '../shared/mapState.js';
import { clientToolRequestSchema, interruptName, type ClientToolRequest, type ToolName } from '../shared/toolProtocol.js';
import { datasetFileName, datasetFileNames, datasetIds, uploadableFiles, uploadContentType, uploadErrors, uploadStatus } from '../shared/datasets.js';
import { millisecondsPerSecond, signedUrlTtlMs } from '../shared/signed-url.js';
import {
  allSeedEnvNames,
  devServerPort,
  missingCredentialsMessage,
  readSeedCredentials,
  seedEnvFile,
  type SeedRole,
} from '../scripts/seed/seed-env.js';

// npm is npm.cmd on Windows, which spawn won't resolve without a shell.
const isWin = process.platform === 'win32';

// The original `fetch`, kept for every request to a signed URL: the cookie jar below patches the global `fetch` for every
// host, and a signed URL (S3 on a sandbox) must not receive the app's session cookie. This is also what `npm run data:upload` does.
const plainFetch = globalThis.fetch;

// Install cookie jar before importing the API client — Node's fetch doesn't
// persist cookies between requests, which breaks authenticated API calls.
installCookieJar();

let server: ChildProcess | null = null;
let authApi: typeof AuthApiType;
let api: typeof ApiClientType;
// The model mode the test pins on a dev server it starts itself; an existing server may run either.
const testLlmMode: LlmMode = 'canned';
let startedServer = false;

const readinessUrl = `http://localhost:${devServerPort}/.blocks-sandbox/config.json`;
const seedCredentials = readSeedCredentials();

/** The dev server and vite do not need the seeded users' credentials; the agent runs on the canned model. */
function serverEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of allSeedEnvNames) delete env[name];
  env[llmModeEnvName] = testLlmMode;
  return env;
}

// ─── Setup (don't touch) ─────────────────────────────────────────────────────

test.before(async () => {
  // Use existing dev server if running (it cannot be seeded while running),
  // otherwise seed first and then start one.
  if (!await isServerRunning(devServerPort)) {
    const seeded = spawnSync('npm', ['run', 'seed:users'], { cwd: process.cwd(), stdio: 'inherit', shell: isWin });
    if (seeded.status !== 0) throw new Error('Seeding the test users failed; see the output above.');
    startedServer = true;
    server = spawn('npm', ['run', 'dev:server'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !isWin,
      shell: isWin,
      env: { ...serverEnv(), NODE_OPTIONS: '' },
    });
    server.unref();
    await setTimeout(2000);
  }

  // Wait for the Blocks server to be ready without depending on any app API.
  // The server regenerates `aws-blocks/client.js` before it listens, so the
  // client must be imported only after this succeeds (not earlier: a stale file
  // would be cached by the module loader).
  let ready = false;
  for (let i = 0; i < 30 && !ready; i++) {
    try {
      ready = (await fetch(readinessUrl)).ok;
    } catch {
      // The server is not listening yet.
    }
    if (!ready) await setTimeout(1000);
  }
  if (!ready) throw new Error(`Server not ready at ${readinessUrl}`);

  const client = await import('aws-blocks');
  authApi = client.authApi;
  api = client.api;
});

test.after(() => {
  if (server?.pid) {
    // Graceful stop first: killing only the process group leaves the frontend (vite) running on its port.
    spawnSync('npm', ['run', 'dev:stop'], { cwd: process.cwd(), stdio: 'ignore', shell: isWin });
    try {
      if (isWin) spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(-server.pid, 'SIGTERM');
    } catch {}
  }
});

// ─── App readiness ────────────────────────────────────────────────────────────

test('app: server serves its Blocks config', async () => {
  const response = await fetch(readinessUrl);
  assert.ok(response.ok, `expected ${readinessUrl} to respond ok`);
});

// ─── Auth: sign-up is impossible ──────────────────────────────────────────────

test('app: the typed client exposes exactly the api and authApi namespaces', async () => {
  const client = await import('aws-blocks');
  // `generateClient` is the generated client's factory, not a namespace.
  const namespaces = Object.keys(client).filter((name) => name !== 'generateClient').sort();
  assert.deepStrictEqual(namespaces, ['api', 'authApi']);
});

test('auth: starts signed out and offers the sign-in action only', async () => {
  const state = await authApi.getAuthState();
  assert.strictEqual(state.state, 'signedOut');
  assert.deepStrictEqual(state.actions.map((action) => action.name), ['signIn']);
});

/** Asserts that a rejected action left the caller signed out and created nothing. */
async function assertRejectedAndNoAccount(
  result: Awaited<ReturnType<typeof authApi.setAuthState>>,
  username: string,
  password: string,
): Promise<void> {
  assert.strictEqual(result.state, 'signedOut');
  assert.ok(result.error, 'expected an error message');
  assert.deepStrictEqual(result.actions.map((action) => action.name), ['signIn']);
  assert.strictEqual((await authApi.getAuthState()).state, 'signedOut');
  // No account exists: the same credentials cannot sign in.
  const signIn = await authApi.setAuthState({ action: 'signIn', username, password });
  assert.strictEqual(signIn.state, 'signedOut');
  assert.ok(signIn.error, 'expected the sign-in with the same credentials to fail');
}

// A fresh user name per run keeps these tests valid on every run.
const probe = () => ({ username: `probe-${randomUUID()}`, password: `Pw-${randomUUID()}` });

test('auth: a hand-made sign-up is rejected and creates no account', async () => {
  const { username, password } = probe();
  const result = await authApi.setAuthState({ action: 'signUp', username, password });
  await assertRejectedAndNoAccount(result, username, password);
});

test('auth: a hand-made sign-up confirmation is rejected and creates no account', async () => {
  const { username, password } = probe();
  const result = await authApi.setAuthState({ action: 'confirmSignUp', username, code: '123456', password });
  await assertRejectedAndNoAccount(result, username, password);
});

test('auth: a hand-made password reset is rejected and creates no account', async () => {
  const { username, password } = probe();
  const request = await authApi.setAuthState({ action: 'resetPassword', username });
  await assertRejectedAndNoAccount(request, username, password);
  const confirm = await authApi.setAuthState({
    action: 'confirmResetPassword',
    username,
    code: '123456',
    newPassword: password,
  });
  await assertRejectedAndNoAccount(confirm, username, password);
});

test('auth: an unknown action is rejected', async () => {
  const { username, password } = probe();
  // @ts-expect-error — deliberately outside the typed action union
  const result = await authApi.setAuthState({ action: 'createAdmin', username, password });
  await assertRejectedAndNoAccount(result, username, password);
});

// ─── Auth: the seeded user ────────────────────────────────────────────────────

function credentialsOf(role: SeedRole): { username: string; password: string } {
  assert.ok('credentials' in seedCredentials, 'missing' in seedCredentials ? missingCredentialsMessage(seedCredentials.missing) : '');
  return seedCredentials.credentials[role];
}

const seedHint =
  'The user may not exist yet or has another password: stop the dev server (npm run dev:stop), ' +
  'run `npm run seed:users`, then run the tests again.';

/** Signs in as a seeded user; fails with what to do when the running server does not know the user. */
async function signInAs(role: SeedRole): Promise<{ username: string }> {
  const { username, password } = credentialsOf(role);
  const state = await authApi.setAuthState({ action: 'signIn', username, password });
  assert.strictEqual(state.state, 'signedIn', `Could not sign in as the ${role} user from ${seedEnvFile} (${state.error ?? 'no error'}). ${seedHint}`);
  return { username };
}

test('auth: the seeded user signs in and out', async () => {
  const { username, password } = credentialsOf('admin');

  const wrong = await authApi.setAuthState({ action: 'signIn', username, password: `${password}-wrong` });
  assert.strictEqual(wrong.state, 'signedOut');
  assert.ok(wrong.error, 'expected a wrong password to be rejected');

  const signedIn = await authApi.setAuthState({ action: 'signIn', username, password });
  assert.strictEqual(
    signedIn.state,
    'signedIn',
    `Could not sign in as the admin user from ${seedEnvFile} (${signedIn.error ?? 'no error'}). ${seedHint}`,
  );
  assert.strictEqual(signedIn.user?.username, username);
  assert.deepStrictEqual(signedIn.actions.map((action) => action.name), ['signOut']);

  const current = await authApi.getAuthState();
  assert.strictEqual(current.state, 'signedIn');
  assert.strictEqual(current.user?.username, username);

  const signedOut = await authApi.setAuthState({ action: 'signOut' });
  assert.strictEqual(signedOut.state, 'signedOut');
  assert.strictEqual((await authApi.getAuthState()).state, 'signedOut');
});

test('auth: a rejected action while signed in keeps the session and reports it', async () => {
  const seeded = credentialsOf('admin');
  const { username, password } = probe();

  const signedIn = await authApi.setAuthState({ action: 'signIn', ...seeded });
  assert.strictEqual(signedIn.state, 'signedIn');
  try {
    const signUp = await authApi.setAuthState({ action: 'signUp', username, password });
    // @ts-expect-error — deliberately outside the typed action union
    const unknownAction = await authApi.setAuthState({ action: 'createAdmin', username, password });
    for (const result of [signUp, unknownAction]) {
      assert.ok(result.error, 'expected an error message');
      assert.strictEqual(result.state, 'signedIn');
      assert.strictEqual(result.user?.username, seeded.username);
    }
    const current = await authApi.getAuthState();
    assert.strictEqual(current.state, 'signedIn');
    assert.strictEqual(current.user?.username, seeded.username);
  } finally {
    await authApi.setAuthState({ action: 'signOut' });
  }
  const afterSignOut = await authApi.setAuthState({ action: 'signIn', username, password });
  assert.strictEqual(afterSignOut.state, 'signedOut');
  assert.ok(afterSignOut.error, 'expected the rejected sign-up to have created no account');
});

// ─── Access: every `api` method ───────────────────────────────────────────────

// The typed client is a Proxy with only a `get` trap, so its methods cannot be listed at run time.
// This table holds the arguments of one call per method of `api`: a method added without an entry
// fails `npm run typecheck`, and the loops below call `api[name]` by key, so an entry cannot call
// another method. The tests below call each method signed out and as the denied user.
type ApiMethodName = keyof typeof ApiClientType;
const sampleMapContext: MapContext = { view: { center: [139.7, 35.7], zoom: 9 }, layers: [] };
// A well-formed conversation id nobody owns: the refusals of the two tests below then come from the access check, not from validation.
const unownedConversationId = randomUUID();
const apiArguments: { [K in ApiMethodName]: Parameters<(typeof ApiClientType)[K]> } = {
  getAppInfo: [],
  getDatasetSources: [],
  // A valid, uploadable name: the refusals of the two tests below then come from the access check, not from validation.
  createDatasetUpload: [uploadableFiles[0]],
  agentCreateConversationId: [],
  agentGetChannel: [unownedConversationId],
  agentStream: ['runQuery', unownedConversationId, sampleMapContext],
  agentResume: [unownedConversationId, [{ interruptId: 'x', response: '{}' }]],
  agentGetConversation: [unownedConversationId],
  agentGetPendingInterrupts: [unownedConversationId],
};
// What `requireAuth` throws for a caller without a session (the block's own status).
const unauthenticatedStatus = 401;
const apiMethodNames = Object.keys(apiArguments);
function isApiMethodName(name: string): name is ApiMethodName {
  return name in apiArguments;
}
async function callApi<K extends ApiMethodName>(name: K): Promise<void> {
  await api[name](...apiArguments[name]);
}
const apiCalls = apiMethodNames.filter(isApiMethodName);

const deniedHint =
  ` (the name in the denied-user variable may already be on a local list: stop the dev server, choose another name for the denied user, run \`npm run seed:users\`)`;

/** Runs a call that must be refused and returns the error. */
async function refusal(call: () => Promise<void>, what: string, hint = ''): Promise<ApiError> {
  try {
    await call();
  } catch (error) {
    assert.ok(error instanceof ApiError, `${what}: expected an ApiError`);
    return error;
  }
  return assert.fail(`${what}: expected the call to be refused, but it succeeded${hint}`);
}

test('access: a signed-out caller is refused by every api method', async () => {
  await authApi.setAuthState({ action: 'signOut' });
  assert.ok(apiMethodNames.length > 0);
  for (const method of apiCalls) {
    const error = await refusal(() => callApi(method), `signed out, api.${method}`);
    assert.strictEqual(error.status, unauthenticatedStatus, `api.${method}: expected ${unauthenticatedStatus}`);
    assert.strictEqual(error.name, AuthBasicErrors.SessionExpired, `api.${method}: expected the session error of requireAuth`);
  }
});

test('access: a signed-in user who is not on the allowed list is refused by every api method', async () => {
  const { username } = await signInAs('denied');
  try {
    for (const method of apiCalls) {
      const error = await refusal(() => callApi(method), `denied user, api.${method}`, deniedHint);
      assert.strictEqual(error.status, accessStatus.forbidden, `api.${method}: expected 403`);
      assert.strictEqual(error.name, accessErrors.NotAllowed, `api.${method}: expected the not-allowed error`);
    }
    const state = await authApi.getAuthState();
    assert.strictEqual(state.state, 'signedIn', 'a refusal must not sign the user out');
    assert.strictEqual(state.user?.username, username);
  } finally {
    await authApi.setAuthState({ action: 'signOut' });
  }
});

/** getAppInfo as a seeded user; a refusal says what to do when the running server has no lists. */
async function appInfoAs(role: SeedRole): Promise<Awaited<ReturnType<typeof api.getAppInfo>>> {
  await signInAs(role);
  try {
    return await api.getAppInfo();
  } catch (error) {
    if (error instanceof ApiError && error.name === accessErrors.NotAllowed) {
      assert.fail(
        `The ${role} user is not on the allowed list of the running dev server. ` +
          'Stop the dev server (npm run dev:stop), run `npm run seed:users`, then run the tests again.',
      );
    }
    throw error;
  } finally {
    await authApi.setAuthState({ action: 'signOut' });
  }
}

for (const role of ['allowed', 'admin'] as const) {
  test(`access: the ${role} user gets a valid getAppInfo answer`, async () => {
    const info = await appInfoAs(role);
    assert.ok(llmModes.some((mode) => mode === info.llmMode), `unexpected llmMode: ${info.llmMode}`);
    // A server this run started has AGENT_LOCAL_MODEL=canned; a server that was already running may use either.
    if (startedServer) assert.strictEqual(info.llmMode, testLlmMode);
  });
}

// ─── Datasets: signed URLs ────────────────────────────────────────────────────

/** Runs `body` signed in as the role and always signs out afterwards. */
async function asRole<T>(role: SeedRole, body: () => Promise<T>): Promise<T> {
  await signInAs(role);
  try {
    return await body();
  } finally {
    await authApi.setAuthState({ action: 'signOut' });
  }
}

test('datasets: an allowed user gets signed download URLs for every dataset and the wasm file', async () => {
  const before = Date.now();
  const sources = await asRole('allowed', () => api.getDatasetSources());
  const after = Date.now();

  assert.deepStrictEqual(sources.sources.map((source) => source.id), datasetIds);
  const urls = [...sources.sources.map((source) => source.url), sources.wasmUrl];
  for (const url of urls) {
    assert.ok(url.length > 0, 'expected a non-empty URL');
    assert.doesNotThrow(() => new URL(url), 'expected a URL that parses');
  }
  assert.strictEqual(new Set(urls).size, urls.length, 'expected every URL to be different');

  // The server cuts the time down to the whole second (under one second lost) and signs after `before`, so
  // the expiry is within one second below `before + TTL` and never above `after + TTL`.
  assert.ok(sources.expiresAt >= before + signedUrlTtlMs - millisecondsPerSecond, 'expiresAt is earlier than now plus the TTL minus a second');
  assert.ok(sources.expiresAt <= after + signedUrlTtlMs, 'expiresAt is later than now plus the TTL');
});

// ─── Datasets: upload URLs are for admins ─────────────────────────────────────

test('datasets: an allowed user who is not an admin is refused an upload URL, valid name or not', async () => {
  const names = [uploadableFiles[0], 'unknown.parquet', '../municipalities.parquet', ''];
  await asRole('allowed', async () => {
    for (const name of names) {
      const error = await refusal(async () => { await api.createDatasetUpload(name); }, `allowed user, createDatasetUpload(${JSON.stringify(name)})`);
      assert.strictEqual(error.status, accessStatus.forbidden);
      assert.strictEqual(error.name, accessErrors.AdminRequired);
    }
  });
});

test('datasets: an admin is refused an upload URL for a name that may not be uploaded', async () => {
  const [first] = uploadableFiles;
  const names = [
    'unknown.parquet',
    `../${first}`,
    `a/${first}`,
    first.toUpperCase(),
    ` ${first}`,
    '',
    'a'.repeat(10_000),
  ];
  await asRole('admin', async () => {
    for (const name of names) {
      const error = await refusal(async () => { await api.createDatasetUpload(name); }, `admin, createDatasetUpload(a name of ${name.length} characters)`);
      assert.strictEqual(error.status, uploadStatus.badRequest);
      assert.strictEqual(error.name, uploadErrors.InvalidFile);
      assert.ok(name === '' || !error.message.includes(name), 'the message must not echo the input');
    }
  });
});

test('datasets: an admin gets an upload URL for each uploadable file and uploads nothing', async () => {
  await asRole('admin', async () => {
    for (const name of uploadableFiles) {
      const { url } = await api.createDatasetUpload(name);
      assert.ok(url.length > 0, `expected a URL for ${name}`);
      assert.doesNotThrow(() => new URL(url), `expected a URL that parses for ${name}`);
    }
  });
});

// ─── Datasets: the round trip of an upload ────────────────────────────────────
//
// `createDatasetUpload` accepts only the real file names, so these tests use one of them (the first dataset file).
// They need no data files: the fixture is random bytes. The object is put back as it was found; when there was none,
// the API has no delete, so the fixture stays and the test says so (`npm run data:upload` replaces it).

const roundTripFile = datasetFileNames[0];
const fixtureSizeBytes = 2_048;
// What the local mock answers for an object that does not exist (read from the block's file server: a GET with a
// valid token for a key without content). Any other failed download fails the test.
const absentStatus = 404;
const absentErrorCode = 'NoSuchKey';
const absentBodySchema = z.object({ error: z.string() });
/** What the mock answers for a PUT whose Content-Type is not the one signed into the URL. */
const wrongContentTypeStatus = 403;
const otherContentType = 'text/plain';

type StoredObject = { bytes: Buffer<ArrayBuffer>; contentType: string | null };

function requiredContentType(name: string): string {
  const contentType = uploadContentType(name);
  assert.ok(contentType !== undefined, `expected a content type for ${name}`);
  return contentType;
}

/** The current object of `name`, read through a signed download URL of an allowed user; undefined when it is absent. */
async function readObject(name: string): Promise<StoredObject | undefined> {
  const sources = await asRole('allowed', () => api.getDatasetSources());
  const found = sources.sources.find((source) => datasetFileName(source.id) === name);
  assert.ok(found !== undefined, `expected a download URL for ${name}`);
  const response = await plainFetch(found.url);
  if (response.ok) return { bytes: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get('content-type') };
  const body = absentBodySchema.safeParse(await response.json().catch(() => undefined));
  const isAbsent = response.status === absentStatus && body.success && body.data.error === absentErrorCode;
  assert.ok(isAbsent, `downloading ${name}: HTTP ${response.status} is not the answer for an absent object`);
  return undefined;
}

/** The admin's upload URL for `name`, used for one PUT. The URL is never put in a message. */
async function putObject(name: string, contentType: string | undefined, bytes: Uint8Array<ArrayBuffer>): Promise<Response> {
  const { url } = await asRole('admin', () => api.createDatasetUpload(name));
  return plainFetch(url, { method: 'PUT', headers: contentType === undefined ? {} : { 'Content-Type': contentType }, body: bytes });
}

function assertSameObject(actual: StoredObject | undefined, expected: StoredObject | undefined, what: string): void {
  if (expected === undefined) return assert.strictEqual(actual, undefined, `${what}: expected the object to be absent`);
  assert.ok(actual !== undefined, `${what}: expected the object to be there`);
  assert.ok(actual.bytes.equals(expected.bytes), `${what}: the bytes differ`);
  assert.strictEqual(actual.contentType, expected.contentType, `${what}: the content type differs`);
}

/** Puts the original object back and checks it; returns what went wrong, or undefined. Notes it when there was no original. */
async function restoreOriginal(original: StoredObject | undefined): Promise<string | undefined> {
  if (original === undefined) {
    console.log(`Note: ${roundTripFile} was absent in the local bucket and now holds the test's random bytes (the API has no delete). Run \`npm run data:upload\` to put the real file there.`);
    return undefined;
  }
  try {
    const restored = await putObject(roundTripFile, requiredContentType(roundTripFile), original.bytes);
    assert.ok(restored.ok, `putting the original back: the PUT answered HTTP ${restored.status}`);
    assertSameObject(await readObject(roundTripFile), original, 'after putting the original back');
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : 'putting the original back failed';
  }
}

test('datasets: an uploaded object comes back with the same bytes and content type, and the original is put back', async () => {
  const contentType = requiredContentType(roundTripFile);
  const fixture = new Uint8Array(randomBytes(fixtureSizeBytes));
  const original = await readObject(roundTripFile);
  let bodyFailed = false;
  try {
    const put = await putObject(roundTripFile, contentType, fixture);
    assert.ok(put.ok, `the PUT answered HTTP ${put.status}`);
    assertSameObject(await readObject(roundTripFile), { bytes: Buffer.from(fixture), contentType }, 'after the upload');
  } catch (error) {
    bodyFailed = true;
    throw error;
  } finally {
    const restoreFailure = await restoreOriginal(original);
    if (restoreFailure !== undefined) {
      // The first failure must stay the one that is reported: the restore failure is shown beside it, not instead of it.
      if (!bodyFailed) assert.fail(restoreFailure);
      console.error(`The test failed above, and putting the original back failed too: ${restoreFailure}`);
    }
  }
});

test('datasets: a PUT with another or no Content-Type is refused and leaves the object as it was', async () => {
  assert.notStrictEqual(otherContentType, requiredContentType(roundTripFile));
  const before = await readObject(roundTripFile);
  const fixture = new Uint8Array(randomBytes(fixtureSizeBytes));
  for (const contentType of [otherContentType, undefined]) {
    const put = await putObject(roundTripFile, contentType, fixture);
    assert.strictEqual(put.status, wrongContentTypeStatus, `a PUT with ${contentType === undefined ? 'no' : 'another'} Content-Type answered HTTP ${put.status}`);
    assertSameObject(await readObject(roundTripFile), before, 'after the refused PUT');
  }
});

// ─── Conversation API (canned model) ──────────────────────────────────────────

// These tests need the canned model: with Bedrock the model would choose the tool itself.
// A server this run did not start may run Bedrock; `startedServer` is only known once the setup has run.
const cannedOnlyMessage = 'a server this run did not start may run Bedrock';

const waitMs = 30_000;
const pollMs = 100;

type ChunkWatcher = {
  chunks: AgentStreamChunk[];
  /** Resolves with the first chunk (from the start) that satisfies `matches`; fails after `waitMs`. */
  next(matches: (chunk: AgentStreamChunk) => boolean, what: string): Promise<AgentStreamChunk>;
  stop(): void;
};

/** Subscribes to the conversation's channel as the browser does (the handle `agentGetChannel` returns) and waits until it is established. */
async function watchChannel(conversationId: string): Promise<ChunkWatcher> {
  const { channel } = await api.agentGetChannel(conversationId);
  const chunks: AgentStreamChunk[] = [];
  const subscription = channel.subscribe((chunk) => chunks.push(chunk));
  await subscription.established;
  return {
    chunks,
    async next(matches, what) {
      const deadline = Date.now() + waitMs;
      for (;;) {
        const found = chunks.find(matches);
        if (found) return found;
        const failure = chunks.find((chunk) => chunk.type === 'error');
        if (failure) assert.fail(`${what}: the turn failed (${failure.error})`);
        if (Date.now() > deadline) assert.fail(`${what}: nothing arrived within ${waitMs} ms (got ${chunks.map((chunk) => chunk.type).join(', ') || 'no chunks'})`);
        await setTimeout(pollMs);
      }
    },
    stop: () => subscription.unsubscribe(),
  };
}

// What the browser answers per tool (valid results of each tool).
const validAnswers: Record<ToolName, string> = {
  runQuery: JSON.stringify({ ok: true, data: { columns: [{ name: 'n', type: 'number' }], rows: [{ n: 1 }], rowCount: 1, truncated: false } }),
  addLayer: JSON.stringify({
    ok: true,
    data: {
      layerId: 'L1',
      name: '駅',
      featureCount: 1,
      geometryType: 'point',
      columns: [{ name: 'station_name', type: 'string' }],
      bbox: [139, 35, 140, 36],
      applied: { type: 'single', color: '#e41a1c' },
    },
  }),
  setLayerStyle: JSON.stringify({ ok: true, data: { layerId: 'L1', applied: { type: 'single', color: '#e41a1c' } } }),
  setLayerLabel: JSON.stringify({ ok: true, data: { layerId: 'L1', label: null } }),
  removeLayer: JSON.stringify({ ok: true, data: { removed: 'L1', remaining: [] } }),
  setView: JSON.stringify({ ok: true, data: { center: [139.7, 35.7], zoom: 9 } }),
};

type Interrupts = NonNullable<AgentStreamChunk['interrupts']>;

/**
 * The canned model calls a tool when its name, or one of the words of its name, appears in the message. The message
 * carries `<map_state>` with a `view` key, so it also calls `setView`: the interrupts arrive in one chunk and are
 * answered together, as the browser does. The first message calls `runQuery`, the second `addLayer`.
 */
const cannedMessage = 'runQuery を実行して';
const cannedLayerMessage = 'addLayer を実行して';

async function nextInterrupts(watcher: ChunkWatcher): Promise<Interrupts> {
  const chunk = await watcher.next((candidate) => candidate.type === 'interrupt', 'waiting for the interrupt');
  const interrupts = chunk.interrupts ?? [];
  assert.ok(interrupts.length > 0, 'expected at least one interrupt');
  return interrupts;
}

/** The interrupt's reason is the request the browser executes: it must parse as a `ClientToolRequest` (4.4 relies on it). */
function requestOf(interrupt: Interrupts[number]): ClientToolRequest {
  return clientToolRequestSchema.parse(interrupt.reason);
}

const answersTo = (interrupts: Interrupts): { interruptId: string; response: string }[] =>
  interrupts.map((interrupt) => ({ interruptId: interrupt.id, response: validAnswers[requestOf(interrupt).tool] }));

/** The tool-result rows of a conversation as `{ toolName, output }`. */
async function toolResults(conversationId: string): Promise<{ toolName: string; output: string }[]> {
  const { messages } = await api.agentGetConversation(conversationId);
  return messages
    .filter((message) => message.role === 'tool-result')
    .map((message) => ({ toolName: String(message.metadata.toolName), output: JSON.stringify(message.metadata.toolOutput) }));
}

const untrustedMarker = '<untrusted-data';

test('agent: a full round trip through the canned model: tool calls, interrupts, resume, done', async (t) => {
  if (!startedServer) return t.skip(cannedOnlyMessage);
  await asRole('allowed', async () => {
    const { conversationId } = await api.agentCreateConversationId();
    assert.match(conversationId, /^[0-9a-f-]{36}$/);
    const watcher = await watchChannel(conversationId);
    try {
      const { channelId } = await api.agentStream(cannedMessage, conversationId, sampleMapContext);
      assert.strictEqual(channelId, conversationId, 'the channel is named after the conversation');

      const interrupts = await nextInterrupts(watcher);
      const tools = interrupts.map((interrupt) => requestOf(interrupt).tool);
      assert.ok(tools.includes('runQuery'), `expected a runQuery interrupt (got ${tools.join(', ')})`);
      for (const interrupt of interrupts) assert.ok(interrupt.name.startsWith(interruptName(requestOf(interrupt).tool)));

      const pending = await api.agentGetPendingInterrupts(conversationId);
      assert.deepStrictEqual(pending.interrupts.map(({ id }) => id).sort(), interrupts.map(({ id }) => id).sort());

      await api.agentResume(conversationId, answersTo(interrupts));
      const done = await watcher.next((chunk) => chunk.type === 'done', 'waiting for done');
      assert.ok(done.text, 'expected a final text');
    } finally {
      watcher.stop();
    }

    assert.deepStrictEqual((await api.agentGetPendingInterrupts(conversationId)).interrupts, []);
    const { messages } = await api.agentGetConversation(conversationId);
    const user = messages.find((message) => message.role === 'user');
    assert.ok(user, 'expected the user message in the history');
    assert.ok(user.content.includes('<map_state>'), 'the map context travels with the message');
    assert.strictEqual(stripMapState(user.content), cannedMessage);
    assert.ok(messages.some((message) => message.role === 'assistant'));

    // A second turn on the same conversation calls addLayer.
    const second = await watchChannel(conversationId);
    try {
      await api.agentStream(cannedLayerMessage, conversationId, sampleMapContext);
      const layerInterrupts = await nextInterrupts(second);
      assert.ok(layerInterrupts.some((interrupt) => requestOf(interrupt).tool === 'addLayer'), 'expected an addLayer interrupt');
      await api.agentResume(conversationId, answersTo(layerInterrupts));
      await second.next((chunk) => chunk.type === 'done', 'waiting for done of the second turn');
    } finally {
      second.stop();
    }

    // The tools that carry dataset values reach the model wrapped as untrusted data; the others are not.
    const results = await toolResults(conversationId);
    const untrusted = new Set(['runQuery', 'addLayer', 'setLayerStyle']);
    for (const toolName of ['runQuery', 'addLayer', 'setView']) assert.ok(results.some((result) => result.toolName === toolName), `expected a ${toolName} result`);
    for (const { toolName, output } of results) {
      assert.strictEqual(output.includes(untrustedMarker), untrusted.has(toolName), `${toolName}: untrusted wrapping`);
    }
    assert.ok(results.find((result) => result.toolName === 'runQuery')?.output.includes('rowCount'), 'the runQuery answer reached the model');
  });
});

// The canned model calls a tool when a word of its name is in the message (the word "Style" for `setLayerStyle`, and so on).
// `setView` comes with each of them through the map context's `view` key.
for (const { tool, message } of [
  { tool: 'setLayerStyle', message: 'Style を変えて' },
  { tool: 'setLayerLabel', message: 'Label を変えて' },
  { tool: 'removeLayer', message: 'remove して' }
] as const) {
  test(`agent: the canned ${tool} call reaches the browser as an interrupt that parses as a request, and its answer completes the turn`, async (t) => {
    if (!startedServer) return t.skip(cannedOnlyMessage);
    await asRole('allowed', async () => {
      const { conversationId } = await api.agentCreateConversationId();
      const watcher = await watchChannel(conversationId);
      try {
        await api.agentStream(message, conversationId, sampleMapContext);
        const interrupts = await nextInterrupts(watcher);
        const tools = interrupts.map((interrupt) => requestOf(interrupt).tool);
        assert.ok(tools.includes(tool), `expected a ${tool} interrupt (got ${tools.join(', ')})`);
        await api.agentResume(conversationId, answersTo(interrupts));
        await watcher.next((chunk) => chunk.type === 'done', 'waiting for done');
      } finally {
        watcher.stop();
      }
      assert.ok((await toolResults(conversationId)).some((result) => result.toolName === tool), `expected a ${tool} result`);
    });
  });
}

test('agent: a forged, repeated or already answered interrupt id is a 409 that starts nothing', async (t) => {
  if (!startedServer) return t.skip(cannedOnlyMessage);
  await asRole('allowed', async () => {
    const { conversationId } = await api.agentCreateConversationId();
    const watcher = await watchChannel(conversationId);
    try {
      await api.agentStream(cannedMessage, conversationId, sampleMapContext);
      const interrupts = await nextInterrupts(watcher);
      const [first] = answersTo(interrupts);

      const conflict = async (responses: typeof first[], what: string) => {
        const error = await refusal(async () => { await api.agentResume(conversationId, responses); }, what);
        assert.strictEqual(error.status, conversationStatus.conflict, `${what}: expected 409`);
        assert.strictEqual(error.name, conversationErrors.InterruptNotPending);
      };
      await conflict([{ interruptId: 'forged', response: first.response }], 'a forged id');
      await conflict([first, first], 'a repeated id');
      await conflict([first, { interruptId: 'forged', response: first.response }], 'a forged id among real ones');
      const stream = await refusal(async () => { await api.agentStream('もう一度', conversationId, sampleMapContext); }, 'a message while interrupts are pending');
      assert.strictEqual(stream.status, conversationStatus.conflict);
      assert.strictEqual(stream.name, conversationErrors.InterruptsPending);

      // The refusals left the paused turn as it was: the pending interrupts are still there and a correct answer completes it.
      const stillPending = await api.agentGetPendingInterrupts(conversationId);
      assert.deepStrictEqual(stillPending.interrupts.map(({ id }) => id).sort(), interrupts.map(({ id }) => id).sort());
      await api.agentResume(conversationId, answersTo(interrupts));
      await watcher.next((chunk) => chunk.type === 'done', 'waiting for done');

      // After done, the same answers again are refused and no model turn starts.
      const before = (await api.agentGetConversation(conversationId)).messages.length;
      await conflict(answersTo(interrupts), 'a replay after done');
      assert.strictEqual((await api.agentGetConversation(conversationId)).messages.length, before, 'a refused replay adds nothing');
      assert.deepStrictEqual((await api.agentGetPendingInterrupts(conversationId)).interrupts, []);
    } finally {
      watcher.stop();
    }
  });
});

test('agent: an answer that is not a valid result still completes the turn (a tool error for the model, no crash)', async (t) => {
  if (!startedServer) return t.skip(cannedOnlyMessage);
  await asRole('allowed', async () => {
    const { conversationId } = await api.agentCreateConversationId();
    const watcher = await watchChannel(conversationId);
    try {
      await api.agentStream(cannedMessage, conversationId, sampleMapContext);
      const interrupts = await nextInterrupts(watcher);
      await api.agentResume(conversationId, interrupts.map(({ id }) => ({ interruptId: id, response: 'not json' })));
      await watcher.next((chunk) => chunk.type === 'done', 'waiting for done');
    } finally {
      watcher.stop();
    }
    assert.ok((await toolResults(conversationId)).some((result) => result.output.includes('ENGINE_UNAVAILABLE')), 'the model got a tool error');
  });
});

// The SQL guard's short-circuit (a rejected SQL answers SQL_REJECTED without an interrupt) is tested in
// `aws-blocks/agent-tools.test.ts`: the canned model gives each tool one fixed, valid input (`aws-blocks/agent-canned.ts`),
// so a rejected SQL cannot be arranged through the running server.

/** What the calls below answer (they are awaited for their refusal, and the answer is dropped). */
type ApiResult = object | void;

/** The calls of the conversation API for an id, each with arguments that would pass validation. */
const conversationCalls: { [name: string]: (conversationId: string) => Promise<ApiResult> } = {
  agentGetChannel: (id) => api.agentGetChannel(id),
  agentStream: (id) => api.agentStream('runQuery', id, sampleMapContext),
  agentResume: (id) => api.agentResume(id, [{ interruptId: 'x', response: '{}' }]),
  agentGetConversation: (id) => api.agentGetConversation(id),
  agentGetPendingInterrupts: (id) => api.agentGetPendingInterrupts(id),
};

test("agent: another user cannot subscribe to, stream to, resume, read or list the interrupts of someone else's conversation", async () => {
  const conversationId = await asRole('allowed', async () => (await api.agentCreateConversationId()).conversationId);
  await asRole('admin', async () => {
    for (const [name, call] of Object.entries(conversationCalls)) {
      const error = await refusal(async () => { await call(conversationId); }, `another user, api.${name}`);
      assert.strictEqual(error.status, conversationStatus.notFound, `api.${name}: expected 404`);
      assert.strictEqual(error.name, conversationErrors.NotFound, `api.${name}: expected the not-found error`);
      assert.ok(!error.message.includes(conversationId), `api.${name}: the message must not echo the id`);
    }
    // The other user's own conversation list is not where the first one's conversation is.
    const mine = (await api.agentCreateConversationId()).conversationId;
    assert.notStrictEqual(mine, conversationId);
  });
  // The owner is unaffected by the refused attempts: nothing was started on the conversation.
  await asRole('allowed', async () => {
    assert.deepStrictEqual((await api.agentGetPendingInterrupts(conversationId)).interrupts, []);
    assert.deepStrictEqual((await api.agentGetConversation(conversationId)).messages, []);
  });
});

test('agent: a conversation that does not exist is a 404, the same as one that is not yours', async () => {
  await asRole('allowed', async () => {
    for (const [name, call] of Object.entries(conversationCalls)) {
      const error = await refusal(async () => { await call(randomUUID()); }, `unknown conversation, api.${name}`);
      assert.strictEqual(error.status, conversationStatus.notFound, `api.${name}: expected 404`);
    }
  });
});

test('agent: a missing or malformed conversation id is rejected with 400', async () => {
  await asRole('allowed', async () => {
    const ids = [undefined, null, '', 'L1', '../x', 'a'.repeat(10_000), `${randomUUID()}x`];
    for (const [name, call] of Object.entries(conversationCalls)) {
      for (const id of ids) {
        // @ts-expect-error — deliberately outside the argument type
        const error = await refusal(async () => { await call(id); }, `api.${name}(${JSON.stringify(id)?.slice(0, 20)})`);
        assert.strictEqual(error.status, conversationStatus.badRequest, `api.${name}(${JSON.stringify(id)?.slice(0, 20)}): expected 400`);
        assert.strictEqual(error.name, conversationErrors.InvalidRequest);
      }
    }
  });
});

test('agent: arguments over their limits are rejected with 400 and start nothing', async () => {
  await asRole('allowed', async () => {
    const { conversationId } = await api.agentCreateConversationId();
    const layers = Array.from({ length: mapConfig.summaryMaxBytes / 10 }, (_, n) => ({ id: `L${n}`, name: 'name' }));
    const tooManyBytes = (size: number): string => 'a'.repeat(size);
    const oversize: { what: string; call: () => Promise<ApiResult> }[] = [
      { what: 'an empty message', call: () => api.agentStream('', conversationId, sampleMapContext) },
      { what: 'a blank message', call: () => api.agentStream('  \n ', conversationId, sampleMapContext) },
      { what: 'a message over the limit', call: () => api.agentStream('a'.repeat(agentConfig.maxUtteranceChars + 1), conversationId, sampleMapContext) },
      { what: 'a map context over the byte limit', call: () => api.agentStream('駅', conversationId, { ...sampleMapContext, layers }) },
      // @ts-expect-error — deliberately outside the type
      { what: 'a map context of the wrong shape', call: () => api.agentStream('駅', conversationId, { view: 1, layers: [] }) },
      { what: 'no responses', call: () => api.agentResume(conversationId, []) },
      {
        what: 'more responses than the limit',
        call: () => api.agentResume(conversationId, Array.from({ length: agentConfig.maxInterruptResponses + 1 }, (_, n) => ({ interruptId: `id${n}`, response: '{}' }))),
      },
      { what: 'a response over the byte limit', call: () => api.agentResume(conversationId, [{ interruptId: 'x', response: tooManyBytes(resultConfig.maxToolResultBytes + 1) }]) },
      {
        what: 'responses over the total limit',
        call: () =>
          api.agentResume(
            conversationId,
            Array.from({ length: resultConfig.maxTotalResultBytes / resultConfig.maxToolResultBytes + 1 }, (_, n) => ({ interruptId: `id${n}`, response: tooManyBytes(resultConfig.maxToolResultBytes) })),
          ),
      },
    ];
    for (const { what, call } of oversize) {
      const error = await refusal(async () => { await call(); }, what);
      assert.strictEqual(error.status, conversationStatus.badRequest, `${what}: expected 400`);
      assert.strictEqual(error.name, conversationErrors.InvalidRequest, `${what}: expected the invalid-request error`);
    }
    assert.deepStrictEqual((await api.agentGetConversation(conversationId)).messages, [], 'a refused call must start no turn');
  });
});

test('datasets: the tests above leave no session behind', async () => {
  assert.strictEqual((await authApi.getAuthState()).state, 'signedOut');
});
