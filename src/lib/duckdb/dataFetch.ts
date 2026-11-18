import { engineConfig } from '../../../shared/config';

/** What the data fetch passes to `fetch`: the signal that aborts it. */
export type FetchInit = { signal: AbortSignal };

/**
 * The fetch of a data file, aborted when it is not done within `engineConfig.dataFetchTimeoutMs`. The signal also ends
 * the read of the body (`arrayBuffer()`): a fetch that hangs anywhere rejects, and the next query fetches the file again.
 */
export function withDataFetchTimeout<R>(get: (url: string, init: FetchInit) => Promise<R>): (url: string) => Promise<R> {
  return (url) => get(url, { signal: AbortSignal.timeout(engineConfig.dataFetchTimeoutMs) });
}
