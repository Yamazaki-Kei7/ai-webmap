/**
 * Proves the record builder against the auth block itself, on the block's local mock store.
 * The mock keeps its data under `<cwd>/.bb-data/` (core `getMockDataDir`; there is no other setting), so the
 * working directory is moved to a throwaway directory in the OS temp directory before any block is built, and
 * restored and removed afterwards. The repository's own `.bb-data/` is never touched.
 * The guard against a future block version writing elsewhere: after the block's own sign-up, the first test asserts that
 * the block's data directory exists under the throwaway directory.
 * What this does NOT prove: the DynamoDB item itself (that is read from the AWS entry of the key-value block).
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthBasic, AuthBasicErrors, KVStore, Scope, type BlocksContext } from '@aws-blocks/blocks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { passwordPolicy } from '../../aws-blocks/password-policy.js';
import { decodeItemRecord, decodeRecordJson } from './test-support.js';
import { buildUserItem, keyAttribute, valueAttribute } from './user-record.js';

const mockDataDir = '.bb-data';
const mockStoreFile = 'store.json';
const authId = 'auth';
const usersId = 'users';
const now = new Date('2026-01-02T03:04:05.678Z');
const password = 'correct-horse-9';

let originalCwd = '';
let tempDir = '';
let counter = 0;

beforeAll(() => {
  originalCwd = process.cwd();
  tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'ai-webmap-user-record-')));
  process.chdir(tempDir);
  // The guard that matters: never build a mock store anywhere but the throwaway directory.
  expect(process.cwd()).toBe(tempDir);
});

afterAll(() => {
  process.chdir(originalCwd);
  rmSync(tempDir, { recursive: true, force: true });
});

/** A request context with the parts `signIn` touches; built without casts. */
function context(): BlocksContext {
  return {
    request: { headers: new Headers(), body: null, json: async () => ({}), text: async () => '', url: new URL('http://localhost/'), params: {} },
    response: { headers: new Headers(), status: 200, send: () => {} },
  };
}

/** A fresh app scope per test, so each test has its own mock store files inside the throwaway directory. */
function freshRoot(): Scope {
  counter += 1;
  return new Scope(`user-record-test-${counter}`);
}

/** The users store of the auth block built in `root`: same scope path, so the same store file as the block's own. */
function usersStoreOf(root: Scope): KVStore {
  return new KVStore(new Scope(authId, { parent: root }), usersId);
}

function newAuth(root: Scope): AuthBasic {
  return new AuthBasic(root, authId, { passwordPolicy });
}

describe('record builder against the auth block (local mock store)', () => {
  it('writes the same fields, with the same types, as the block signUp', async () => {
    const root = freshRoot();
    await newAuth(root).signUp('someone', password);
    // The guard: the block's store was created under the throwaway directory (a block that ignored the working directory would fail here).
    expect(existsSync(join(tempDir, mockDataDir, `${root.fullId}-${authId}-${usersId}`, mockStoreFile))).toBe(true);
    // Read back through the block's own key-value API (a store built after the write loads it from disk).
    const stored = await usersStoreOf(root).get('someone');
    if (stored === null) throw new Error('the block stored no record');
    const fromBlock = decodeRecordJson(stored);

    const built = await buildUserItem({ username: 'someone', password, now });
    if (!built.ok) throw new Error(built.message);
    const fromBuilder = decodeItemRecord(built.item);

    // strictObject in the decoder already rejects extra or missing fields; compare names and types explicitly too.
    expect(Object.keys(fromBuilder).sort()).toEqual(Object.keys(fromBlock).sort());
    for (const key of Object.keys(fromBlock)) {
      expect(typeof Reflect.get(fromBuilder, key)).toBe(typeof Reflect.get(fromBlock, key));
    }
    // Hashes carry the same bcrypt prefix and cost; the timestamps share the ISO format.
    expect(fromBuilder.hash.slice(0, 7)).toBe(fromBlock.hash.slice(0, 7));
    expect(fromBuilder.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(fromBlock.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('is stored by the mock under the same encoded text as the builder produces (the value attribute)', async () => {
    const root = freshRoot();
    await newAuth(root).signUp('someone', password);
    const built = await buildUserItem({ username: 'someone', password, now });
    if (!built.ok) throw new Error(built.message);
    const file = join(tempDir, mockDataDir, `${root.fullId}-${authId}-${usersId}`, mockStoreFile);
    const raw: Record<string, string> = JSON.parse(readFileSync(file, 'utf8'));
    // The mock holds `JSON.stringify(value)`, the AWS entry stores that same text in `value` (index.aws.ts line 99).
    expect(raw.someone.startsWith('"{')).toBe(true);
    expect(built.item[valueAttribute].S.startsWith('"{')).toBe(true);
    expect(Object.keys(decodeRecordJson(JSON.parse(raw.someone)))).toEqual(Object.keys(built.record));
  });

  it('lets the block sign in a user whose record the builder produced', async () => {
    const root = freshRoot();
    const built = await buildUserItem({ username: 'someone', password, now });
    if (!built.ok) throw new Error(built.message);
    // Put the builder's record into the store through the block's own API: the decoded `value` is what the block hands to the store.
    await usersStoreOf(root).put(built.item[keyAttribute].S, JSON.parse(built.item[valueAttribute].S));

    const auth = newAuth(root); // built after the write, so it loads the stored user
    const ctx = context();
    const user = await auth.signIn('someone', password, ctx);
    expect(user.username).toBe('someone');
    expect(user.createdAt).toBe(now.toISOString());
    expect(ctx.response.headers.get('Set-Cookie')).toContain('HttpOnly');
    await expect(auth.signIn('someone', `${password}x`, context())).rejects.toMatchObject({ name: AuthBasicErrors.InvalidCredentials });
  });

  it('keeps names exact: a user created as " a " cannot sign in as "a" or "A"', async () => {
    const root = freshRoot();
    const built = await buildUserItem({ username: ' a ', password, now });
    if (!built.ok) throw new Error(built.message);
    await usersStoreOf(root).put(built.item[keyAttribute].S, JSON.parse(built.item[valueAttribute].S));
    const auth = newAuth(root);
    expect((await auth.signIn(' a ', password, context())).username).toBe(' a ');
    for (const other of ['a', 'A']) {
      await expect(auth.signIn(other, password, context())).rejects.toMatchObject({ name: AuthBasicErrors.InvalidCredentials });
    }
  });

  it('refuses the same password the block signUp refuses, with the same message', async () => {
    const tooShort = 'abc1234';
    const fromBlock = await newAuth(freshRoot()).signUp('someone', tooShort).then(
      () => null,
      (error: Error) => error,
    );
    expect(fromBlock?.name).toBe(AuthBasicErrors.InvalidPassword);
    const built = await buildUserItem({ username: 'someone', password: tooShort, now });
    expect(built).toEqual({ ok: false, message: fromBlock?.message });
  });
});
