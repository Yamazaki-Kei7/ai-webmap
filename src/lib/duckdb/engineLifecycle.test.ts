import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineConfig } from '../../../shared/config';
import { datasetFileName, datasetIds } from '../../../shared/datasets';
import { createEngine, type EngineSession, type EngineStatus } from './engineCore';
import { initTimeoutMessage, workerFailureMessage } from './errors';
import type { DataResponse, DatasetSources } from './sources';

const [first] = datasetIds;

type FakeSession = EngineSession & { statements: string[]; terminated: boolean; fireError: (message: string) => void };

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A session whose steps can be held back: `hold.load` / `hold.scalar` make that call wait for a promise. */
function fakeSession(hold: { load?: Promise<void>; scalar?: Promise<void> } = {}): FakeSession {
  let listener: (message: string) => void = () => undefined;
  const session: FakeSession = {
    statements: [],
    terminated: false,
    fireError: (message) => listener(message),
    onError: (next) => {
      listener = next;
    },
    load: async () => hold.load,
    exec: async (sql) => {
      session.statements.push(sql);
    },
    scalar: async () => {
      await hold.scalar;
      return 'v1';
    },
    registerFileBuffer: async () => undefined,
    terminate: async () => {
      session.terminated = true;
    }
  };
  return session;
}

const sourcesOf = (tag: string): DatasetSources => ({
  sources: datasetIds.map((id) => ({ id, url: `https://files.test/${tag}/${id}` })),
  wasmUrl: `https://files.test/${tag}/wasm`,
  expiresAt: Number.MAX_SAFE_INTEGER
});
const okFile = (): DataResponse => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4) });

function setup(options: { sessions?: FakeSession[]; fetchSources?: () => Promise<DatasetSources>; fetchFile?: (url: string) => Promise<DataResponse> } = {}) {
  const queue = [...(options.sessions ?? [])];
  const created: FakeSession[] = [];
  const fetchFile = vi.fn(options.fetchFile ?? (async () => okFile()));
  const engine = createEngine<FakeSession>({
    now: () => 0,
    fetchSources: options.fetchSources ?? (async () => sourcesOf('a')),
    createSession: async () => {
      const session = queue.shift() ?? fakeSession();
      created.push(session);
      return session;
    },
    fetchFile,
    log: () => undefined
  });
  const statuses: EngineStatus[] = [];
  return { engine, created, fetchFile, statuses, onStatus: (status: EngineStatus) => statuses.push(status) };
}

describe('the initialisation timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports an error and terminates the worker when the start-up never finishes, and a retry reaches ready', async () => {
    const never = new Promise<void>(() => undefined);
    const { engine, created, statuses, onStatus } = setup({ sessions: [fakeSession({ load: never })] });
    const stuck = engine.initEngine(onStatus);
    const failure = expect(stuck).rejects.toThrow(initTimeoutMessage);
    await vi.advanceTimersByTimeAsync(engineConfig.initTimeoutMs);
    await failure;
    expect(statuses.at(-1)).toEqual({ state: 'error', message: initTimeoutMessage });
    expect(created[0].terminated).toBe(true);
    await engine.initEngine(onStatus);
    expect(statuses.at(-1)).toEqual({ state: 'ready', duckdbVersion: 'v1' });
    expect(created).toHaveLength(2);
  });

  it('does not time out a start-up that finishes in time', async () => {
    const { engine, statuses, onStatus } = setup();
    await engine.initEngine(onStatus);
    await vi.advanceTimersByTimeAsync(engineConfig.initTimeoutMs * 2);
    expect(statuses.at(-1)).toEqual({ state: 'ready', duckdbVersion: 'v1' });
  });

  it('restarts without waiting for a stuck initialisation', async () => {
    const never = new Promise<void>(() => undefined);
    const { engine, created, statuses, onStatus } = setup({ sessions: [fakeSession({ load: never })] });
    const stuck = engine.initEngine(onStatus);
    const superseded = expect(stuck).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10);
    await engine.restartEngine(onStatus);
    await superseded;
    expect(created[0].terminated).toBe(true);
    expect(statuses.at(-1)).toEqual({ state: 'ready', duckdbVersion: 'v1' });
    // The stuck attempt's timer does not turn the new engine into an error.
    await vi.advanceTimersByTimeAsync(engineConfig.initTimeoutMs * 2);
    expect(statuses.at(-1)).toEqual({ state: 'ready', duckdbVersion: 'v1' });
  });
});

