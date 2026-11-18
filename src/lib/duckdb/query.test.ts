import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryConfig } from '../../../shared/config';
import { datasetIds } from '../../../shared/datasets';
import type { GeometryFamily } from '../../../shared/mapSpec';
import { validateSql } from '../../../shared/sqlGuard';
import { createQueries, type RawBatch, type ResultReader, type SqlConnection } from './query';
import type { RawCell } from './values';

type Field = [name: string, typeName: string, scale?: number];
type Reply = { fields: Field[]; rows: RawCell[][] };
type Handler = (sql: string) => Reply | Promise<Reply | 'hang'> | 'hang';

function readerOf({ fields, rows }: Reply): ResultReader {
  const batches: RawBatch[] = [];
  for (let start = 0; start < rows.length; start += 2) {
    const chunk = rows.slice(start, start + 2);
    batches.push({ numRows: chunk.length, getChildAt: (index) => ({ get: (row) => chunk[row][index] }) });
  }
  return {
    open: async () => ({}),
    schema: { fields: fields.map(([name, typeName, scale]) => ({ name, type: { toString: () => typeName, scale } })) },
    async *[Symbol.asyncIterator]() {
      for (const batch of batches) yield batch;
    }
  };
}

const describeReply = (columns: [string, string][]): Reply => ({
  fields: [['column_name', 'Utf8'], ['column_type', 'Utf8']],
  rows: columns
});

type FakeConnection = SqlConnection & { sent: string[]; cancelled: number };

function fakeConnection(handler: Handler, options: { onCancel?: () => void } = {}): FakeConnection {
  const connection: FakeConnection = {
    sent: [],
    cancelled: 0,
    send: async (sql) => {
      connection.sent.push(sql);
      const reply = await handler(sql);
      if (reply === 'hang') return new Promise<ResultReader>(() => undefined);
      return readerOf(reply);
    },
    cancelSent: async () => {
      connection.cancelled += 1;
      options.onCancel?.();
      return true;
    }
  };
  return connection;
}

const [first] = datasetIds;
const geomPoint = (lon: number, lat: number) => JSON.stringify({ type: 'Point', coordinates: [lon, lat] });
/** A layer: DESCRIBE says there is a geometry; the wrapper returns the rows. */
const layerHandler =
  (rows: RawCell[][], fields: Field[] = [['name', 'Utf8'], ['__geojson', 'Utf8']]): Handler =>
  (sql) =>
    sql.startsWith('DESCRIBE') ? describeReply([['name', 'VARCHAR'], ['geom', 'GEOMETRY']]) : { fields, rows };

function setup(handler: Handler, extra: { connections?: FakeConnection[]; ensureViews?: (ids: readonly string[]) => Promise<void>; restart?: () => Promise<void>; geometryTypeOf?: (id: string) => GeometryFamily | undefined } = {}) {
  const connection = fakeConnection(handler);
  const connections = extra.connections ?? [connection];
  let current = 0;
  let restarting = false;
  // As the engine: the end of a session (a restart, a sign-out) is announced to whoever waits for it.
  const ends = new Map<FakeConnection, () => void>();
  const endPromises = new Map<FakeConnection, Promise<void>>();
  const endPromiseOf = (target: FakeConnection): Promise<void> => {
    let promise = endPromises.get(target);
    if (promise === undefined) {
      promise = new Promise<void>((resolve) => ends.set(target, resolve));
      endPromises.set(target, promise);
    }
    return promise;
  };
  // As the engine's `whenEnded`: the waits that are neither cancelled nor resolved by the end of their session.
  const waiters = new Map<FakeConnection, Set<object>>();
  const endSession = (target: FakeConnection): void => {
    void endPromiseOf(target);
    waiters.delete(target);
    ends.get(target)?.();
  };
  const sessionEnded = vi.fn((target: FakeConnection) => {
    const waiter = {};
    const open = waiters.get(target) ?? new Set<object>();
    open.add(waiter);
    waiters.set(target, open);
    return { ended: endPromiseOf(target), cancel: () => waiters.get(target)?.delete(waiter) };
  });
  const openWaiters = (): number => [...waiters.values()].reduce((count, open) => count + open.size, 0);
  const calls: string[] = [];
  const restartedWith: FakeConnection[] = [];
  const ensureViews = vi.fn(extra.ensureViews ?? (async () => undefined));
  const restart = vi.fn(extra.restart ?? (async () => undefined));
  const queries = createQueries<FakeConnection>({
    getConnection: async () => {
      // As the engine: while a restart is under way there is no connection to give.
      if (restarting) throw new Error('The data engine is not ready');
      return connections[Math.min(current, connections.length - 1)];
    },
    ensureViews: async (ids) => {
      calls.push('ensureViews');
      await ensureViews(ids);
    },
    sessionEnded,
    restart: async (stuck) => {
      calls.push('restart');
      restartedWith.push(stuck);
      endSession(stuck);
      restarting = true;
      try {
        await restart();
      } finally {
        restarting = false;
      }
      current += 1;
    },
    validate: (sql) => validateSql(sql, datasetIds),
    geometryTypeOf: extra.geometryTypeOf ?? (() => 'point'),
    timeouts: { timeoutMs: queryConfig.timeoutMs, cancelGraceMs: queryConfig.cancelGraceMs }
  });
  return {
    queries,
    connection,
    connections,
    ensureViews,
    restart,
    restartedWith,
    calls,
    endSession,
    sessionEnded,
    openWaiters,
    use: (index: number) => (current = index)
  };
}

