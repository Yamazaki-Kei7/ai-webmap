import { engineConfig } from '../../../shared/config';
import { describeEngineError, initTimeoutMessage, workerFailureMessage } from './errors';
import { createViewRegistry, type ViewRegistry } from './registry';
import { createSourceStore, type DataResponse, type DatasetSources, type SourceStore } from './sources';

export type EngineStatus =
  | { state: 'idle' }
  | { state: 'loading'; step: string }
  | { state: 'ready'; duckdbVersion: string }
  | { state: 'error'; message: string };

/** The steps shown while loading (the text goes to the UI as is). */
export const engineSteps = {
  sources: 'データの取得先を確認中',
  worker: 'ワーカーを起動中',
  wasm: 'DuckDB を読み込み中',
  spatial: '空間拡張を読み込み中',
  settings: '設定を適用中'
} as const;

/** The `SET`s of the engine, before the lock. */
export const settingStatements: readonly string[] = [
  `SET threads = ${engineConfig.threads}`,
  `SET memory_limit = '${engineConfig.memoryLimit}'`
];

/** Last of all: afterwards every `SET` fails (views and registered buffers still work). */
export const lockStatement = 'SET lock_configuration = true';

/** What the engine needs of DuckDB; the real one is in `duckSession.ts`, tests use fakes. */
export type EngineSession = {
  /** Instantiates the wasm and opens the database. */
  load: (wasmUrl: string) => Promise<void>;
  exec: (sql: string) => Promise<void>;
  /** The first value of the first row, as text. */
  scalar: (sql: string) => Promise<string>;
  registerFileBuffer: (fileName: string, bytes: Uint8Array) => Promise<void>;
  /** Reports an error of the worker (which leaves the pending calls pending). */
  onError: (listener: (message: string) => void) => void;
  /** Terminates the worker. */
  terminate: () => Promise<void>;
};

export type EngineDeps<S extends EngineSession> = {
  now: () => number;
  fetchSources: () => Promise<DatasetSources>;
  /** Starts a worker (not yet loaded). */
  createSession: () => Promise<S>;
  fetchFile: (url: string) => Promise<DataResponse>;
  log: (message: string) => void;
};

export type Engine<S extends EngineSession> = {
  initEngine: (onStatus: (status: EngineStatus) => void) => Promise<void>;
  /**
   * Initialises again from scratch (new sources, new worker; the fetched files are kept). Does not wait for an
   * initialisation that is stuck. Without `onStatus` it reports to the listener the page gave last.
   */
  restartEngine: (onStatus?: (status: EngineStatus) => void) => Promise<void>;
  /**
   * `restartEngine` for a query that is stuck: only when the running session is the one `isStuck` accepts. After a
   * sign-out or a newer restart there is nothing to do (false): a late timeout must not touch the engine that
   * replaced it. Reports to the listener the page gave last.
   */
  restartIfCurrent: (isStuck: (session: S) => boolean) => Promise<boolean>;
  /**
   * `ended` resolves when the running session that `isTarget` accepts ends (a restart or a dispose); at once when there
   * is none. `cancel` drops the wait (call it when the waiter is done with the session).
   */
  whenEnded: (isTarget: (session: S) => boolean) => SessionEnd;
  /** Registers the views of these datasets (fetching each file once). */
  ensureViews: (ids: readonly string[]) => Promise<void>;
  /** The session of the running engine; waits for a start-up under way and rejects when the engine is not ready. */
  getSession: () => Promise<S>;
  /** Milliseconds the last successful initialisation took. */
  lastInitMs: () => number | undefined;
  /** Stops everything under way, terminates the worker and forgets the fetched files and URLs (sign-out). */
  disposeEngine: () => Promise<void>;
};

export type SessionEnd = { ended: Promise<void>; cancel: () => void };

/** State that belongs to one signed-in user: dropped at `disposeEngine`, so nothing of it reaches the next user. */
type Owner<S> = { sourceStore: SourceStore; registry: ViewRegistry<S> };

