import { api } from 'aws-blocks';
import { AsyncDuckDB, VoidLogger, type AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import workerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import { catalog } from '../../../shared/catalog';
import { datasetIds } from '../../../shared/datasets';
import { queryConfig } from '../../../shared/config';
import { validateSql } from '../../../shared/sqlGuard';
import { createDuckSession, firstValue } from './duckSession';
import { createEngine, type EngineStatus } from './engineCore';
import { createQueries } from './query';

export type { EngineStatus };
export type { ColumnInfo, JsonRow, LayerQueryResult, TableQueryResult } from './queryTypes';

/** A worker with DuckDB-WASM in it. Only the `eh` bundle is used; the wasm comes from the signed URL. */
function startDuckSession() {
  const worker = new Worker(workerUrl);
  return createDuckSession<AsyncDuckDBConnection>({
    db: new AsyncDuckDB(new VoidLogger(), worker),
    fetchFile: (url) => fetch(url),
    createObjectUrl: (blob) => URL.createObjectURL(blob),
    revokeObjectUrl: (url) => URL.revokeObjectURL(url),
    onWorkerError: (listener) => {
      worker.addEventListener('error', (event) => listener(event.message));
    }
  });
}

const engine = createEngine({
  now: () => Date.now(),
  fetchSources: () => api.getDatasetSources(),
  createSession: async () => startDuckSession(),
  // Signed GET URLs answer HEAD with 403, so DuckDB's range reading cannot be used: whole files only.
  fetchFile: (url) => fetch(url),
  log: (message) => console.info(message)
});

export const { initEngine, restartEngine, ensureViews, lastInitMs, disposeEngine } = engine;

/** The connection of the ready engine, for running a query (rejects while it is not ready). */
export async function getConnection(): Promise<AsyncDuckDBConnection> {
  return (await engine.getSession()).connection();
}

/** The first value of the first row of a query, as text (rejects while the engine is not ready). */
export async function queryScalar(sql: string): Promise<string> {
  return firstValue(await getConnection(), sql);
}

const queries = createQueries<AsyncDuckDBConnection>({
  getConnection,
  ensureViews: (ids) => engine.ensureViews(ids),
  // Only the stuck worker is restarted (not one that replaced it, nor an engine that was shut down); the page's
  // status listener follows the restart.
  sessionEnded: (connection) => engine.whenEnded((session) => session.connection() === connection),
  restart: async (stuck) => {
    await engine.restartIfCurrent((session) => session.connection() === stuck);
  },
  validate: (sql) => validateSql(sql, datasetIds),
  geometryTypeOf: (id) => catalog.find((dataset) => dataset.id === id)?.geometryType,
  timeouts: { timeoutMs: queryConfig.timeoutMs, cancelGraceMs: queryConfig.cancelGraceMs }
});

/** `queryLayer`: a query that returns a `geom` column, as a GeoJSON layer. `queryTable`: a query as at most `maxRows` rows. Both guard the SQL again, and answer errors as tool results. */
export const { queryLayer, queryTable } = queries;
