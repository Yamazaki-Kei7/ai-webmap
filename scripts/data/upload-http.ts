/**
 * The requests to signed URLs. They take the `fetch` to use as a parameter: the entry passes the original `fetch`,
 * taken before `installCookieJar()` patches the global one. The patched `fetch` adds the app's session cookie to every
 * request whatever the host, and a signed URL (S3 on a sandbox) must never receive it; only the typed client uses the jar.
 */
import type { FlowDeps } from './upload-flow.js';

export type SignedUrlRequests = Pick<FlowDeps, 'put' | 'get'>;

export function makeSignedUrlRequests(plainFetch: typeof fetch): SignedUrlRequests {
  return {
    put: async (url, contentType, bytes) => {
      const response = await plainFetch(url, { method: 'PUT', headers: { 'Content-Type': contentType }, body: bytes });
      return { status: response.status, body: await response.text() };
    },
    get: async (url) => {
      const response = await plainFetch(url);
      return { status: response.status, contentType: response.headers.get('content-type') ?? undefined, bytes: new Uint8Array(await response.arrayBuffer()) };
    },
  };
}
