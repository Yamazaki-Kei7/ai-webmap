import { describe, expect, it, vi } from 'vitest';
import { urlConfig } from '../../../shared/config';
import { millisecondsPerSecond } from '../../../shared/signed-url';
import { createSourceStore, type DataResponse, type DatasetSources } from './sources';

const marginMs = urlConfig.refreshMarginSeconds * millisecondsPerSecond;
const ttlMs = urlConfig.signedUrlTtlSeconds * millisecondsPerSecond;

function sourcesAt(issuedAt: number, tag: string): DatasetSources {
  return { sources: [{ id: 'stations', url: `https://files.test/stations?sig=${tag}` }], wasmUrl: `wasm-${tag}`, expiresAt: issuedAt + ttlMs };
}

function response(status: number): DataResponse {
  return { ok: status >= 200 && status < 300, status, arrayBuffer: async () => new ArrayBuffer(0) };
}

function setup() {
  let time = 0;
  let issued = 0;
  const fetchSources = vi.fn(async () => sourcesAt(time, String(++issued)));
  const store = createSourceStore({ now: () => time, fetchSources });
  return { store, fetchSources, setTime: (value: number) => { time = value; } };
}

describe('the URL refresh rule', () => {
  it('fetches the sources on the first use and then holds them', async () => {
    const { store, fetchSources } = setup();
    await store.current();
    await store.current();
    expect(fetchSources).toHaveBeenCalledTimes(1);
  });

  it('holds the URLs until the margin before expiry, and fetches new ones from there on', async () => {
    const { store, fetchSources, setTime } = setup();
    await store.current();
    setTime(ttlMs - marginMs - 1);
    await store.current();
    expect(fetchSources).toHaveBeenCalledTimes(1);
    setTime(ttlMs - marginMs);
    const fresh = await store.current();
    expect(fetchSources).toHaveBeenCalledTimes(2);
    expect(fresh.expiresAt).toBe(ttlMs - marginMs + ttlMs);
  });

  it('fetches new URLs when asked to refresh, even if the held ones are valid', async () => {
    const { store, fetchSources } = setup();
    await store.current();
    await store.refresh();
    expect(fetchSources).toHaveBeenCalledTimes(2);
  });

  it('shares one request between callers that refresh at the same time', async () => {
    const { store, fetchSources } = setup();
    await Promise.all([store.refresh(), store.refresh(), store.current()]);
    expect(fetchSources).toHaveBeenCalledTimes(1);
  });

  it('forgets the held URLs on clear', async () => {
    const { store, fetchSources } = setup();
    await store.current();
    store.clear();
    await store.current();
    expect(fetchSources).toHaveBeenCalledTimes(2);
  });

  it('returns a successful data response without a second request', async () => {
    const { store, fetchSources } = setup();
    const get = vi.fn(async () => response(200));
    expect((await store.fetchData('stations', get)).status).toBe(200);
    expect(get).toHaveBeenCalledTimes(1);
    expect(fetchSources).toHaveBeenCalledTimes(1);
  });

  it('answers 403 with new sources and one more try with the new URL', async () => {
    const { store, fetchSources } = setup();
    const get = vi.fn(async (url: string) => response(url.endsWith('sig=1') ? 403 : 200));
    expect((await store.fetchData('stations', get)).status).toBe(200);
    expect(get.mock.calls.map(([url]) => url)).toEqual(['https://files.test/stations?sig=1', 'https://files.test/stations?sig=2']);
    expect(fetchSources).toHaveBeenCalledTimes(2);
  });

  it('does not try a third time when the second answer is 403 too', async () => {
    const { store, fetchSources } = setup();
    const get = vi.fn(async () => response(403));
    expect((await store.fetchData('stations', get)).status).toBe(403);
    expect(get).toHaveBeenCalledTimes(2);
    expect(fetchSources).toHaveBeenCalledTimes(2);
  });

  it('does not retry other errors', async () => {
    const { store } = setup();
    const get = vi.fn(async () => response(500));
    expect((await store.fetchData('stations', get)).status).toBe(500);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('rejects an id the sources do not list, before any data request', async () => {
    const { store } = setup();
    const get = vi.fn(async () => response(200));
    await expect(store.fetchData('nowhere', get)).rejects.toThrow('Unknown dataset: nowhere');
    expect(get).not.toHaveBeenCalled();
  });

  it('does not store or share an answer that arrives after clear', async () => {
    let time = 0;
    const answers: ((value: DatasetSources) => void)[] = [];
    const fetchSources = vi.fn(() => new Promise<DatasetSources>((resolve) => answers.push(resolve)));
    const store = createSourceStore({ now: () => time, fetchSources });
    const first = store.current();
    store.clear();
    const second = store.current();
    expect(fetchSources).toHaveBeenCalledTimes(2);
    // The newer answer comes first; the older one arrives last and must not replace it.
    answers[1](sourcesAt(time, 'new'));
    expect((await second).wasmUrl).toBe('wasm-new');
    answers[0](sourcesAt(time, 'old'));
    expect((await first).wasmUrl).toBe('wasm-old');
    expect((await store.current()).wasmUrl).toBe('wasm-new');
    expect(fetchSources).toHaveBeenCalledTimes(2);
  });
});
