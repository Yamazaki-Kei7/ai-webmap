import { urlConfig } from './config.js';

/** The one place seconds are converted to milliseconds for the signed-URL lifetime. */
export const millisecondsPerSecond = 1_000;

export const signedUrlTtlMs = urlConfig.signedUrlTtlSeconds * millisecondsPerSecond;

/**
 * When URLs signed at `issuedAt` (epoch milliseconds, read once before signing) expire.
 * The time is cut down to the whole second first: on AWS the signing date has whole-second
 * resolution, so a URL's real expiry can be up to 999 ms earlier than `issuedAt + TTL`.
 * The result is never later than the real expiry of any URL signed after `issuedAt`.
 */
export function signedUrlExpiresAt(issuedAt: number): number {
  return Math.floor(issuedAt / millisecondsPerSecond) * millisecondsPerSecond + signedUrlTtlMs;
}