describe('a retry after a timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks the backend again instead of sharing a request that never settles', async () => {
    let calls = 0;
    const fetchSources = vi.fn(() => {
      calls += 1;
      return calls === 1 ? new Promise<DatasetSources>(() => undefined) : Promise.resolve(sourcesOf('a'));
    });
    const { engine, statuses, onStatus } = setup({ fetchSources });
    const stuck = engine.initEngine(onStatus);
    const failure = expect(stuck).rejects.toThrow(initTimeoutMessage);
    await vi.advanceTimersByTimeAsync(engineConfig.initTimeoutMs);
    await failure;
    await engine.restartEngine(onStatus);
    expect(fetchSources).toHaveBeenCalledTimes(2);
    expect(statuses.at(-1)).toEqual({ state: 'ready', duckdbVersion: 'v1' });
  });

  it('asks again on a plain initEngine after the timeout too', async () => {
    let calls = 0;
    const fetchSources = vi.fn(() => {
      calls += 1;
      return calls === 1 ? new Promise<DatasetSources>(() => undefined) : Promise.resolve(sourcesOf('a'));
    });
    const { engine, onStatus } = setup({ fetchSources });
    const failure = expect(engine.initEngine(onStatus)).rejects.toThrow(initTimeoutMessage);
    await vi.advanceTimersByTimeAsync(engineConfig.initTimeoutMs);
    await failure;
    await engine.initEngine(onStatus);
    expect(fetchSources).toHaveBeenCalledTimes(2);
  });
});

describe('an abandoned run', () => {
  it('does not clear or replace the sources of the run that replaced it', async () => {
    const first1 = deferred<DatasetSources>();
    let calls = 0;
    const fetchSources = vi.fn(() => {
      calls += 1;
      return calls === 1 ? first1.promise : Promise.resolve(sourcesOf('b'));
    });
    const { engine, fetchFile, onStatus } = setup({ fetchSources });
    const stuck = engine.initEngine(() => undefined);
    const ended = stuck.catch(() => undefined);
    await engine.restartEngine(onStatus);
    // The abandoned run's own request settles after the new run has its sources.
    first1.resolve(sourcesOf('old'));
    await ended;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await engine.ensureViews([first]);
    expect(fetchSources).toHaveBeenCalledTimes(2);
    expect(fetchFile).toHaveBeenCalledWith(`https://files.test/b/${first}`);
  });
});

describe('a worker error', () => {
  it('reports an error without waiting for the timeout, and a retry reaches ready', async () => {
    const never = new Promise<void>(() => undefined);
    const broken = fakeSession({ load: never });
    const { engine, created, statuses, onStatus } = setup({ sessions: [broken] });
    const running = engine.initEngine(onStatus);
    const failure = expect(running).rejects.toThrow(workerFailureMessage);
    await vi.waitFor(() => expect(created).toHaveLength(1));
    broken.fireError('');
    await failure;
    expect(statuses.at(-1)).toEqual({ state: 'error', message: workerFailureMessage });
    expect(broken.terminated).toBe(true);
    await engine.initEngine(onStatus);
    expect(statuses.at(-1)).toEqual({ state: 'ready', duckdbVersion: 'v1' });
  });
});

