import { wasmContentType } from '../../../shared/datasets';
import type { EngineSession } from './engineCore';

/** The part of a `Table` a scalar query reads. */
type ScalarTable = {
  getChildAt: (index: number) => { get: (row: number) => string | number | bigint | null | undefined } | null;
};

export type QueryConnection = { query: (sql: string) => Promise<ScalarTable> };

/** The part of `AsyncDuckDB` the session uses. */
export type DuckDb<Connection extends QueryConnection> = {
  instantiate: (mainModuleUrl: string) => Promise<null>;
  open: (config: Record<string, never>) => Promise<void>;
  connect: () => Promise<Connection>;
  registerFileBuffer: (fileName: string, bytes: Uint8Array) => Promise<void>;
  terminate: () => Promise<void>;
};

export type DuckSessionDeps<Connection extends QueryConnection> = {
  db: DuckDb<Connection>;
  fetchFile: (url: string) => Promise<Pick<Response, 'ok' | 'status' | 'blob'>>;
  createObjectUrl: (blob: Blob) => string;
  revokeObjectUrl: (url: string) => void;
  /** Subscribes to errors of the worker (it never settles the pending calls itself). */
  onWorkerError: (listener: (message: string) => void) => void;
};

export type DuckSession<Connection extends QueryConnection> = EngineSession & { connection: () => Connection };

/** The first value of the first row, as text; a query with no row or a NULL is an error. */
export async function firstValue(connection: QueryConnection, sql: string): Promise<string> {
  const value = (await connection.query(sql)).getChildAt(0)?.get(0);
  if (value === null || value === undefined) throw new Error('The query returned no value');
  return String(value);
}

/** An engine session over DuckDB-WASM: the wasm is fetched here (not in the worker) and held as one object URL. */
export function createDuckSession<Connection extends QueryConnection>({
  db,
  fetchFile,
  createObjectUrl,
  revokeObjectUrl,
  onWorkerError
}: DuckSessionDeps<Connection>): DuckSession<Connection> {
  let conn: Connection | undefined;
  let wasmUrl: string | undefined;

  function connection(): Connection {
    if (conn === undefined) throw new Error('The database is not open');
    return conn;
  }

  function releaseWasmUrl(): void {
    if (wasmUrl !== undefined) revokeObjectUrl(wasmUrl);
    wasmUrl = undefined;
  }

  return {
    load: async (signedWasmUrl) => {
      // The main thread fetches the wasm: a fetch that fails inside the worker leaves `instantiate` pending for good.
      const response = await fetchFile(signedWasmUrl);
      if (!response.ok) throw new Error(`Failed to fetch the DuckDB wasm: HTTP ${response.status}`);
      const wasm = await response.blob();
      wasmUrl = createObjectUrl(new Blob([wasm], { type: wasmContentType }));
      await db.instantiate(wasmUrl);
      releaseWasmUrl();
      await db.open({});
      conn = await db.connect();
    },
    exec: async (sql) => {
      await connection().query(sql);
    },
    scalar: (sql) => firstValue(connection(), sql),
    registerFileBuffer: (fileName, bytes) => db.registerFileBuffer(fileName, bytes),
    onError: onWorkerError,
    terminate: () => {
      releaseWasmUrl();
      return db.terminate();
    },
    connection
  };
}
