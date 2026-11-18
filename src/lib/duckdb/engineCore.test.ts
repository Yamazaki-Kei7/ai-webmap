import { describe, expect, it, vi } from 'vitest';
import { datasetFileName, datasetIds } from '../../../shared/datasets';
import {
  createEngine,
  engineSteps,
  lockStatement,
  settingStatements,
  type EngineSession,
  type EngineStatus
} from './engineCore';
import type { DatasetSources } from './sources';

const [first] = datasetIds;
const version = 'v9.9.9';

type FakeSession = EngineSession & {
  statements: string[];
  terminated: boolean;
  registered: string[];
  fireError: (message: string) => void;
};

function fakeSession(): FakeSession {
  let listener: (message: string) => void = () => undefined;
  const session: FakeSession = {
    fireError: (message) => listener(message),
    onError: (next) => {
      listener = next;
    },
    statements: [],
    terminated: false,
    registered: [],
    load: vi.fn(async () => undefined),
    exec: vi.fn(async (sql: string) => {
      session.statements.push(sql);
    }),
    scalar: vi.fn(async () => version),
    registerFileBuffer: vi.fn(async (fileName: string) => {
      session.registered.push(fileName);
    }),
    terminate: vi.fn(async () => {
      session.terminated = true;
    })
  };
  return session;
}

function setup() {
  let issued = 0;
  const sessions: FakeSession[] = [];
  const fetchSources = vi.fn(
    async (): Promise<DatasetSources> => {
      issued += 1;
      return {
        sources: datasetIds.map((id) => ({ id, url: `https://files.test/${id}?n=${issued}` })),
        wasmUrl: `https://files.test/wasm?n=${issued}`,
        expiresAt: Number.MAX_SAFE_INTEGER
      };
    }
  );
  const fetchFile = vi.fn(async (_url: string) => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4) }));
  const createSession = vi.fn(async () => {
    const session = fakeSession();
    sessions.push(session);
    return session;
  });
  let time = 1_000;
  const log = vi.fn();
  const engine = createEngine<FakeSession>({
    now: () => (time += 250),
    fetchSources,
    createSession,
    fetchFile,
    log
  });
  const statuses: EngineStatus[] = [];
  return { engine, fetchSources, fetchFile, createSession, sessions, log, statuses, onStatus: (s: EngineStatus) => statuses.push(s) };
}

