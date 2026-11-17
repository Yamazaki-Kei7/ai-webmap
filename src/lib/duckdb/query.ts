import { dataConfig, queryConfig } from '../../../shared/config';
import type { GeometryFamily } from '../../../shared/mapSpec';
import type { SqlGuardResult } from '../../../shared/sqlGuard';
import { toolError, type ClientToolResult } from '../../../shared/toolProtocol';
import { buildFeatureCollection, type FeatureRow } from './geojson';
import { sessionResetError, sqlError, timeoutError, unavailableError, viewsError, type FailedResult } from './queryErrors';
import type { JsonRow, LayerQueryResult, TableQueryResult } from './queryTypes';
import { columnInfoOf, convertCell, shapeOf, type ArrowTypeLike, type ColumnShape, type RawCell } from './values';

/** The part of an Arrow record batch a result is read from. */
export type RawBatch = { numRows: number; getChildAt: (index: number) => { get: (row: number) => RawCell } | null };

/** The stream `send` returns: the batches, and the schema (read after `open()`, so a query with no row has its columns too). */
export type ResultReader = AsyncIterable<RawBatch> & {
  open: () => Promise<object>;
  schema: { fields: readonly { name: string; type: ArrowTypeLike }[] };
};

/** The part of a DuckDB-WASM connection the queries use: `send` (not `query`) is what can be cancelled. */
export type SqlConnection = {
  send: (sql: string) => Promise<ResultReader>;
  cancelSent: () => Promise<boolean>;
};

export type QueryTimeouts = { timeoutMs: number; cancelGraceMs: number };

export type QueryDeps<Connection extends SqlConnection> = {
  /** Rejects while the engine is not ready. */
  getConnection: () => Promise<Connection>;
  ensureViews: (ids: readonly string[]) => Promise<void>;
  /** Terminates the worker of this (stuck) connection and starts a new one; does nothing when that worker is not the engine's any more. */
  restart: (stuck: Connection) => Promise<void>;
  /** Resolves when the worker of this connection is gone (sign-out, restart): a query on it is over. */
  sessionEnded: (connection: Connection) => { ended: Promise<void>; cancel: () => void };
  validate: (sql: string) => SqlGuardResult;
  /** The geometry type of a dataset's view. */
  geometryTypeOf: (id: string) => GeometryFamily | undefined;
  timeouts: QueryTimeouts;
};

export type Queries = {
  queryLayer: (sql: string, overrides?: Partial<QueryTimeouts>) => Promise<ClientToolResult<LayerQueryResult>>;
  queryTable: (sql: string, maxRows: number, overrides?: Partial<QueryTimeouts>) => Promise<ClientToolResult<TableQueryResult>>;
};

type Rows = { shapes: ColumnShape[]; rows: RawCell[][] };
type Outcome = { kind: 'rows'; rows: Rows } | { kind: 'failed'; result: FailedResult };

const geometryColumn = dataConfig.geoParquet.geometryColumn;
/** The column the wrapper adds: the geometry as GeoJSON text. */
const geoJsonColumn = '__geojson';
const geometryTypeName = 'GEOMETRY';

/** DuckDB names the type `GEOMETRY`, with a coordinate system in brackets when it has one. */
function isGeometry(type: string): boolean {
  return type.startsWith(geometryTypeName);
}

const noGeometryMessage = `The query must return the geometry as a column named ${geometryColumn}.`;
const noGeometryHint = `Select the geometry column as ${geometryColumn}.`;
const noFeaturesMessage = 'The query returned no features.';
const rejectedHint = 'Write one SELECT over the catalog views, with the allowed functions only.';

/** A column of the user's query, as `DESCRIBE` lists it. */
type DescribedColumn = { name: string; type: string };

/** Types the arrow reader cannot give as JSON values (a time of day, an interval): DuckDB writes them as text. */
const textTypes = /^(TIME|TIMETZ|TIME WITH TIME ZONE|INTERVAL)$/;

/**
 * BLOB values are never sent as bytes (a byte string is of no use to the model, and large): a layer leaves the column
 * out, a table shows `<blob>` (or NULL) in its place.
 */
function isBlob(type: string): boolean {
  return type === 'BLOB';
}

