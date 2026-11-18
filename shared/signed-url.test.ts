import { describe, expect, it } from 'vitest';
import { urlConfig } from './config';
import { millisecondsPerSecond, signedUrlExpiresAt, signedUrlTtlMs } from './signed-url';

describe('signedUrlExpiresAt', () => {
  const ttlMs = urlConfig.signedUrlTtlSeconds * 1_000;

  it('is the TTL after a time on a second boundary', () => {
    expect(signedUrlTtlMs).toBe(ttlMs);
    expect(signedUrlExpiresAt(5_000)).toBe(5_000 + ttlMs);
  });

  it('cuts a sub-second part down, so it is never later than issuedAt + TTL', () => {
    for (const issuedAt of [5_001, 5_500, 5_999]) {
      const expiresAt = signedUrlExpiresAt(issuedAt);
      expect(expiresAt).toBe(5_000 + ttlMs);
      expect(expiresAt).toBeLessThanOrEqual(issuedAt + ttlMs);
      expect(expiresAt % millisecondsPerSecond).toBe(0);
    }
  });
});