describe('the guard', () => {
  it('rejects SQL the guard rejects, in both functions, before anything else happens', async () => {
    const { queries, connection, ensureViews } = setup(() => 'hang');
    const layer = await queries.queryLayer('DROP TABLE stations');
    const table = await queries.queryTable('DELETE FROM stations', 5);
    expect(layer).toMatchObject({ ok: false, error: { code: 'SQL_REJECTED' } });
    expect(table).toMatchObject({ ok: false, error: { code: 'SQL_REJECTED' } });
    if (!layer.ok) expect(layer.error.message).toBe('The statement must start with SELECT or WITH.');
    expect(connection.sent).toEqual([]);
    expect(ensureViews).not.toHaveBeenCalled();
  });

  it('registers the views of the guard, then runs the text of the guard', async () => {
    const { queries, connection, ensureViews, calls } = setup(layerHandler([['a', geomPoint(1, 2)]]));
    const result = await queries.queryLayer(`SELECT * FROM ${first} -- note\n;`);
    expect(result.ok).toBe(true);
    expect(ensureViews).toHaveBeenCalledWith([first]);
    expect(calls[0]).toBe('ensureViews');
    expect(connection.sent[0]).toBe(`DESCRIBE SELECT * FROM (SELECT * FROM ${first}) AS q`);
    expect(connection.sent.join('\n')).not.toContain('note');
  });
});

describe('queryLayer', () => {
  it('wraps the SQL as the design says', async () => {
    const { queries, connection } = setup(layerHandler([['a', geomPoint(1, 2)]]));
    await queries.queryLayer(`SELECT name, geom FROM ${first}`);
    expect(connection.sent[1]).toBe(
      `SELECT * EXCLUDE ("geom"), ST_AsGeoJSON("geom") AS __geojson FROM (SELECT name, geom FROM ${first}) AS q LIMIT ${queryConfig.maxFeaturesPerLayer + 1}`
    );
  });

  it('answers the layer: features, family, attribute columns, count and bbox', async () => {
    const { queries } = setup(layerHandler([['a', geomPoint(139, 35)], ['b', geomPoint(140, 36)]]));
    const result = await queries.queryLayer(`SELECT * FROM ${first}`);
    expect(result).toEqual({
      ok: true,
      data: {
        features: {
          type: 'FeatureCollection',
          features: [
            { type: 'Feature', id: 0, geometry: { type: 'Point', coordinates: [139, 35] }, properties: { name: 'a' } },
            { type: 'Feature', id: 1, geometry: { type: 'Point', coordinates: [140, 36] }, properties: { name: 'b' } }
          ]
        },
        geometryType: 'point',
        columns: [{ name: 'name', type: 'string' }],
        featureCount: 2,
        bbox: [139, 35, 140, 36]
      }
    });
  });

  it('answers NO_GEOMETRY, naming the contract, when there is no geom column or it is not a geometry', async () => {
    const withoutGeometry: [string, string][][] = [[['name', 'VARCHAR']], [['name', 'VARCHAR'], ['geom', 'VARCHAR']]];
    for (const columns of withoutGeometry) {
      const { queries, connection } = setup(() => describeReply(columns));
      const result = await queries.queryLayer(`SELECT name FROM ${first}`);
      expect(result).toMatchObject({ ok: false, error: { code: 'NO_GEOMETRY', message: 'The query must return the geometry as a column named geom.' } });
      expect(connection.sent).toHaveLength(1);
    }
  });

  it('accepts a geometry type that carries a coordinate system', async () => {
    const { queries } = setup((sql) => (sql.startsWith('DESCRIBE') ? describeReply([['geom', "GEOMETRY('OGC:CRS84')"]]) : { fields: [['__geojson', 'Utf8']], rows: [[geomPoint(1, 2)]] }));
    expect(await queries.queryLayer(`SELECT geom FROM ${first}`)).toMatchObject({ ok: true });
  });

  it('accepts exactly the maximum of features and refuses one more', async () => {
    const max = queryConfig.maxFeaturesPerLayer;
    const rowsOf = (count: number): RawCell[][] => Array.from({ length: count }, () => ['x', geomPoint(1, 2)]);
    const atMax = await setup(layerHandler(rowsOf(max))).queries.queryLayer(`SELECT * FROM ${first}`);
    expect(atMax).toMatchObject({ ok: true, data: { featureCount: max } });
    const over = await setup(layerHandler(rowsOf(max + 1))).queries.queryLayer(`SELECT * FROM ${first}`);
    expect(over).toMatchObject({ ok: false, error: { code: 'TOO_MANY_FEATURES', message: 'The query returned more than 100000 features.' } });
    if (!over.ok) expect(over.error.hint).toBeDefined();
  });

  it('answers MIXED_GEOMETRY naming the families', async () => {
    const line = JSON.stringify({ type: 'LineString', coordinates: [[0, 0], [1, 1]] });
    const result = await setup(layerHandler([['a', geomPoint(1, 2)], ['b', line]])).queries.queryLayer(`SELECT * FROM ${first}`);
    expect(result).toMatchObject({ ok: false, error: { code: 'MIXED_GEOMETRY' } });
    if (!result.ok) expect(result.error.message).toContain('points and lines');
  });

  it('drops a NULL geometry', async () => {
    const result = await setup(layerHandler([['a', null], ['b', geomPoint(1, 2)]])).queries.queryLayer(`SELECT * FROM ${first}`);
    expect(result).toMatchObject({ ok: true, data: { featureCount: 1 } });
  });

  it('answers an empty layer of the view type when one view is referenced', async () => {
    const { queries } = setup(layerHandler([]), { geometryTypeOf: (id) => (id === first ? 'polygon' : undefined) });
    expect(await queries.queryLayer(`SELECT * FROM ${first} WHERE false`)).toEqual({
      ok: true,
      data: { features: { type: 'FeatureCollection', features: [] }, geometryType: 'polygon', columns: [{ name: 'name', type: 'string' }], featureCount: 0, bbox: [0, 0, 0, 0] }
    });
  });

  it('answers NO_GEOMETRY for an empty result of several views, or of none', async () => {
    const [, second] = datasetIds;
    const several = await setup(layerHandler([])).queries.queryLayer(`SELECT a.* FROM ${first} a, ${second} b WHERE false`);
    expect(several).toMatchObject({ ok: false, error: { code: 'NO_GEOMETRY', message: 'The query returned no features.' } });
    const none = await setup(layerHandler([])).queries.queryLayer('SELECT ST_Point(1, 2) AS geom WHERE false');
    expect(none).toMatchObject({ ok: false, error: { code: 'NO_GEOMETRY', message: 'The query returned no features.' } });
  });

  it('turns every kind of value into JSON in the properties', async () => {
    const fields: Field[] = [['n', 'Int64'], ['d', 'Decimal[18e+2]', 2], ['t', 'Timestamp<MICROSECOND>'], ['__geojson', 'Utf8']];
    const rows: RawCell[][] = [[12n, { toString: () => '1234' }, Date.UTC(2024, 0, 2), geomPoint(1, 2)]];
    const result = await setup(layerHandler(rows, fields)).queries.queryLayer(`SELECT * FROM ${first}`);
    expect(result).toMatchObject({
      ok: true,
      data: {
        columns: [{ name: 'n', type: 'number' }, { name: 'd', type: 'number' }, { name: 't', type: 'other' }],
        features: { features: [{ properties: { n: 12, d: 12.34, t: '2024-01-02T00:00:00.000' } }] }
      }
    });
  });
});