/** The expression that stands for a column in the result, when its value is not used as it is: a geometry is its type name, a time or interval is text. */
function replacementOf(column: DescribedColumn): string | undefined {
  const name = quoted(column.name);
  if (isGeometry(column.type)) return `CAST(ST_GeometryType(${name}) AS VARCHAR)`;
  if (textTypes.test(column.type)) return `CAST(${name} AS VARCHAR)`;
  if (isBlob(column.type)) return `CASE WHEN ${name} IS NULL THEN NULL ELSE '<blob>' END`;
  return undefined;
}

function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function ignore(): void {
  // The failure is reported elsewhere.
}

async function readRows(connection: SqlConnection, sql: string): Promise<Rows> {
  const reader = await connection.send(sql);
  await reader.open();
  const shapes = reader.schema.fields.map((field) => shapeOf(field.name, field.type));
  const rows: RawCell[][] = [];
  for await (const batch of reader) {
    const vectors = shapes.map((_, index) => batch.getChildAt(index));
    for (let row = 0; row < batch.numRows; row++) {
      rows.push(vectors.map((vector) => vector?.get(row)));
    }
  }
  return { shapes, rows };
}

function toJsonRow(raw: readonly RawCell[], shapes: readonly ColumnShape[]): JsonRow {
  const row: JsonRow = {};
  shapes.forEach((shape, index) => {
    row[shape.name] = convertCell(raw[index], shape);
  });
  return row;
}

/** The time one query may take, from the moment it leaves the queue (`ms` is what the message tells); `passed` once a statement ran into it. */
type Deadline = { at: number; ms: number; passed: boolean };

type Settled<T> = { settled: true; value: T } | { settled: false };

/** The late registrations of one connection, and the watch on the end of its session. */
type LateViews = { pending: Set<Promise<FailedResult | undefined>>; end: { ended: Promise<void>; cancel: () => void } };