describe('sign-out while work is under way', () => {
  it('does not let the next user share the previous user\'s pending getDatasetSources', async () => {
    const userA = deferred<DatasetSources>();
    let calls = 0;
    const fetchSources = vi.fn(() => {
      calls += 1;
      return calls === 1 ? userA.promise : Promise.reject(new Error('Access denied'));
    });
    const { engine, created, statuses, onStatus } = setup({ fetchSources });
    const a = engine.initEngine(() => undefined);
    const aEnded = a.catch(() => undefined);
    await engine.disposeEngine();
    const b = engine.initEngine(onStatus);
    userA.resolve(sourcesOf('a'));
    await expect(b).rejects.toThrow('Access denied');
    await aEnded;
    expect(fetchSources).toHaveBeenCalledTimes(2);
    expect(statuses.at(-1)).toEqual({ state: 'error', message: 'Access denied' });
    expect(created).toHaveLength(0);
  });

  it('does not keep a file that arrives after sign-out', async () => {
    const file = deferred<DataResponse>();
    const { engine, fetchFile, onStatus } = setup({ fetchFile: () => file.promise });
    await engine.initEngine(onStatus);
    const pending = engine.ensureViews([first]);
    const ended = pending.catch(() => undefined);
    await vi.waitFor(() => expect(fetchFile).toHaveBeenCalledTimes(1));
    await engine.disposeEngine();
    file.resolve(okFile());
    await ended;
    await expect(pending).rejects.toThrow();
    fetchFile.mockImplementation(async () => okFile());
    await engine.initEngine(onStatus);
    await engine.ensureViews([first]);
    expect(fetchFile).toHaveBeenCalledTimes(2);
  });

  it('does not report ready when the sign-out comes during the last step', async () => {
    const release = deferred<void>();
    const slow = fakeSession({ scalar: release.promise });
    const { engine, statuses, onStatus } = setup({ sessions: [slow] });
    const running = engine.initEngine(onStatus);
    const ended = expect(running).rejects.toThrow();
    await vi.waitFor(() => expect(slow.statements.at(-1)).toMatch(/lock_configuration/));
    await engine.disposeEngine();
    release.resolve();
    await ended;
    // Let the stopped start-up run on to its end.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(statuses.some((status) => status.state === 'ready')).toBe(false);
    expect(slow.terminated).toBe(true);
    // Nothing of the stopped start-up is recorded as a finished one.
    expect(engine.lastInitMs()).toBeUndefined();
    await expect(engine.ensureViews([first])).rejects.toThrow('not ready');
  });

  it('terminates a worker that is still being created when the sign-out comes', async () => {
    const creating = deferred<FakeSession>();
    let requested = false;
    const late = fakeSession();
    const engine = createEngine<FakeSession>({
      now: () => 0,
      fetchSources: async () => sourcesOf('a'),
      createSession: () => {
        requested = true;
        return creating.promise;
      },
      fetchFile: async () => okFile(),
      log: () => undefined
    });
    const running = engine.initEngine(() => undefined);
    const ended = running.catch(() => undefined);
    await vi.waitFor(() => expect(requested).toBe(true));
    await engine.disposeEngine();
    creating.resolve(late);
    await ended;
    await vi.waitFor(() => expect(late.terminated).toBe(true));
  });
});

describe('ensureViews and restart', () => {
  it('waits for a start-up under way and then registers the view', async () => {
    const { engine, created, onStatus } = setup();
    const running = engine.initEngine(onStatus);
    const views = engine.ensureViews([first]);
    await Promise.all([running, views]);
    expect(created[0].statements.at(-1)).toBe(`CREATE VIEW "${first}" AS SELECT * FROM read_parquet('${datasetFileName(first)}')`);
  });

  it('fetches once and creates the view once in the new worker when a restart comes during a registration', async () => {
    const file = deferred<DataResponse>();
    const { engine, created, fetchFile, onStatus } = setup({ fetchFile: () => file.promise });
    await engine.initEngine(onStatus);
    const old = engine.ensureViews([first]);
    const oldEnded = expect(old).rejects.toThrow('restarted');
    await vi.waitFor(() => expect(fetchFile).toHaveBeenCalledTimes(1));
    await engine.restartEngine(onStatus);
    const fresh = engine.ensureViews([first]);
    file.resolve(okFile());
    await Promise.all([oldEnded, fresh]);
    expect(fetchFile).toHaveBeenCalledTimes(1);
    const created0 = created[0].statements.filter((sql) => sql.startsWith('CREATE VIEW'));
    const created1 = created[1].statements.filter((sql) => sql.startsWith('CREATE VIEW'));
    expect([created0.length, created1.length]).toEqual([0, 1]);
  });

  it('does not register in the old worker when a restart comes right after ensureViews took the session', async () => {
    const { engine, created, onStatus } = setup();
    await engine.initEngine(onStatus);
    const views = engine.ensureViews([first]);
    // Rejected either at once (no session any more) or by the registration (not the current session).
    const rejected = expect(views).rejects.toThrow();
    const restarted = engine.restartEngine(onStatus);
    await Promise.all([rejected, restarted]);
    expect(created[0].statements.some((sql) => sql.startsWith('CREATE VIEW'))).toBe(false);
    await engine.ensureViews([first]);
    expect(created[1].statements.filter((sql) => sql.startsWith('CREATE VIEW'))).toHaveLength(1);
  });
});

