import { accessStatus } from '../../../shared/access';
import { urlConfig } from '../../../shared/config';
import { millisecondsPerSecond } from '../../../shared/signed-url';

/** What `api.getDatasetSources()` returns. */
export type DatasetSources = {
  sources: { id: string; url: string }[];
  wasmUrl: string;
  /** Epoch milliseconds. */
  expiresAt: number;
};

/** The part of a `Response` the data fetch needs. */
export type DataResponse = Pick<Response, 'ok' | 'status' | 'arrayBuffer'>;

export type SourceStoreDeps = {
  now: () => number;
  fetchSources: () => Promise<DatasetSources>;
};

export type SourceStore = {
  /** Always asks the backend for new URLs (every initialisation does). */
  refresh: () => Promise<DatasetSources>;
  /** The held URLs, or new ones when there are none or they expire within the margin. */
  current: () => Promise<DatasetSources>;
  /** Reads one dataset file; an answer of 403 fetches new URLs and reads once more (never a second time). */
  fetchData: (id: string, get: (url: string) => Promise<DataResponse>) => Promise<DataResponse>;
  /** Forgets the held URLs. */
  clear: () => void;
};

const refreshMarginMs = urlConfig.refreshMarginSeconds * millisecondsPerSecond;

/** The URL refresh rule (design): pure apart from the injected clock and backend call. */
export function createSourceStore({ now, fetchSources }: SourceStoreDeps): SourceStore {
  let held: DatasetSources | undefined;
  let pending: Promise<DatasetSources> | undefined;
  // `clear()` starts a new epoch: an answer that arrives from an older one is not stored and not shared.
  let epoch = 0;

  function refresh(): Promise<DatasetSources> {
    // Callers that ask while a request is running share it.
    if (pending === undefined) {
      const requestEpoch = epoch;
      const request: Promise<DatasetSources> = fetchSources()
        .then((fresh) => {
          if (requestEpoch === epoch) held = fresh;
          return fresh;
        })
        .finally(() => {
          if (pending === request) pending = undefined;
        });
      pending = request;
    }
    return pending;
  }

  async function current(): Promise<DatasetSources> {
    if (held !== undefined && now() < held.expiresAt - refreshMarginMs) return held;
    return refresh();
  }

  function urlOf(sources: DatasetSources, id: string): string {
    const source = sources.sources.find((candidate) => candidate.id === id);
    if (source === undefined) throw new Error(`Unknown dataset: ${id}`);
    return source.url;
  }

  async function fetchData(id: string, get: (url: string) => Promise<DataResponse>): Promise<DataResponse> {
    const response = await get(urlOf(await current(), id));
    if (response.status !== accessStatus.forbidden) return response;
    return get(urlOf(await refresh(), id));
  }

  return {
    refresh,
    current,
    fetchData,
    clear: () => {
      epoch += 1;
      held = undefined;
      pending = undefined;
    }
  };
}