describe('queryTable', () => {
  const tableHandler = (rows: RawCell[][]): Handler => (sql) =>
    sql.startsWith('DESCRIBE')
      ? describeReply([['pref_name', 'VARCHAR'], ['geom', 'GEOMETRY'], ['we"ird', 'BIGINT']])
      : { fields: [['pref_name', 'Utf8'], ['geom', 'Utf8'], ['we"ird', 'Int64']], rows };

  it('replaces each geometry column by its type name and quotes the identifiers', async () => {
    const { queries, connection } = setup(tableHandler([['a', 'POINT', 1n]]));
    const result = await queries.queryTable(`SELECT * FROM ${first}`, 5);
    expect(connection.sent[1]).toBe(`SELECT "pref_name", CAST(ST_GeometryType("geom") AS VARCHAR) AS "geom", "we""ird" FROM (SELECT * FROM ${first}) AS q LIMIT 6`);
    expect(result).toEqual({
      ok: true,
      data: {
        columns: [{ name: 'pref_name', type: 'string' }, { name: 'geom', type: 'string' }, { name: 'we"ird', type: 'number' }],
        rows: [{ pref_name: 'a', geom: 'POINT', 'we"ird': 1 }],
        truncated: false
      }
    });
  });

  it('selects everything when there is no geometry column', async () => {
    const { queries, connection } = setup((sql) => (sql.startsWith('DESCRIBE') ? describeReply([['n', 'BIGINT']]) : { fields: [['n', 'Int64']], rows: [[1n]] }));
    await queries.queryTable(`SELECT 1 AS n FROM ${first}`, 5);
    expect(connection.sent[1]).toBe(`SELECT * FROM (SELECT 1 AS n FROM ${first}) AS q LIMIT 6`);
  });

  it('returns maxRows rows and says it is truncated when one more came back', async () => {
    const rows: RawCell[][] = Array.from({ length: 6 }, (_, index) => [`p${index}`, 'POLYGON', 1n]);
    const result = await setup(tableHandler(rows)).queries.queryTable(`SELECT * FROM ${first}`, 5);
    expect(result).toMatchObject({ ok: true, data: { truncated: true } });
    if (result.ok) expect(result.data.rows).toHaveLength(5);
    const exact = await setup(tableHandler(rows.slice(0, 5))).queries.queryTable(`SELECT * FROM ${first}`, 5);
    expect(exact).toMatchObject({ ok: true, data: { truncated: false } });
  });

  it('caps maxRows at the configured maximum, and asks for at least one row', async () => {
    const { queries, connection } = setup(tableHandler([]));
    await queries.queryTable(`SELECT * FROM ${first}`, 5000);
    expect(connection.sent[1]).toMatch(new RegExp(`LIMIT ${queryConfig.maxRows + 1}$`));
    await queries.queryTable(`SELECT * FROM ${first}`, 0);
    expect(connection.sent[3]).toMatch(/LIMIT 2$/);
  });

  it('returns the columns of a query with no row', async () => {
    const result = await setup(tableHandler([])).queries.queryTable(`SELECT * FROM ${first}`, 5);
    expect(result).toMatchObject({ ok: true, data: { rows: [], truncated: false, columns: [{ name: 'pref_name' }, { name: 'geom' }, { name: 'we"ird' }] } });
  });
});