describe('a restart that no one on the page asked for (a stuck query)', () => {
  it('reports to the listener the page gave last: loading, then ready', async () => {
    const { engine, statuses, onStatus } = setup();
    await engine.initEngine(onStatus);
    statuses.length = 0;
    await engine.restartEngine();
    expect(statuses[0]).toMatchObject({ state: 'loading' });
    expect(statuses.at(-1)).toEqual({ state: 'ready', duckdbVersion: 'v1' });
  });

  it('reports the error, and a retry through the page reaches ready again', async () => {
    let calls = 0;
    const { engine, statuses, onStatus } = setup({
      fetchSources: async () => {
        calls += 1;
        if (calls === 2) throw new Error('sources are down');
        return sourcesOf('a');
      }
    });
    await engine.initEngine(onStatus);
    await expect(engine.restartEngine()).rejects.toThrow('sources are down');
    expect(statuses.at(-1)).toEqual({ state: 'error', message: 'sources are down' });
    await engine.initEngine(onStatus);
    expect(statuses.at(-1)).toEqual({ state: 'ready', duckdbVersion: 'v1' });
  });

  it('has no listener after the engine was disposed', async () => {
    const { engine, statuses, onStatus } = setup();
    await engine.initEngine(onStatus);
    await engine.disposeEngine();
    statuses.length = 0;
    await engine.restartEngine();
    expect(statuses).toEqual([]);
  });
});

describe('restartIfCurrent', () => {
  it('restarts when the stuck session is the running one, reporting to the page', async () => {
    const { engine, created, statuses, onStatus } = setup();
    await engine.initEngine(onStatus);
    statuses.length = 0;
    expect(await engine.restartIfCurrent((session) => session === created[0])).toBe(true);
    expect(created).toHaveLength(2);
    expect(statuses.at(-1)).toEqual({ state: 'ready', duckdbVersion: 'v1' });
  });

  it('does nothing after a sign-out: no restart, no new engine', async () => {
    const { engine, created, onStatus } = setup();
    await engine.initEngine(onStatus);
    await engine.disposeEngine();
    expect(await engine.restartIfCurrent(() => true)).toBe(false);
    expect(created).toHaveLength(1);
  });

  it('does nothing when a newer restart has already replaced the stuck session', async () => {
    const { engine, created, onStatus } = setup();
    await engine.initEngine(onStatus);
    await engine.restartEngine(onStatus);
    expect(await engine.restartIfCurrent((session) => session === created[0])).toBe(false);
    expect(created).toHaveLength(2);
  });

  it('does not throw when the restart fails', async () => {
    let calls = 0;
    const { engine, onStatus } = setup({
      fetchSources: async () => {
        calls += 1;
        if (calls === 2) throw new Error('sources are down');
        return sourcesOf('a');
      }
    });
    await engine.initEngine(onStatus);
    await expect(engine.restartIfCurrent(() => true)).resolves.toBe(true);
  });
});

describe('whenEnded', () => {
  it('resolves at once when no session is running or the session is not the target', async () => {
    const { engine, created, onStatus } = setup();
    await engine.whenEnded(() => true).ended;
    await engine.initEngine(onStatus);
    await engine.whenEnded((session) => session !== created[0]).ended;
  });

  it('resolves when the session is disposed, and when it is restarted', async () => {
    const { engine, created, onStatus } = setup();
    await engine.initEngine(onStatus);
    const ended = vi.fn();
    void engine.whenEnded((session) => session === created[0]).ended.then(ended);
    await Promise.resolve();
    expect(ended).not.toHaveBeenCalled();
    await engine.restartEngine(onStatus);
    await vi.waitFor(() => expect(ended).toHaveBeenCalledTimes(1));

    const disposed = vi.fn();
    void engine.whenEnded((session) => session === created[1]).ended.then(disposed);
    await Promise.resolve();
    expect(disposed).not.toHaveBeenCalled();
    await engine.disposeEngine();
    await vi.waitFor(() => expect(disposed).toHaveBeenCalledTimes(1));
  });
});

describe('whenEnded: cancel', () => {
  it('drops the wait: a cancelled waiter is not resolved by the end of the session', async () => {
    const { engine, created, onStatus } = setup();
    await engine.initEngine(onStatus);
    const ended = vi.fn();
    const wait = engine.whenEnded((session) => session === created[0]);
    void wait.ended.then(ended);
    wait.cancel();
    await engine.disposeEngine();
    await Promise.resolve();
    expect(ended).not.toHaveBeenCalled();
  });
});