/** One initialisation attempt. */
type Run<S> = {
  /** `superseded`: restart or dispose (silent). `failed`: error, timeout or worker error (reported). */
  state: 'active' | 'superseded' | 'failed';
  starting?: S;
  stop: (state: 'superseded' | 'failed', error: Error) => void;
};

const supersededMessage = 'The data engine was shut down';
const notReadyMessage = 'The data engine is not ready';

function ignore(): void {
  // The failure is reported elsewhere.
}

/** The engine's start-up and the registration of the data files; DuckDB comes in through `deps`. */
export function createEngine<S extends EngineSession>(deps: EngineDeps<S>): Engine<S> {
  let owner: Owner<S> | undefined;
  let session: S | undefined;
  let run: Run<S> | undefined;
  let initPromise: Promise<void> | undefined;
  let initMs: number | undefined;
  let readyStatus: EngineStatus | undefined;
  // The page's listener, kept for a restart nobody on the page asked for (a stuck query); dropped with the user.
  let listener: ((status: EngineStatus) => void) | undefined;
  // Who waits for the end of a session (a query that must stop holding the queue when its worker is gone).
  let endWaiters: { target: S; resolve: () => void }[] = [];

  function createOwner(): Owner<S> {
    const sourceStore = createSourceStore({ now: deps.now, fetchSources: deps.fetchSources });
    const registry = createViewRegistry<S>({
      loadBytes: async (id) => {
        const response = await sourceStore.fetchData(id, deps.fetchFile);
        if (!response.ok) throw new Error(`Failed to fetch dataset ${id}: HTTP ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      },
      registerBuffer: (target, fileName, bytes) => target.registerFileBuffer(fileName, bytes),
      createView: (target, id, fileName) =>
        target.exec(`CREATE VIEW "${id}" AS SELECT * FROM read_parquet('${fileName}')`),
      isCurrent: (target) => target === session
    });
    return { sourceStore, registry };
  }

  async function getSession(): Promise<S> {
    // A call during start-up waits for it (and fails with it).
    if (initPromise !== undefined) await initPromise;
    if (session === undefined) throw new Error(notReadyMessage);
    return session;
  }

  async function start(onStatus: (status: EngineStatus) => void, current: Owner<S>): Promise<void> {
    const startedAt = deps.now();
    let rejectStopped: (error: Error) => void = ignore;
    const stopped = new Promise<never>((_, reject) => {
      rejectStopped = reject;
    });
    stopped.catch(ignore);
    const myRun: Run<S> = {
      state: 'active',
      stop: (state, error) => {
        if (myRun.state !== 'active') return;
        myRun.state = state;
        rejectStopped(error);
      }
    };
    run = myRun;
    const report = (status: EngineStatus): void => {
      if (myRun.state !== 'superseded') onStatus(status);
    };
    const step = (text: string): void => {
      if (myRun.state !== 'active') throw new Error(supersededMessage);
      report({ state: 'loading', step: text });
    };
    const timer = setTimeout(() => myRun.stop('failed', new Error(initTimeoutMessage)), engineConfig.initTimeoutMs);

    const work = (async (): Promise<void> => {
      current.registry.resetViews();
      // Every initialisation (a retry, a restart) asks the backend again: never share an earlier request that may
      // still hang. An answer of that earlier request is dropped by the store.
      current.sourceStore.clear();
      step(engineSteps.sources);
      const { wasmUrl } = await current.sourceStore.refresh();
      step(engineSteps.worker);
      const starting = await deps.createSession();
      myRun.starting = starting;
      if (myRun.state !== 'active') {
        // Stopped while the worker was being created: nobody else knows it.
        await starting.terminate().catch(ignore);
        throw new Error(supersededMessage);
      }
      starting.onError((message) => myRun.stop('failed', new Error(message || workerFailureMessage)));
      step(engineSteps.wasm);
      await starting.load(wasmUrl);
      step(engineSteps.spatial);
      await starting.exec('INSTALL spatial');
      await starting.exec('LOAD spatial');
      step(engineSteps.settings);
      for (const statement of settingStatements) await starting.exec(statement);
      await starting.exec(lockStatement);
      const duckdbVersion = await starting.scalar('SELECT version()');
      if (myRun.state !== 'active') throw new Error(supersededMessage);
      session = starting;
      run = undefined;
      initMs = deps.now() - startedAt;
      deps.log(`Data engine ready in ${initMs} ms`);
      readyStatus = { state: 'ready', duckdbVersion };
      // After `ready`, an error of the worker is not reported here (the race is settled). A dead worker leaves the
      // calls to it pending for good: Task 2.3's query timeout and `restartEngine` are what recover from it.
      report(readyStatus);
    })();
    work.catch(ignore);

    try {
      await Promise.race([work, stopped]);
    } catch (error) {
      myRun.stop('failed', error instanceof Error ? error : new Error(String(error)));
      await myRun.starting?.terminate().catch(ignore);
      if (run === myRun) run = undefined;
      report({ state: 'error', message: describeEngineError(error instanceof Error ? error : String(error)) });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Stops the initialisation under way and the running session. */
  async function abandon(): Promise<void> {
    const oldRun = run;
    const oldSession = session;
    run = undefined;
    session = undefined;
    initPromise = undefined;
    readyStatus = undefined;
    oldRun?.stop('superseded', new Error(supersededMessage));
    const ended = endWaiters.filter((waiter) => waiter.target === oldSession);
    endWaiters = endWaiters.filter((waiter) => waiter.target !== oldSession);
    for (const waiter of ended) waiter.resolve();
    await Promise.all([oldRun?.starting?.terminate().catch(ignore), oldSession?.terminate().catch(ignore)]);
  }

  function initEngine(onStatus: (status: EngineStatus) => void): Promise<void> {
    listener = onStatus;
    if (initPromise !== undefined) {
      if (session !== undefined && readyStatus !== undefined) onStatus(readyStatus);
      return initPromise;
    }
    owner ??= createOwner();
    const running = start(onStatus, owner);
    initPromise = running;
    running.catch(() => {
      // The next call starts over.
      if (initPromise === running) initPromise = undefined;
    });
    return running;
  }

  async function restartEngine(onStatus?: (status: EngineStatus) => void): Promise<void> {
    const target = onStatus ?? listener ?? ignore;
    await abandon();
    return initEngine(target);
  }

  function whenEnded(isTarget: (target: S) => boolean): SessionEnd {
    const current = session;
    if (current === undefined || !isTarget(current)) return { ended: Promise.resolve(), cancel: ignore };
    let waiter: { target: S; resolve: () => void } | undefined;
    const ended = new Promise<void>((resolve) => {
      waiter = { target: current, resolve };
      endWaiters.push(waiter);
    });
    return {
      ended,
      cancel: () => {
        endWaiters = endWaiters.filter((entry) => entry !== waiter);
      }
    };
  }

  async function restartIfCurrent(isStuck: (stuck: S) => boolean): Promise<boolean> {
    if (session === undefined || !isStuck(session)) return false;
    await restartEngine().catch(ignore);
    return true;
  }

  async function disposeEngine(): Promise<void> {
    const old = owner;
    owner = undefined;
    initMs = undefined;
    listener = undefined;
    old?.registry.clear();
    old?.sourceStore.clear();
    await abandon();
  }

  return {
    initEngine,
    restartEngine,
    restartIfCurrent,
    whenEnded,
    ensureViews: async (ids) => {
      // Not ready: reject before any file is fetched.
      const target = await getSession();
      if (owner === undefined) throw new Error(notReadyMessage);
      await owner.registry.ensure(target, ids);
    },
    getSession,
    lastInitMs: () => initMs,
    disposeEngine
  };
}