describe('initEngine', () => {
  it('reports the loading steps in order, then ready with the DuckDB version', async () => {
    const { engine, statuses, onStatus } = setup();
    await engine.initEngine(onStatus);
    expect(statuses).toEqual([
      { state: 'loading', step: engineSteps.sources },
      { state: 'loading', step: engineSteps.worker },
      { state: 'loading', step: engineSteps.wasm },
      { state: 'loading', step: engineSteps.spatial },
      { state: 'loading', step: engineSteps.settings },
      { state: 'ready', duckdbVersion: version }
    ]);
  });

  it('loads the wasm from the fresh signed URL, then spatial, the settings and the lock last', async () => {
    const { engine, sessions, onStatus } = setup();
    await engine.initEngine(onStatus);
    expect(sessions[0].load).toHaveBeenCalledWith('https://files.test/wasm?n=1');
    expect(sessions[0].statements).toEqual(['INSTALL spatial', 'LOAD spatial', ...settingStatements, lockStatement]);
  });

  it('records the duration and logs it once, without a URL', async () => {
    const { engine, log, onStatus } = setup();
    await engine.initEngine(onStatus);
    expect(engine.lastInitMs()).toBeGreaterThan(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).not.toContain('http');
  });

  it('returns the same promise while an initialisation is running', async () => {
    const { engine, createSession, onStatus } = setup();
    const a = engine.initEngine(onStatus);
    const b = engine.initEngine(onStatus);
    expect(b).toBe(a);
    await a;
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('reports an error without a URL and terminates the half-started worker', async () => {
    const { engine, sessions, createSession, statuses, onStatus } = setup();
    createSession.mockImplementationOnce(async () => {
      const session = fakeSession();
      session.load = vi.fn(async () => {
        throw new Error('Failed to fetch https://files.test/wasm?X-Amz-Signature=secret');
      });
      sessions.push(session);
      return session;
    });
    await expect(engine.initEngine(onStatus)).rejects.toThrow();
    expect(statuses.at(-1)).toEqual({ state: 'error', message: 'Failed to fetch [URL]' });
    expect(sessions[0].terminated).toBe(true);
    await expect(engine.ensureViews([first])).rejects.toThrow('not ready');
  });

  it('starts over after an error: new sources, new worker', async () => {
    const { engine, sessions, fetchSources, createSession, statuses, onStatus } = setup();
    fetchSources.mockRejectedValueOnce(new Error('offline'));
    await expect(engine.initEngine(onStatus)).rejects.toThrow('offline');
    expect(statuses.at(-1)).toEqual({ state: 'error', message: 'offline' });
    await engine.initEngine(onStatus);
    expect(statuses.at(-1)).toEqual({ state: 'ready', duckdbVersion: version });
    expect(fetchSources).toHaveBeenCalledTimes(2);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(sessions[0].load).toHaveBeenCalledWith('https://files.test/wasm?n=1');
  });

  it('reports ready again to a caller that arrives after the engine is ready', async () => {
    const { engine, onStatus } = setup();
    await engine.initEngine(onStatus);
    const later: EngineStatus[] = [];
    await engine.initEngine((s) => later.push(s));
    expect(later).toEqual([{ state: 'ready', duckdbVersion: version }]);
  });
});

describe('restartEngine', () => {
  it('terminates the old worker and starts a new one with new sources', async () => {
    const { engine, sessions, fetchSources, onStatus } = setup();
    await engine.initEngine(onStatus);
    await engine.restartEngine(onStatus);
    expect(sessions).toHaveLength(2);
    expect(sessions[0].terminated).toBe(true);
    expect(fetchSources).toHaveBeenCalledTimes(2);
  });

  it('registers the views again in the new worker from the kept copies', async () => {
    const { engine, sessions, fetchFile, onStatus } = setup();
    await engine.initEngine(onStatus);
    await engine.ensureViews([first]);
    await engine.restartEngine(onStatus);
    await engine.ensureViews([first]);
    expect(fetchFile).toHaveBeenCalledTimes(1);
    expect(sessions[1].registered).toEqual([datasetFileName(first)]);
  });
});

describe('ensureViews', () => {
  it('registers a view lazily, fetching its file once with the signed URL', async () => {
    const { engine, sessions, fetchFile, onStatus } = setup();
    await engine.initEngine(onStatus);
    expect(fetchFile).not.toHaveBeenCalled();
    await engine.ensureViews([first]);
    await engine.ensureViews([first]);
    expect(fetchFile).toHaveBeenCalledTimes(1);
    expect(fetchFile).toHaveBeenCalledWith(`https://files.test/${first}?n=1`);
    expect(sessions[0].statements.at(-1)).toBe(`CREATE VIEW "${first}" AS SELECT * FROM read_parquet('${datasetFileName(first)}')`);
  });

  it('rejects an unknown id', async () => {
    const { engine, onStatus } = setup();
    await engine.initEngine(onStatus);
    await expect(engine.ensureViews(['nowhere'])).rejects.toThrow('Unknown dataset: nowhere');
  });

  it('reads again with a new URL after a 403, once', async () => {
    const { engine, fetchFile, fetchSources, onStatus } = setup();
    await engine.initEngine(onStatus);
    fetchFile.mockResolvedValueOnce({ ok: false, status: 403, arrayBuffer: async () => new ArrayBuffer(0) });
    await engine.ensureViews([first]);
    expect(fetchFile.mock.calls.map(([url]) => url)).toEqual([`https://files.test/${first}?n=1`, `https://files.test/${first}?n=2`]);
    expect(fetchSources).toHaveBeenCalledTimes(2);
  });

  it('rejects with the status when the file cannot be read', async () => {
    const { engine, fetchFile, onStatus } = setup();
    await engine.initEngine(onStatus);
    fetchFile.mockResolvedValueOnce({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) });
    await expect(engine.ensureViews([first])).rejects.toThrow('HTTP 500');
  });
});

describe('disposeEngine', () => {
  it('terminates the worker, forgets the copies, and stops a running start-up', async () => {
    const { engine, sessions, fetchFile, statuses, onStatus } = setup();
    await engine.initEngine(onStatus);
    await engine.ensureViews([first]);
    await engine.disposeEngine();
    expect(sessions[0].terminated).toBe(true);
    await expect(engine.ensureViews([first])).rejects.toThrow('not ready');

    const running = engine.initEngine(onStatus);
    const before = statuses.length;
    await engine.disposeEngine();
    await expect(running).rejects.toThrow('shut down');
    // The stopped start-up reports nothing more, and starts no worker.
    expect(statuses).toHaveLength(before);
    expect(sessions).toHaveLength(1);
    await engine.initEngine(onStatus);
    await engine.ensureViews([first]);
    expect(fetchFile).toHaveBeenCalledTimes(2);
  });
});