describe('errors', () => {
  const failing = (message: string): Handler => () => {
    throw new Error(message);
  };

  it('answers SQL_ERROR with the first line and a hint for the usual mistakes', async () => {
    const cases: [string, string | undefined][] = [
      ['Binder Error: Referenced column "nope" not found in FROM clause!\nCandidate bindings: "a"', 'Check the column names in the catalog.'],
      ['Catalog Error: Table with name foo does not exist!\nDid you mean "stations"?', 'Use only the views and the allowed functions.'],
      ['Catalog Error: Scalar Function with name bar does not exist!', 'Use only the views and the allowed functions.'],
      ['Conversion Error: Could not convert string "x" to INT32', 'Check the types; cast explicitly.'],
      ['Parser Error: syntax error at or near "FROM"', undefined]
    ];
    for (const [message, hint] of cases) {
      const result = await setup(failing(message)).queries.queryTable(`SELECT * FROM ${first}`, 5);
      expect(result).toMatchObject({ ok: false, error: { code: 'SQL_ERROR', message: message.split('\n')[0] } });
      if (!result.ok) expect(result.error.hint).toBe(hint);
    }
  });

  it('removes URLs and cuts the message at 300 characters', async () => {
    const withUrl = await setup(failing('IO Error: Could not read https://bucket.test/a.parquet?X-Amz-Signature=secret now')).queries.queryLayer(`SELECT * FROM ${first}`);
    expect(withUrl).toMatchObject({ ok: false, error: { message: 'IO Error: Could not read [URL] now' } });
    const long = await setup(failing(`Binder Error: ${'x'.repeat(500)}`)).queries.queryLayer(`SELECT * FROM ${first}`);
    if (!long.ok) expect(long.error.message).toHaveLength(queryConfig.maxErrorChars + 1);
    const empty = await setup(failing('')).queries.queryLayer(`SELECT * FROM ${first}`);
    expect(empty).toMatchObject({ ok: false, error: { code: 'SQL_ERROR', message: 'The query failed.' } });
  });

  it('answers an error that the stream raises while it is read', async () => {
    const connection = fakeConnection(() => describeReply([['geom', 'GEOMETRY']]));
    connection.send = async (sql) => {
      if (sql.startsWith('DESCRIBE')) return readerOf(describeReply([['geom', 'GEOMETRY']]));
      return {
        open: async () => ({}),
        schema: { fields: [] },
        // eslint-disable-next-line require-yield
        async *[Symbol.asyncIterator]() {
          throw new Error('Out of Memory Error: boom');
        }
      };
    };
    const result = await setup(() => 'hang', { connections: [connection] }).queries.queryLayer(`SELECT geom FROM ${first}`);
    expect(result).toMatchObject({ ok: false, error: { code: 'SQL_ERROR', message: 'Out of Memory Error: boom' } });
  });

  it('answers ENGINE_UNAVAILABLE when the engine is not ready, without waiting', async () => {
    const queries = createQueries<FakeConnection>({
      getConnection: async () => {
        throw new Error('The data engine is not ready');
      },
      ensureViews: async () => undefined,
      restart: async () => undefined,
      sessionEnded: () => ({ ended: new Promise<void>(() => undefined), cancel: () => undefined }),
      validate: (sql) => validateSql(sql, datasetIds),
      geometryTypeOf: () => 'point',
      timeouts: { timeoutMs: 1000, cancelGraceMs: 1000 }
    });
    expect(await queries.queryLayer(`SELECT * FROM ${first}`)).toMatchObject({ ok: false, error: { code: 'ENGINE_UNAVAILABLE', message: 'The data engine is not ready.' } });
    expect(await queries.queryTable(`SELECT * FROM ${first}`, 5)).toMatchObject({ ok: false, error: { code: 'ENGINE_UNAVAILABLE' } });
  });

  it('answers ENGINE_UNAVAILABLE when the data cannot be loaded, SESSION_RESET when the engine restarted under it', async () => {
    const failed = await setup(layerHandler([]), {
      ensureViews: async () => {
        throw new Error('Failed to fetch dataset stations: HTTP 500 https://x.test/a?sig=1');
      }
    }).queries.queryLayer(`SELECT * FROM ${first}`);
    expect(failed).toMatchObject({ ok: false, error: { code: 'ENGINE_UNAVAILABLE', message: 'The data could not be loaded: Failed to fetch dataset stations: HTTP 500 [URL]' } });
    const restarted = await setup(layerHandler([]), {
      ensureViews: async () => {
        throw new Error('The data engine was restarted');
      }
    }).queries.queryLayer(`SELECT * FROM ${first}`);
    expect(restarted).toMatchObject({ ok: false, error: { code: 'SESSION_RESET' } });
  });
});

