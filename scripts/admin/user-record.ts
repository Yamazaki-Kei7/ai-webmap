/**
 * Builds the DynamoDB item that the auth block's `signUp` would store, on AWS, for a confirmed user.
 * Pure: no AWS SDK, no Building Block, no clock (the time is a parameter).
 *
 * Everything here mirrors `@aws-blocks/bb-auth-basic` 0.2.0 and `@aws-blocks/bb-kv-store` 0.4.0, none of which
 * exports what is needed. It is a copy that can drift: re-check it when either package is upgraded.
 */
import bcrypt from 'bcryptjs';
import type { PasswordPolicy } from '@aws-blocks/blocks';
import { passwordPolicy } from '../../aws-blocks/password-policy.js';

/** bcrypt cost factor. Mirrors `BCRYPT_COST` in bb-auth-basic `src/index.ts` (line 164). */
export const bcryptCost = 12;

/** Minimum length when the policy sets none. Mirrors bb-auth-basic `src/index.ts` (line 413). */
const defaultMinLength = 8;

/** Partition key attribute of the key-value table. Mirrors bb-kv-store `src/index.cdk.ts` (line 95) and `index.aws.ts` (line 99). */
export const keyAttribute = 'pk';

/** Attribute holding the encoded value. Mirrors bb-kv-store `src/index.aws.ts` (line 99). */
export const valueAttribute = 'value';

/** The block's `signUp` checks no property of the name; DynamoDB cannot store an empty partition key, so this helper refuses it. */
export const emptyUsernameMessage = 'The user name must not be empty.';

/** Stored form of a user, as `UserRecord` in bb-auth-basic `src/index.ts` (lines 139-144). No `unconfirmed`: the app sets no `codeDelivery`. */
export type UserRecord = { hash: string; createdAt: string };

/** The item as DynamoDB attribute values (strings only). */
export type UserItem = {
  [keyAttribute]: { S: string };
  [valueAttribute]: { S: string };
};

export type BuildUserItemInput = { username: string; password: string; now: Date };

export type BuildUserItemResult = { ok: true; item: UserItem; record: UserRecord } | { ok: false; message: string };

/**
 * Mirrors `validatePassword` in bb-auth-basic `src/index.ts` (lines 411-424), including the message.
 * Names the rules only: the password is never part of the returned text.
 */
export function passwordViolations(password: string, policy: PasswordPolicy = passwordPolicy): string[] {
  const minLength = policy.minLength ?? defaultMinLength;
  const violations: string[] = [];
  if (password.length < minLength) violations.push(`at least ${minLength} characters`);
  if (policy.requireUppercase && !/[A-Z]/.test(password)) violations.push('an uppercase letter');
  if (policy.requireLowercase && !/[a-z]/.test(password)) violations.push('a lowercase letter');
  if (policy.requireDigits && !/\d/.test(password)) violations.push('a digit');
  if (policy.requireSpecialChars && !/[^A-Za-z0-9]/.test(password)) violations.push('a special character');
  return violations;
}

export async function buildUserItem({ username, password, now }: BuildUserItemInput): Promise<BuildUserItemResult> {
  if (username === '') return { ok: false, message: emptyUsernameMessage };
  const violations = passwordViolations(password);
  if (violations.length > 0) return { ok: false, message: `Password must contain ${violations.join(', ')}` };

  const record: UserRecord = { hash: await bcrypt.hash(password, bcryptCost), createdAt: now.toISOString() };
  // The block stores `JSON.stringify(record)` as the KVStore value, and the AWS KVStore stores
  // `JSON.stringify(value)` again: a JSON string literal that contains the JSON of the record.
  const item: UserItem = {
    [keyAttribute]: { S: username },
    [valueAttribute]: { S: JSON.stringify(JSON.stringify(record)) },
  };
  return { ok: true, item, record };
}
