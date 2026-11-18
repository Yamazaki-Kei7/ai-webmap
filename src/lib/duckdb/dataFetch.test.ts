import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineConfig, queryConfig } from '../../../shared/config';
import { datasetIds } from '../../../shared/datasets';
import { validateSql } from '../../../shared/sqlGuard';
import { withDataFetchTimeout, type FetchInit } from './dataFetch';
import { createEngine, type EngineSession } from './engineCore';
import { createQueries, type RawBatch, type ResultReader, type SqlConnection } from './query';
import type { DataResponse, DatasetSources } from './sources';

const [first, second] = datasetIds;
const timeoutName = 'TimeoutError';
const timeoutText = 'signal timed out';

/** `AbortSignal.timeout` on the fake clock (the real one ignores it), aborted with the reason the browser gives. */
function fakeTimeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException(timeoutText, timeoutName)), ms);
  return controller.signal;
}

/** A promise that only the signal ends, as `fetch` and `arrayBuffer()` do when nothing arrives. */
function untilAborted<T>(signal: AbortSignal): Promise<T> {
  return new Promise<T>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason));
  });
}

const okFile = (): DataResponse => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4) });

/** The response never comes (`headers`), or it comes and its body never does (`body`). */
type Hang = 'headers' | 'body';

function hangingFile(signal: AbortSignal, hang: Hang): Promise<DataResponse> {
  if (hang === 'headers') return untilAborted(signal);
  return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => untilAborted<ArrayBuffer>(signal) });
}

/** One reply of the connection: one VARCHAR column, as DESCRIBE lists it or as the query returns it. */
function readerOf(fields: string[], rows: string[][]): ResultReader {
  const batch: RawBatch = { numRows: rows.length, getChildAt: (index) => ({ get: (row) => rows[row][index] }) };
  return {
    open: async () => ({}),
    schema: { fields: fields.map((name) => ({ name, type: { toString: () => 'Utf8' } })) },
    async *[Symbol.asyncIterator]() {
      yield batch;
    }
  };
}

type FakeConnection = SqlConnection & { sent: string[] };
type FakeSession = EngineSession & { statements: string[]; connection: () => FakeConnection };

function fakeSession(): FakeSession {
  const connection: FakeConnection = {
    sent: [],
    send: async (sql) => {
      connection.sent.push(sql);
      return sql.startsWith('DESCRIBE') ? readerOf(['column_name', 'column_type'], [['name', 'VARCHAR']]) : readerOf(['name'], [['a']]);
    },
    cancelSent: async () => true
  };
  const session: FakeSession = {
    statements: [],
    connection: () => connection,
    onError: () => undefined,
    load: async () => undefined,
    exec: async (sql) => {
      session.statements.push(sql);
    },
    scalar: async () => 'v1',
    registerFileBuffer: async () => undefined,
    terminate: async () => undefined
  };
  return session;
}

const sources: DatasetSources = {
  sources: datasetIds.map((id) => ({ id, url: `https://files.test/${id}` })),
  wasmUrl: 'https://files.test/wasm',
  expiresAt: Number.MAX_SAFE_INTEGER
};

/** The engine and the query layer wired as `engine.ts` wires them; the first fetch of `first` hangs. */
function setup(hang: Hang) {
  const fetched: string[] = [];
  const get = vi.fn((url: string, init: FetchInit): Promise<DataResponse> => {
    // As the real `fetch`: a signal that is already aborted rejects at once.
    if (init.signal.aborted) return Promise.reject(init.signal.reason);
    fetched.push(url);
    const hangs = url.endsWith(`/${first}`) && fetched.filter((seen) => seen === url).length === 1;
    return hangs ? hangingFile(init.signal, hang) : Promise.resolve(okFile());
  });
  const sessions: FakeSession[] = [];
  const engine = createEngine<FakeSession>({
    now: () => Date.now(),
    fetchSources: async () => sources,
    createSession: async () => {
      const session = fakeSession();
      sessions.push(session);
      return session;
    },
    fetchFile: withDataFetchTimeout(get),
    log: () => undefined
  });
  const queries = createQueries<FakeConnection>({
    getConnection: async () => (await engine.getSession()).connection(),
    ensureViews: (ids) => engine.ensureViews(ids),
    sessionEnded: (connection) => engine.whenEnded((session) => session.connection() === connection),
    restart: async (stuck) => {
      await engine.restartIfCurrent((session) => session.connection() === stuck);
    },
    validate: (sql) => validateSql(sql, datasetIds),
    geometryTypeOf: () => 'point',
    timeouts: { timeoutMs: queryConfig.timeoutMs, cancelGraceMs: queryConfig.cancelGraceMs }
  });
  const views = (id: string): string[] => sessions.flatMap((session) => session.statements).filter((sql) => sql.startsWith(`CREATE VIEW "${id}"`));
  const fetchesOf = (id: string): number => fetched.filter((url) => url.endsWith(`/${id}`)).length;
  return { engine, queries, get, views, fetchesOf, sessions };
}

