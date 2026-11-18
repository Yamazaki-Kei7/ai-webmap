/** Helpers shared by the tests of the user-creation helper. Not collected as a test file. */
import { z } from 'zod';
import type { UserItem } from './user-record.js';

/**
 * The same shape as `UserRecord` in `user-record.ts`: the type serves the builder (no zod there), this schema decodes in tests.
 * Strict on purpose: an extra or a missing field fails, which is what the format comparison needs. */
export const storedRecordSchema = z.strictObject({ hash: z.string(), createdAt: z.string() });

export type StoredRecord = z.infer<typeof storedRecordSchema>;

/** Decodes the `value` attribute the way the AWS key-value block reads it back: a JSON string literal holding the record's JSON. */
export function decodeItemRecord(item: UserItem): StoredRecord {
  const recordJson = z.string().parse(JSON.parse(item.value.S));
  return storedRecordSchema.parse(JSON.parse(recordJson));
}

/** Decodes the string the block's `signUp` hands to the key-value store (the record's JSON). */
export function decodeRecordJson(recordJson: string): StoredRecord {
  return storedRecordSchema.parse(JSON.parse(recordJson));
}
