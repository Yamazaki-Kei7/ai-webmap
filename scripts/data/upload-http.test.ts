import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeSignedUrlRequests } from './upload-http.js';

const url = 'https://bucket.invalid/key?X-Amz-Signature=fake';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('makeSignedUrlRequests', () => {
  it('sends the PUT through the fetch it was given, with the content type and the bytes', async () => {
    const plainFetch = vi.fn<typeof fetch>(async () => new Response('', { status: 200 }));
    const bytes = new Uint8Array([1, 2, 3]);
    expect(await makeSignedUrlRequests(plainFetch).put(url, 'application/wasm', bytes)).toEqual({ status: 200, body: '' });
    expect(plainFetch).toHaveBeenCalledTimes(1);
    expect(plainFetch).toHaveBeenCalledWith(url, { method: 'PUT', headers: { 'Content-Type': 'application/wasm' }, body: bytes });
  });

  it('reads the download through the fetch it was given', async () => {
    const plainFetch = vi.fn<typeof fetch>(async () => new Response(new Uint8Array([7, 8]), { status: 200, headers: { 'Content-Type': 'application/wasm' } }));
    const result = await makeSignedUrlRequests(plainFetch).get(url);
    expect(result).toEqual({ status: 200, contentType: 'application/wasm', bytes: new Uint8Array([7, 8]) });
    expect(plainFetch).toHaveBeenCalledWith(url);
  });

  it('never uses the global fetch, which the cookie jar patches (the session cookie must not reach the signed-URL host)', async () => {
    const patched = vi.fn<typeof fetch>(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', patched);
    const plainFetch = vi.fn<typeof fetch>(async () => new Response('', { status: 200 }));
    const requests = makeSignedUrlRequests(plainFetch);
    await requests.put(url, 'application/wasm', new Uint8Array());
    await requests.get(url);
    expect(patched).not.toHaveBeenCalled();
    expect(plainFetch).toHaveBeenCalledTimes(2);
  });
});