/** The value of the promise, or `settled: false` when `ms` pass first. The timer is always cleared. */
async function raceTimer<T>(promise: Promise<T>, ms: number): Promise<Settled<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), ms);
  });
  try {
    return await Promise.race([promise.then((value): Settled<T> => ({ settled: true, value })), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The two query functions of the engine over `deps`: one query at a time, with one deadline each, a cancellation and a restart as the last resort. */
export function createQueries<Connection extends SqlConnection>(deps: QueryDeps<Connection>): Queries {
  let tail: Promise<void> = Promise.resolve();
  // Registrations that ran past their query's deadline and go on in the background, per connection (a session's own:
  // a hung fetch of a session that is over must not touch the next one). Dropped when the session ends.
  const lateViews = new Map<Connection, LateViews>();

  /** Jobs run one after another (the connection takes one statement at a time); a job never rejects. */
  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const result = tail.then(job);
    tail = result.then(ignore, ignore);
    return result;
  }

  /**
   * Sends one statement. At the deadline it is cancelled; when it does not settle in the grace period, the worker of
   * this connection is restarted (if it is still the engine's), and the query answers `TIMEOUT` either way.
   */
  async function run(connection: Connection, sql: string, deadline: Deadline, graceMs: number): Promise<Outcome> {
    const left = deadline.at - Date.now();
    if (left <= 0) return { kind: 'failed', result: timeoutError(deadline.ms) };
    const reading: Promise<Outcome> = readRows(connection, sql).then(
      (rows): Outcome => ({ kind: 'rows', rows }),
      (error: Error | string): Outcome => ({ kind: 'failed', result: sqlError(error) })
    );
    const expired = await raceTimer(reading, left);
    if (expired.settled) return expired.value;
    deadline.passed = true;

    // Not awaited: a worker that is stuck would never answer, and the grace period starts now.
    void connection.cancelSent().catch(ignore);
    const cancelled = await raceTimer(reading, graceMs);
    if (!cancelled.settled) await deps.restart(connection).catch(ignore);
    return { kind: 'failed', result: timeoutError(deadline.ms) };
  }

  /** The views are registered within the deadline; a fetch that outlives it goes on (and stays registered) without the query. */
  async function registerViews(connection: Connection, tables: readonly string[], deadline: Deadline): Promise<FailedResult | undefined> {
    const loading = deps.ensureViews(tables).then(
      (): FailedResult | undefined => undefined,
      (error: Error | string): FailedResult => viewsError(error)
    );
    const loaded = await raceTimer(loading, Math.max(0, deadline.at - Date.now()));
    if (loaded.settled) return loaded.value;
    const late = lateViews.get(connection) ?? watchLateViews(connection);
    late.pending.add(loading);
    void loading.then(() => {
      late.pending.delete(loading);
      if (late.pending.size > 0) return;
      // Nothing late is left on this connection: forget it and stop watching its session. The next late registration
      // makes a new entry with a new watch.
      if (lateViews.get(connection) === late) lateViews.delete(connection);
      late.end.cancel();
    });
    return timeoutError(deadline.ms);
  }

  /** A new entry of late registrations for this connection, dropped when its session ends. */
  function watchLateViews(connection: Connection): LateViews {
    const late: LateViews = { pending: new Set(), end: deps.sessionEnded(connection) };
    lateViews.set(connection, late);
    // Only memory is at stake in this drop (no job reads another connection's entry), so no test can see it: it frees
    // a registration that never settles (a call to a worker that was terminated).
    void late.end.ended.then(() => {
      if (lateViews.get(connection) === late) lateViews.delete(connection);
    });
    return late;
  }

  /**
   * A late registration sends `registerFileBuffer` and `CREATE VIEW` on its connection, outside the queue. Every job on
   * that connection waits for it before sending anything of its own (rather than routing registrations through the
   * queue: the registry already shares one in-flight fetch, and this keeps the queue and the registry apart), within
   * its deadline. This cannot tell a dataset that is hung in its fetch (no statement sent yet) from one that is about
   * to send: that needs the registry, so the wait is for the whole connection.
   */
  async function lateViewsDone(connection: Connection, deadline: Deadline): Promise<FailedResult | undefined> {
    const pending = lateViews.get(connection)?.pending;
    if (pending === undefined || pending.size === 0) return undefined;
    const done = await raceTimer(Promise.all([...pending]), Math.max(0, deadline.at - Date.now()));
    return done.settled ? undefined : timeoutError(deadline.ms);
  }

  /** Guards the SQL, waits for the turn, registers the views, then runs `body`: the whole of it within one deadline. */
  async function exclusive<T>(
    sql: string,
    overrides: Partial<QueryTimeouts> | undefined,
    body: (statement: (text: string) => Promise<Outcome>, query: string, tables: readonly string[]) => Promise<ClientToolResult<T>>
  ): Promise<ClientToolResult<T>> {
    const checked = deps.validate(sql);
    if (!checked.ok) return toolError('SQL_REJECTED', checked.reason, rejectedHint);
    let queuedOn: Connection;
    try {
      queuedOn = await deps.getConnection();
    } catch {
      return unavailableError();
    }
    const timeouts = { ...deps.timeouts, ...overrides };
    return enqueue(async () => {
      const deadline: Deadline = { at: Date.now() + timeouts.timeoutMs, ms: timeouts.timeoutMs, passed: false };
      let connection: Connection;
      try {
        connection = await deps.getConnection();
      } catch {
        return unavailableError();
      }
      // The worker was replaced while this query waited: its connection is gone, and so are the views.
      if (connection !== queuedOn) return sessionResetError();
      // Set when the query lost the race below: its work stops before the next step, so nothing of it reaches a new session.
      let abandoned = false;
      const work = (async (): Promise<ClientToolResult<T>> => {
        const late = await lateViewsDone(connection, deadline);
        if (late !== undefined) return late;
        if (abandoned) return sessionResetError();
        const failed = await registerViews(connection, checked.tables, deadline);
        if (failed !== undefined) return failed;
        const statement = async (text: string): Promise<Outcome> =>
          abandoned ? { kind: 'failed', result: sessionResetError() } : run(connection, text, deadline, timeouts.cancelGraceMs);
        return body(statement, checked.sql, checked.tables);
      })();
      // The worker ends under the query (sign-out, a restart): do not hold the queue until the deadline.
      const end = deps.sessionEnded(connection);
      const first = await Promise.race([work.then((result) => ({ result })), end.ended.then(() => undefined)]);
      end.cancel();
      if (first !== undefined) return first.result;
      // The query's own timeout is restarting the worker: it answers `TIMEOUT` when that is done.
      if (deadline.passed) return work;
      abandoned = true;
      return sessionResetError();
    });
  }

  /** The columns of the query (`DESCRIBE` plans it and reads nothing). */
  async function describe(statement: (text: string) => Promise<Outcome>, sql: string): Promise<DescribedColumn[] | FailedResult> {
    const outcome = await statement(`DESCRIBE SELECT * FROM (${sql}) AS q`);
    if (outcome.kind === 'failed') return outcome.result;
    return outcome.rows.rows.map(([name, type]) => ({ name: String(name), type: String(type) }));
  }

  /** The wrapper of a layer: `geom` as GeoJSON text; other geometries as type names, times and intervals as text, BLOBs left out. */
  function layerStatement(columns: readonly DescribedColumn[], query: string): string {
    const max = queryConfig.maxFeaturesPerLayer;
    const geometry = quoted(geometryColumn);
    const others = columns.filter((column) => column.name.toLowerCase() !== geometryColumn);
    const excluded = [geometry, ...others.filter((column) => isBlob(column.type)).map((column) => quoted(column.name))];
    const replaced = others.filter((column) => !isBlob(column.type)).flatMap((column) => {
      const expression = replacementOf(column);
      return expression === undefined ? [] : [`${expression} AS ${quoted(column.name)}`];
    });
    const replace = replaced.length === 0 ? '' : ` REPLACE (${replaced.join(', ')})`;
    return `SELECT * EXCLUDE (${excluded.join(', ')})${replace}, ST_AsGeoJSON(${geometry}) AS ${geoJsonColumn} FROM (${query}) AS q LIMIT ${max + 1}`;
  }

  const queryLayer: Queries['queryLayer'] = (sql, overrides) =>
    exclusive(sql, overrides, async (statement, query, tables) => {
      const columns = await describe(statement, query);
      if ('ok' in columns) return columns;
      const geometry = columns.find((column) => column.name.toLowerCase() === geometryColumn);
      if (geometry === undefined || !isGeometry(geometry.type)) return toolError('NO_GEOMETRY', noGeometryMessage, noGeometryHint);

      const max = queryConfig.maxFeaturesPerLayer;
      const outcome = await statement(layerStatement(columns, query));
      if (outcome.kind === 'failed') return outcome.result;
      const { shapes, rows } = outcome.rows;
      if (rows.length > max) {
        return toolError('TOO_MANY_FEATURES', `The query returned more than ${max} features.`, 'Filter or aggregate to return fewer features.');
      }

      const attributes = shapes.slice(0, -1);
      const featureRows: FeatureRow[] = rows.map((raw) => {
        const geojson = raw[attributes.length];
        return { properties: toJsonRow(raw, attributes), geometry: typeof geojson === 'string' ? geojson : null };
      });
      const built = buildFeatureCollection(featureRows);
      if (!built.ok) {
        return built.reason === 'mixed'
          ? toolError('MIXED_GEOMETRY', built.message, 'Return only points, only lines or only polygons.')
          : toolError('SQL_ERROR', built.message, noGeometryHint);
      }

      let geometryType = built.geometryType;
      if (geometryType === undefined) {
        // Nothing to draw: one view's own geometry type still tells the layer what it is, several would not.
        const [only] = tables;
        geometryType = tables.length === 1 ? deps.geometryTypeOf(only) : undefined;
        if (geometryType === undefined) return toolError('NO_GEOMETRY', noFeaturesMessage);
      }
      return {
        ok: true,
        data: {
          features: built.features,
          geometryType,
          columns: attributes.map(columnInfoOf),
          featureCount: built.features.features.length,
          bbox: built.bbox
        }
      };
    });

  const queryTable: Queries['queryTable'] = (sql, maxRows, overrides) =>
    exclusive(sql, overrides, async (statement, query) => {
      const limit = Math.max(1, Math.min(Math.floor(maxRows), queryConfig.maxRows));
      const columns = await describe(statement, query);
      if ('ok' in columns) return columns;
      // A geometry would be a binary blob in the table: the model gets its type name instead.
      const selected = columns.some((column) => replacementOf(column) !== undefined)
        ? columns
            .map((column) => {
              const expression = replacementOf(column);
              return expression === undefined ? quoted(column.name) : `${expression} AS ${quoted(column.name)}`;
            })
            .join(', ')
        : '*';
      const outcome = await statement(`SELECT ${selected} FROM (${query}) AS q LIMIT ${limit + 1}`);
      if (outcome.kind === 'failed') return outcome.result;
      const { shapes, rows } = outcome.rows;
      return {
        ok: true,
        data: {
          columns: shapes.map(columnInfoOf),
          rows: rows.slice(0, limit).map((raw) => toJsonRow(raw, shapes)),
          truncated: rows.length > limit
        }
      };
    });

  return { queryLayer, queryTable };
}