describe('the data fetch timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(fakeTimeoutSignal);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('aborts a fetch that never settles after the configured time, not before', async () => {
    const get = vi.fn((_url: string, init: FetchInit) => untilAborted<DataResponse>(init.signal));
    const settled = vi.fn();
    const fetching = withDataFetchTimeout(get)(`https://files.test/${first}`);
    const failure = expect(fetching).rejects.toMatchObject({ name: timeoutName });
    void fetching.then(settled, settled);
    expect(AbortSignal.timeout).toHaveBeenCalledWith(engineConfig.dataFetchTimeoutMs);
    await vi.advanceTimersByTimeAsync(engineConfig.dataFetchTimeoutMs - 1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await failure;
  });

  it('gives each fetch its own signal: a fetch after an earlier one timed out still succeeds', async () => {
    const { engine, get, views, fetchesOf } = setup('headers');
    await engine.initEngine(() => undefined);
    const stuck = engine.ensureViews([first]);
    const failure = expect(stuck).rejects.toMatchObject({ name: timeoutName });
    await vi.advanceTimersByTimeAsync(engineConfig.dataFetchTimeoutMs);
    await failure;
    await engine.ensureViews([second]);
    expect(get.mock.calls[1][1].signal.aborted).toBe(false);
    expect(fetchesOf(second)).toBe(1);
    expect(views(second)).toHaveLength(1);
  });

  it.each<Hang>(['headers', 'body'])('ends a fetch that hangs in its %s, and the next ensureViews fetches the file again', async (hang) => {
    const { engine, views, fetchesOf } = setup(hang);
    await engine.initEngine(() => undefined);
    const stuck = engine.ensureViews([first]);
    const failure = expect(stuck).rejects.toMatchObject({ name: timeoutName });
    await vi.advanceTimersByTimeAsync(engineConfig.dataFetchTimeoutMs);
    await failure;
    expect(views(first)).toEqual([]);
    await engine.ensureViews([first]);
    expect(fetchesOf(first)).toBe(2);
    expect(views(first)).toHaveLength(1);
  });

  it('answers ENGINE_UNAVAILABLE to a query that waits for the aborted fetch itself', async () => {
    const { engine, queries } = setup('body');
    await engine.initEngine(() => undefined);
    // Only a query with a deadline beyond the fetch timeout sees the abort itself.
    const result = queries.queryTable(`SELECT * FROM ${first}`, 1, { timeoutMs: engineConfig.dataFetchTimeoutMs * 2 });
    await vi.advanceTimersByTimeAsync(engineConfig.dataFetchTimeoutMs);
    expect(await result).toMatchObject({
      ok: false,
      error: { code: 'ENGINE_UNAVAILABLE', message: `The data could not be loaded: ${timeoutText}` }
    });
  });

  it('lets a query on another dataset of the same session through once the hung fetch is aborted, and the file can be fetched again', async () => {
    const { engine, queries, views, fetchesOf, sessions } = setup('body');
    await engine.initEngine(() => undefined);
    const startedAt = Date.now();
    const hung = queries.queryTable(`SELECT * FROM ${first}`, 1);
    await vi.advanceTimersByTimeAsync(queryConfig.timeoutMs);
    expect(await hung).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });

    // Sent while the fetch still hangs, with a deadline after its abort: it waits for the late registration, then runs.
    await vi.advanceTimersByTimeAsync(engineConfig.dataFetchTimeoutMs - queryConfig.timeoutMs * 1.5);
    const other = queries.queryTable(`SELECT * FROM ${second}`, 1);
    let answeredAt: number | undefined;
    void other.then(() => {
      answeredAt = Date.now();
    });
    await vi.advanceTimersByTimeAsync(queryConfig.timeoutMs);
    expect(await other).toMatchObject({ ok: true, data: { rows: [{ name: 'a' }] } });
    expect(answeredAt).toBe(startedAt + engineConfig.dataFetchTimeoutMs);
    expect(views(second)).toHaveLength(1);

    expect(await queries.queryTable(`SELECT * FROM ${first}`, 1)).toMatchObject({ ok: true });
    expect(fetchesOf(first)).toBe(2);
    expect(views(first)).toHaveLength(1);
    expect(sessions).toHaveLength(1);
  });
});
