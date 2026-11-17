import { datasetFileName, datasetIds } from '../../../shared/datasets';

/** `Target` is what a view is registered in: the engine session (one worker). */
export type RegistryDeps<Target> = {
  /** Fetches the whole file of a dataset. */
  loadBytes: (id: string) => Promise<Uint8Array>;
  /** `registerFileBuffer`: takes over (detaches) the buffer it is given. */
  registerBuffer: (target: Target, fileName: string, bytes: Uint8Array) => Promise<void>;
  /** `CREATE VIEW <id> AS SELECT * FROM read_parquet('<fileName>')`. */
  createView: (target: Target, id: string, fileName: string) => Promise<void>;
  /** Is this still the engine's running session? A registration for another one stops. */
  isCurrent: (target: Target) => boolean;
};

export type ViewRegistry<Target> = {
  /** Makes sure each view exists in the target: a file is fetched once, a view is registered once per worker. */
  ensure: (target: Target, ids: readonly string[]) => Promise<void>;
  /** The kept copy of a fetched file, for registering again in a new worker. */
  copyOf: (id: string) => Uint8Array | undefined;
  /** The worker was replaced: its views are gone, the copies (and fetches under way) stay. */
  resetViews: () => void;
  /** Drops the views and the copies; fetches under way are not stored when they arrive. */
  clear: () => void;
};

export const restartedMessage = 'The data engine was restarted';

/** Lazy registration bookkeeping, with no DuckDB in it. */
export function createViewRegistry<Target>({ loadBytes, registerBuffer, createView, isCurrent }: RegistryDeps<Target>): ViewRegistry<Target> {
  const copies = new Map<string, Uint8Array>();
  const fetching = new Map<string, Promise<Uint8Array>>();
  const registered = new Set<string>();
  const inFlight = new Map<string, Promise<void>>();
  // Counts `resetViews()` / `clear()`: a registration that started in an earlier worker stops where it is.
  let viewsEpoch = 0;
  // Counts `clear()`: a fetch that started before it is not kept.
  let dataEpoch = 0;

  /** One fetch per file; it outlives a worker reset. */
  function bytesOf(id: string): Promise<Uint8Array> {
    const kept = copies.get(id);
    if (kept !== undefined) return Promise.resolve(kept);
    let fetch = fetching.get(id);
    if (fetch === undefined) {
      const startedIn = dataEpoch;
      const started: Promise<Uint8Array> = loadBytes(id)
        .then((bytes) => {
          if (startedIn === dataEpoch) copies.set(id, bytes);
          return bytes;
        })
        .finally(() => {
          if (fetching.get(id) === started) fetching.delete(id);
        });
      fetching.set(id, started);
      fetch = started;
    }
    return fetch;
  }

  async function register(target: Target, id: string): Promise<void> {
    const fileName = datasetFileName(id);
    const startedIn = viewsEpoch;
    const stale = (): boolean => startedIn !== viewsEpoch || !isCurrent(target);
    const copy = await bytesOf(id);
    if (stale()) throw new Error(restartedMessage);
    // The registered buffer is detached by DuckDB, so it gets a copy of the kept one.
    await registerBuffer(target, fileName, copy.slice());
    if (stale()) throw new Error(restartedMessage);
    await createView(target, id, fileName);
    if (!stale()) registered.add(id);
  }

  function ensureOne(target: Target, id: string): Promise<void> {
    if (registered.has(id)) return Promise.resolve();
    let promise = inFlight.get(id);
    if (promise === undefined) {
      const started: Promise<void> = register(target, id).finally(() => {
        if (inFlight.get(id) === started) inFlight.delete(id);
      });
      inFlight.set(id, started);
      promise = started;
    }
    return promise;
  }

  function reset(): void {
    viewsEpoch += 1;
    registered.clear();
    inFlight.clear();
  }

  return {
    ensure: async (target, ids) => {
      // An unknown id rejects before anything is fetched.
      const unknown = ids.find((id) => !datasetIds.includes(id));
      if (unknown !== undefined) throw new Error(`Unknown dataset: ${unknown}`);
      await Promise.all(ids.map((id) => ensureOne(target, id)));
    },
    copyOf: (id) => copies.get(id),
    resetViews: reset,
    clear: () => {
      reset();
      dataEpoch += 1;
      copies.clear();
      fetching.clear();
    }
  };
}
