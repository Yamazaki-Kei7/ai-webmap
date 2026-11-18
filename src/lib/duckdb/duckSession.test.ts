import { describe, expect, it, vi } from 'vitest';
import { createDuckSession, firstValue, type DuckDb, type QueryConnection } from './duckSession';

function table(value: string | number | bigint | null | undefined, rows = 1) {
  return { getChildAt: () => (rows === 0 ? { get: () => null } : { get: () => value }) };
}

function setup(options: { instantiate?: Promise<null>; ok?: boolean } = {}) {
  const connection: QueryConnection = { query: async () => table('x') };
  const db: DuckDb<QueryConnection> = {
    instantiate: vi.fn(() => options.instantiate ?? Promise.resolve(null)),
    open: vi.fn(async () => undefined),
    connect: vi.fn(async () => connection),
    registerFileBuffer: vi.fn(async () => undefined),
    terminate: vi.fn(async () => undefined)
  };
  const revoked: string[] = [];
  const session = createDuckSession({
    db,
    fetchFile: async () => ({ ok: options.ok ?? true, status: options.ok === false ? 404 : 200, blob: async () => new Blob(['wasm']) }),
    createObjectUrl: () => 'blob:wasm-1',
    revokeObjectUrl: (url) => revoked.push(url),
    onWorkerError: () => undefined
  });
  return { session, db, revoked };
}

describe('the wasm object URL', () => {
  it('is revoked once the module is instantiated', async () => {
    const { session, db, revoked } = setup();
    await session.load('https://files.test/wasm');
    expect(db.instantiate).toHaveBeenCalledWith('blob:wasm-1');
    expect(revoked).toEqual(['blob:wasm-1']);
  });

  it('is revoked when the session is terminated while the module is still being instantiated', async () => {
    const { session, db, revoked } = setup({ instantiate: new Promise(() => undefined) });
    void session.load('https://files.test/wasm');
    await vi.waitFor(() => expect(db.instantiate).toHaveBeenCalled());
    expect(revoked).toEqual([]);
    await session.terminate();
    expect(revoked).toEqual(['blob:wasm-1']);
    expect(db.terminate).toHaveBeenCalled();
  });

  it('is not made when the wasm cannot be fetched, and the error names the status only', async () => {
    const { session, db, revoked } = setup({ ok: false });
    await expect(session.load('https://files.test/wasm?sig=secret')).rejects.toThrow('HTTP 404');
    expect(db.instantiate).not.toHaveBeenCalled();
    expect(revoked).toEqual([]);
  });
});

describe('firstValue', () => {
  it('returns the value as text', async () => {
    expect(await firstValue({ query: async () => table(42) }, 'SELECT 42')).toBe('42');
  });

  it('is an error, not the text "undefined", when the query has no row or a NULL', async () => {
    await expect(firstValue({ query: async () => table(null, 0) }, 'SELECT 1 WHERE false')).rejects.toThrow('no value');
    await expect(firstValue({ query: async () => table(undefined) }, 'SELECT NULL')).rejects.toThrow('no value');
  });
});