describe('the queue', () => {
  it('runs one query at a time, in the order they arrived', async () => {
    const events: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler: Handler = async (sql) => {
      const name = sql.includes('first_marker') ? 'first' : 'second';
      events.push(`start ${name}`);
      if (name === 'first') await gate;
      events.push(`end ${name}`);
      return sql.startsWith('DESCRIBE') ? describeReply([['geom', 'GEOMETRY']]) : { fields: [['__geojson', 'Utf8']], rows: [[geomPoint(1, 2)]] };
    };
    const { queries } = setup(handler);
    const a = queries.queryLayer(`SELECT geom, 1 AS first_marker FROM ${first}`);
    const b = queries.queryLayer(`SELECT geom FROM ${first}`);
    await vi.waitFor(() => expect(events).toEqual(['start first']));
    // The second query does not start while the first one waits.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(['start first']);
    release();
    await Promise.all([a, b]);
    expect(events).toEqual(['start first', 'end first', 'start first', 'end first', 'start second', 'end second', 'start second', 'end second']);
  });

  it('answers SESSION_RESET to a query that waited while the session was replaced', async () => {
    vi.useFakeTimers();
    try {
      const stuck = fakeConnection(() => 'hang');
      const fresh = fakeConnection(layerHandler([['a', geomPoint(1, 2)]]));
      const { queries, restart } = setup(() => 'hang', { connections: [stuck, fresh] });
      const slow = queries.queryLayer(`SELECT geom FROM ${first}`);
      const waiting = queries.queryLayer(`SELECT geom FROM ${first}`);
      await vi.advanceTimersByTimeAsync(queryConfig.timeoutMs + queryConfig.cancelGraceMs);
      expect(await slow).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
      expect(await waiting).toMatchObject({ ok: false, error: { code: 'SESSION_RESET', message: 'The data engine was restarted; run the query again.' } });
      expect(restart).toHaveBeenCalledTimes(1);
      // A query sent now runs on the new connection.
      expect(await queries.queryLayer(`SELECT geom FROM ${first}`)).toMatchObject({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('timeout and cancellation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The wrapper statement hangs until `settle()`; DESCRIBE answers. */
  function slowLayer() {
    let settle: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const connection = fakeConnection(async (sql) => {
      if (sql.startsWith('DESCRIBE')) return describeReply([['geom', 'GEOMETRY']]);
      await settled;
      throw new Error('INTERRUPT Error: Interrupted!');
    });
    return { connection, settle };
  }

  it('cancels at the timeout, and a query that settles in the grace period answers TIMEOUT without a restart', async () => {
    const { connection, settle } = slowLayer();
    const { queries, restart } = setup(() => 'hang', { connections: [connection] });
    const result = queries.queryLayer(`SELECT geom FROM ${first}`);
    await vi.advanceTimersByTimeAsync(queryConfig.timeoutMs - 1);
    expect(connection.cancelled).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(connection.cancelled).toBe(1);
    settle();
    expect(await result).toEqual({
      ok: false,
      error: { code: 'TIMEOUT', message: 'The query took longer than 30 s.', hint: 'Filter, aggregate or simplify the query.' }
    });
    expect(restart).not.toHaveBeenCalled();
    // The timers are gone: no late restart.
    await vi.advanceTimersByTimeAsync(queryConfig.cancelGraceMs * 2);
    expect(restart).not.toHaveBeenCalled();
  });

  it('restarts the engine when the cancelled query does not settle in the grace period', async () => {
    const connection = fakeConnection((sql) => (sql.startsWith('DESCRIBE') ? describeReply([['geom', 'GEOMETRY']]) : 'hang'));
    const { queries, restart, calls } = setup(() => 'hang', { connections: [connection] });
    const result = queries.queryLayer(`SELECT geom FROM ${first}`);
    await vi.advanceTimersByTimeAsync(queryConfig.timeoutMs);
    expect(restart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(queryConfig.cancelGraceMs);
    expect(await result).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
    expect(connection.cancelled).toBe(1);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['ensureViews', 'restart']);
  });

  it('restarts when cancelSent itself never answers (a dead worker)', async () => {
    const connection = fakeConnection(() => 'hang');
    connection.cancelSent = () => new Promise<boolean>(() => undefined);
    const { queries, restart } = setup(() => 'hang', { connections: [connection] });
    const result = queries.queryTable(`SELECT * FROM ${first}`, 5);
    await vi.advanceTimersByTimeAsync(queryConfig.timeoutMs + queryConfig.cancelGraceMs);
    expect(await result).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('answers TIMEOUT even when the restart fails', async () => {
    const { queries } = setup(() => 'hang', {
      restart: async () => {
        throw new Error('no worker');
      }
    });
    const result = queries.queryTable(`SELECT * FROM ${first}`, 5);
    await vi.advanceTimersByTimeAsync(queryConfig.timeoutMs + queryConfig.cancelGraceMs);
    expect(await result).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
  });

  it('takes the timeouts of the overrides (and names them in the message)', async () => {
    const connection = fakeConnection(() => 'hang');
    const { queries, restart } = setup(() => 'hang', { connections: [connection] });
    const result = queries.queryTable(`SELECT * FROM ${first}`, 5, { timeoutMs: 2000, cancelGraceMs: 1000 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(connection.cancelled).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({ ok: false, error: { code: 'TIMEOUT', message: 'The query took longer than 2 s.' } });
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('does not time out a query that answers in time', async () => {
    const { queries, connection } = setup(layerHandler([['a', geomPoint(1, 2)]]));
    const result = queries.queryLayer(`SELECT * FROM ${first}`);
    expect(await result).toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(queryConfig.timeoutMs * 2);
    expect(connection.cancelled).toBe(0);
  });
});

describe('columns other than geom in a layer', () => {
  const wrapperOf = async (columns: [string, string][], sql = `SELECT * FROM ${first}`) => {
    const { queries, connection } = setup((statement) =>
      statement.startsWith('DESCRIBE') ? describeReply(columns) : { fields: [['__geojson', 'Utf8']], rows: [[geomPoint(1, 2)]] }
    );
    await queries.queryLayer(sql);
    return connection.sent[1];
  };

  it('replaces another geometry column by its type name (a join that yields geom and geom_1)', async () => {
    const wrapper = await wrapperOf([['name', 'VARCHAR'], ['geom', 'GEOMETRY'], ['geom_1', 'GEOMETRY']]);
    expect(wrapper).toBe(
      `SELECT * EXCLUDE ("geom") REPLACE (CAST(ST_GeometryType("geom_1") AS VARCHAR) AS "geom_1"), ST_AsGeoJSON("geom") AS __geojson FROM (SELECT * FROM ${first}) AS q LIMIT ${queryConfig.maxFeaturesPerLayer + 1}`
    );
  });

  it('leaves BLOB columns out, and writes TIME and INTERVAL columns as text', async () => {
    const wrapper = await wrapperOf([['geom', 'GEOMETRY'], ['raw', 'BLOB'], ['t', 'TIME'], ['tz', 'TIME WITH TIME ZONE'], ['iv', 'INTERVAL'], ['ts', 'TIMESTAMP']]);
    expect(wrapper).toContain('EXCLUDE ("geom", "raw")');
    expect(wrapper).toContain('REPLACE (CAST("t" AS VARCHAR) AS "t", CAST("tz" AS VARCHAR) AS "tz", CAST("iv" AS VARCHAR) AS "iv")');
    expect(wrapper).not.toContain('"ts"');
  });

  it('writes TIME and INTERVAL columns of a table as text as well', async () => {
    const { queries, connection } = setup((statement) =>
      statement.startsWith('DESCRIBE') ? describeReply([['t', 'TIME'], ['n', 'BIGINT']]) : { fields: [['t', 'Utf8'], ['n', 'Int64']], rows: [['12:34:56', 1n]] }
    );
    const result = await queries.queryTable(`SELECT * FROM ${first}`, 5);
    expect(connection.sent[1]).toBe(`SELECT CAST("t" AS VARCHAR) AS "t", "n" FROM (SELECT * FROM ${first}) AS q LIMIT 6`);
    expect(result).toMatchObject({ ok: true, data: { rows: [{ t: '12:34:56', n: 1 }] } });
  });

  it('answers SQL_ERROR, not a rejected promise, when the geom column holds text that is not GeoJSON', async () => {
    const result = await setup(layerHandler([['a', 'not json']])).queries.queryLayer(`SELECT * FROM ${first}`);
    expect(result).toMatchObject({ ok: false, error: { code: 'SQL_ERROR' } });
  });
});

describe('one deadline per query', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers TIMEOUT when the views are not registered in time; the next query waits for that registration within its own deadline, so the queue moves on', async () => {
    // The fetch never settles. The real registry shares one in-flight fetch per file, so the next query would wait
    // for the same one: here that is the registration the queue waits for (and which times that query out in turn).
    const { queries, restart } = setup(layerHandler([['a', geomPoint(1, 2)]]), { ensureViews: () => new Promise<void>(() => undefined) });
    const stuck = queries.queryLayer(`SELECT * FROM ${first}`);
    const next = queries.queryLayer(`SELECT * FROM ${first}`);
    await vi.advanceTimersByTimeAsync(queryConfig.timeoutMs);
    expect(await stuck).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
    await vi.advanceTimersByTimeAsync(queryConfig.timeoutMs);
    expect(await next).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
    expect(restart).not.toHaveBeenCalled();
  });

  it('shares the time between the statements of one query', async () => {
    const connection = fakeConnection(async (statement) => {
      if (statement.startsWith('DESCRIBE')) {
        await new Promise((resolve) => setTimeout(resolve, 20_000));
        return describeReply([['geom', 'GEOMETRY']]);
      }
      return 'hang';
    });
    const { queries } = setup(() => 'hang', { connections: [connection] });
    const result = queries.queryLayer(`SELECT geom FROM ${first}`);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(connection.cancelled).toBe(0);
    // 10 s of the 30 s are left for the data statement.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(connection.cancelled).toBe(1);
    await vi.advanceTimersByTimeAsync(queryConfig.cancelGraceMs);
    expect(await result).toMatchObject({ ok: false, error: { code: 'TIMEOUT', message: 'The query took longer than 30 s.' } });
  });

  it('does not send a statement once the deadline has passed', async () => {
    const connection = fakeConnection(async (statement) => {
      await new Promise((resolve) => setTimeout(resolve, queryConfig.timeoutMs));
      return statement.startsWith('DESCRIBE') ? describeReply([['geom', 'GEOMETRY']]) : { fields: [['__geojson', 'Utf8']], rows: [] };
    });
    const { queries } = setup(() => 'hang', { connections: [connection] });
    const result = queries.queryLayer(`SELECT geom FROM ${first}`);
    await vi.advanceTimersByTimeAsync(queryConfig.timeoutMs * 2);
    expect(await result).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
    expect(connection.sent).toHaveLength(1);
  });
});

describe('the restart of a stuck connection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes the stuck connection to the restart', async () => {
    const connection = fakeConnection(() => 'hang');
    const { queries, restartedWith } = setup(() => 'hang', { connections: [connection] });
    const result = queries.queryTable(`SELECT * FROM ${first}`, 5);
    await vi.advanceTimersByTimeAsync(queryConfig.timeoutMs + queryConfig.cancelGraceMs);
    await result;
    expect(restartedWith).toEqual([connection]);
  });

  it('waits for the restart: a query that was queued behind the stuck one never runs on the old connection', async () => {
    const stuck = fakeConnection(() => 'hang');
    const fresh = fakeConnection(layerHandler([['a', geomPoint(1, 2)]]));
    const { queries } = setup(() => 'hang', {
      connections: [stuck, fresh],
      // A restart takes a while: until it is done the engine has no connection to give.
      restart: () => new Promise<void>((resolve) => setTimeout(resolve, 3000))
    });
    const slow = queries.queryLayer(`SELECT geom FROM ${first}`);
    const queued = queries.queryLayer(`SELECT geom FROM ${first}`);
    await vi.advanceTimersByTimeAsync(queryConfig.timeoutMs + queryConfig.cancelGraceMs + 3000);
    expect(await slow).toMatchObject({ error: { code: 'TIMEOUT' } });
    expect(await queued).toMatchObject({ ok: false, error: { code: 'SESSION_RESET' } });
    expect(stuck.sent).toHaveLength(1);
  });
});

describe('the end of the session', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers SESSION_RESET at once to a query still running when the engine shuts down, and does not delay the next one', async () => {
    const old = fakeConnection(() => 'hang');
    const next = fakeConnection(layerHandler([['a', geomPoint(1, 2)]]));
    const { queries, endSession, use, restart } = setup(() => 'hang', { connections: [old, next] });
    const running = queries.queryLayer(`SELECT geom FROM ${first}`);
    const startedAt = Date.now();
    await vi.advanceTimersByTimeAsync(1000);
    // Sign-out and a new sign-in: the old worker is gone, the next user has a new one.
    endSession(old);
    use(1);
    const fresh = queries.queryLayer(`SELECT geom FROM ${first}`);
    expect(await running).toMatchObject({ ok: false, error: { code: 'SESSION_RESET' } });
    expect(await fresh).toMatchObject({ ok: true });
    // No time passed beyond the 1 s: nothing waited for the timeout or the grace period.
    expect(Date.now() - startedAt).toBe(1000);
    expect(restart).not.toHaveBeenCalled();
  });

  it('answers SESSION_RESET to a query whose session had ended before it started', async () => {
    const old = fakeConnection(() => 'hang');
    const { queries, endSession } = setup(() => 'hang', { connections: [old] });
    endSession(old);
    expect(await queries.queryLayer(`SELECT geom FROM ${first}`)).toMatchObject({ ok: false, error: { code: 'SESSION_RESET' } });
  });
});

describe('a registration that outlives its query', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is finished before the next query sends anything: the statements are not interleaved', async () => {
    const connection = fakeConnection(layerHandler([['a', geomPoint(1, 2)]]));
    let finish: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let calls = 0;
    const { queries } = setup(() => 'hang', {
      connections: [connection],
      ensureViews: async () => {
        if (++calls > 1) return;
        // The registration of the first query: slow, then it sends its statements on the connection.
        await gate;
        connection.sent.push('CREATE VIEW (late)');
      }
    });
    const a = queries.queryLayer(`SELECT * FROM ${first}`);
    await vi.advanceTimersByTimeAsync(queryConfig.timeoutMs);
    expect(await a).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
    const b = queries.queryLayer(`SELECT * FROM ${first}`);
    await vi.advanceTimersByTimeAsync(1000);
    expect(connection.sent).toEqual([]);
    finish();
    expect(await b).toMatchObject({ ok: true });
    expect(connection.sent[0]).toBe('CREATE VIEW (late)');
    expect(connection.sent[1]).toMatch(/^DESCRIBE/);
  });

  it('times the next query out when the registration is still not done at its deadline', async () => {
    const connection = fakeConnection(layerHandler([]));
    let calls = 0;
    const { queries } = setup(() => 'hang', {
      connections: [connection],
      ensureViews: () => (++calls === 1 ? new Promise<void>(() => undefined) : Promise.resolve())
    });
    const a = queries.queryLayer(`SELECT * FROM ${first}`);
    await vi.advanceTimersByTimeAsync(queryConfig.timeoutMs);
    await a;
    const b = queries.queryLayer(`SELECT * FROM ${first}`);
    await vi.advanceTimersByTimeAsync(queryConfig.timeoutMs);
    expect(await b).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
    expect(connection.sent).toEqual([]);
  });
});

describe('late registrations belong to their session', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a fetch that hangs in a session that is over does not delay or time out a query on the new connection', async () => {
    const old = fakeConnection(() => 'hang');
    const fresh = fakeConnection(layerHandler([['a', geomPoint(1, 2)]]));
    const [, second] = datasetIds;
    const requested: string[] = [];
    const { queries, endSession, use } = setup(() => 'hang', {
      connections: [old, fresh],
      ensureViews: (ids) => {
        requested.push(ids.join(','));
        return requested.length === 1 ? new Promise<void>(() => undefined) : Promise.resolve();
      }
    });
    const hung = queries.queryLayer(`SELECT * FROM ${first}`);
    await vi.advanceTimersByTimeAsync(queryConfig.timeoutMs);
    expect(await hung).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
    // The user signs out and another one signs in: a new worker, a new connection.
    endSession(old);
    use(1);
    const result = await queries.queryLayer(`SELECT * FROM ${second}`);
    expect(result).toMatchObject({ ok: true });
    expect(requested).toEqual([first, second]);
    expect(fresh.sent.length).toBeGreaterThan(0);
    expect(old.sent).toEqual([]);
  });

  it('a job that lost its session while it waited for a late registration sends and registers nothing afterwards', async () => {
    const old = fakeConnection(() => 'hang');
    const fresh = fakeConnection(layerHandler([['a', geomPoint(1, 2)]]));
    let finish: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const requested: string[] = [];
    const { queries, endSession, use } = setup(() => 'hang', {
      connections: [old, fresh],
      ensureViews: (ids) => {
        requested.push(ids.join(','));
        return requested.length === 1 ? gate : Promise.resolve();
      }
    });
    const first_ = queries.queryLayer(`SELECT * FROM ${first}`);
    await vi.advanceTimersByTimeAsync(queryConfig.timeoutMs);
    await first_;
    const waiting = queries.queryLayer(`SELECT * FROM ${first}`);
    await vi.advanceTimersByTimeAsync(1000);
    endSession(old);
    use(1);
    expect(await waiting).toMatchObject({ ok: false, error: { code: 'SESSION_RESET' } });
    finish();
    await vi.advanceTimersByTimeAsync(1000);
    expect(requested).toEqual([first]);
    expect(fresh.sent).toEqual([]);
    expect(old.sent).toEqual([]);
  });
});

