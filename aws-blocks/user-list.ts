import { z } from 'zod';

/**
 * Pure parsing of the stored allow-list / admin list. Constructs no Building Block,
 * so it can be unit-tested. The list is a JSON array of user names.
 */

/**
 * What `AppSetting.get()` may return for a list. On AWS the block parses the stored JSON,
 * so an operator-written `["a"]` arrives as an array; a value written as a JSON string
 * (or by hand into the local store) arrives as a string. Both are accepted.
 */
export const storedListSchema = z.json();
export type StoredList = z.infer<typeof storedListSchema>;

/** Value a list holds until an operator sets it: nobody. */
export const emptyUserList: string[] = [];

const userNamesSchema = z.array(z.string());

export type UserListResult = {
  users: ReadonlySet<string>;
  /** True when a value was present but is not a JSON array of strings. */
  malformed: boolean;
};

const failClosed = (malformed: boolean): UserListResult => ({ users: new Set(), malformed });

function parseArray(value: StoredList): UserListResult {
  const parsed = userNamesSchema.safeParse(value);
  return parsed.success ? { users: new Set(parsed.data), malformed: false } : failClosed(true);
}

/** Anything that is not a JSON array of strings yields an empty list (everyone is refused). */
export function parseUserList(stored: StoredList | undefined): UserListResult {
  // Not set (or set to nothing): the expected default, not a malformed value.
  if (stored === undefined || stored === '') return failClosed(false);
  if (typeof stored !== 'string') return parseArray(stored);
  try {
    return parseArray(JSON.parse(stored));
  } catch {
    return failClosed(true);
  }
}

export type MergePlan = {
  /** What to write, or null when the list already has every name and is well formed. */
  next: string[] | null;
  malformed: boolean;
};

/**
 * Seeding decision: add the missing names, keep every existing entry and its order, never remove.
 * A malformed list is what the app treats as empty, so it is replaced by the seeded names.
 */
export function planMerge(stored: StoredList | undefined, names: readonly string[]): MergePlan {
  const { users, malformed } = parseUserList(stored);
  const missing = names.filter((name) => !users.has(name));
  if (missing.length === 0 && !malformed) return { next: null, malformed };
  return { next: [...users, ...missing], malformed };
}

/** Labels of the lists that already hold the name. */
export function listsHolding(name: string, lists: Readonly<Record<string, ReadonlySet<string>>>): string[] {
  return Object.keys(lists).filter((label) => lists[label]?.has(name));
}
