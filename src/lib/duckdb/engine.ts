import { api } from 'aws-blocks';
import { AsyncDuckDB, VoidLogger, type AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import workerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import { createDuckSession, firstValue } from './duckSession';
import { createEngine, type EngineStatus } from './engineCore';

export type { EngineStatus };

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