describe('each defence of the late registrations on its own', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not wait for a late registration of another connection, even before the end of its session is announced', async () => {
    const old = fakeConnection(() => 'hang');
    const fresh = fakeConnection(layerHandler([['a', geomPoint(1, 2)]]));
    const [, second] = datasetIds;
    let calls = 0;
    const { queries, use } = setup(() => 'hang', {
      connections: [old, fresh],
      ensureViews: () => (++calls === 1 ? new Promise<void>(() => undefined) : Promise.resolve())
    });
    const hung = queries.queryLayer(`SELECT * FROM ${first}`);
    await vi.advanceTimersByTimeAsync(queryConfig.timeoutMs);
    expect(await hung).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
    // The connection changed, but the old session's end has not been announced: only the keying keeps them apart.
    use(1);
    const result = queries.queryLayer(`SELECT * FROM ${second}`);
    await vi.advanceTimersByTimeAsync(queryConfig.timeoutMs);
    expect(await result).toMatchObject({ ok: true });
  });

  it('sends nothing for a job whose session ended during its registration, once the registration finishes', async () => {
    // The connection stays the engine's: only the check before each statement stops the abandoned job.
    const connection = fakeConnection(layerHandler([['a', geomPoint(1, 2)]]));
    let finish: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { queries, endSession } = setup(() => 'hang', { connections: [connection], ensureViews: () => gate });
    const result = queries.queryLayer(`SELECT * FROM ${first}`);
    await vi.advanceTimersByTimeAsync(1000);
    endSession(connection);
    expect(await result).toMatchObject({ ok: false, error: { code: 'SESSION_RESET' } });
    finish();
    await vi.advanceTimersByTimeAsync(1000);
    expect(connection.sent).toEqual([]);
  });

  it('leaves no watch on the session behind once a query is done', async () => {
    const { queries, sessionEnded, openWaiters } = setup(layerHandler([['a', geomPoint(1, 2)]]));
    expect(await queries.queryLayer(`SELECT * FROM ${first}`)).toMatchObject({ ok: true });
    expect(sessionEnded).toHaveBeenCalled();
    expect(openWaiters()).toBe(0);
  });

  it('stops watching the session and forgets the connection once its last late registration settles', async () => {
    const connection = fakeConnection(layerHandler([['a', geomPoint(1, 2)]]));
    const gates: (() => void)[] = [];
    let calls = 0;
    const { queries, openWaiters } = setup(() => 'hang', {
      connections: [connection],
      ensureViews: () =>
        ++calls > 2
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              gates.push(resolve);
            })
    });
    const a = queries.queryLayer(`SELECT * FROM ${first}`);
    await vi.advanceTimersByTimeAsync(queryConfig.timeoutMs);
    expect(await a).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
    // The late registration watches the end of its session.
    expect(openWaiters()).toBe(1);
    gates[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(openWaiters()).toBe(0);

    // The next late registration on the same connection makes a new entry with a new watch (an entry kept from before
    // would take it in without one).
    const b = queries.queryLayer(`SELECT * FROM ${first}`);
    await vi.advanceTimersByTimeAsync(queryConfig.timeoutMs);
    expect(await b).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
    expect(openWaiters()).toBe(1);
    gates[1]();
    await vi.advanceTimersByTimeAsync(0);
    expect(openWaiters()).toBe(0);
    expect(await queries.queryLayer(`SELECT * FROM ${first}`)).toMatchObject({ ok: true });
  });
});

describe('BLOB columns of a table', () => {
  it('shows <blob> (or NULL) in place of the bytes', async () => {
    const { queries, connection } = setup((statement) =>
      statement.startsWith('DESCRIBE') ? describeReply([['n', 'BIGINT'], ['raw', 'BLOB']]) : { fields: [['n', 'Int64'], ['raw', 'Utf8']], rows: [[1n, '<blob>']] }
    );
    const result = await queries.queryTable(`SELECT * FROM ${first}`, 5);
    expect(connection.sent[1]).toBe(`SELECT "n", CASE WHEN "raw" IS NULL THEN NULL ELSE '<blob>' END AS "raw" FROM (SELECT * FROM ${first}) AS q LIMIT 6`);
    expect(result).toMatchObject({ ok: true, data: { rows: [{ n: 1, raw: '<blob>' }] } });
  });
});
