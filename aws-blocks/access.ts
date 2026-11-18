import { ApiError, AppSetting, Logger } from '@aws-blocks/blocks';
import type { BlocksContext } from '@aws-blocks/blocks';
import { accessErrors, accessStatus, adminRequiredMessage, notAllowedMessage } from '../shared/access.js';
import { auth } from './auth.js';
import { scope } from './scope.js';
import { emptyUserList, parseUserList, storedListSchema, type StoredList } from './user-list.js';

// Both lists are JSON arrays of user names held in an AppSetting (an SSM parameter once deployed).
// An operator changes them; no API method writes them.
export const allowedUsersSetting = new AppSetting(scope, 'allowedUsers', {
  value: emptyUserList,
  schema: storedListSchema,
});
export const adminUsersSetting = new AppSetting(scope, 'adminUsers', {
  value: emptyUserList,
  schema: storedListSchema,
});

const log = new Logger(scope, 'access');

/**
 * Reads a list; a malformed one is empty (fails closed) and the log never contains the list.
 * A read error (the store is unreachable, the parameter was deleted) propagates: the caller gets a 500, which is a refusal.
 */
async function readUserList(setting: AppSetting<StoredList>, name: string): Promise<ReadonlySet<string>> {
  const { users, malformed } = parseUserList(await setting.get());
  if (malformed) log.warn('User list is malformed; treated as empty', { list: name });
  return users;
}

export const readAllowedUsers = () => readUserList(allowedUsersSetting, 'allowedUsers');
export const readAdminUsers = () => readUserList(adminUsersSetting, 'adminUsers');

/**
 * Every method of `api` starts with this one call: sign-in first (an unauthenticated caller gets
 * the 401 that `requireAuth` throws), then the allow-list. Returns the signed-in user.
 *
 * Compared field: `user.username`. AuthBasic does not normalise names: it keeps the name exactly
 * as typed at sign-up, uses it as the store key (case-sensitive) and puts it in the session, so the
 * exact string the operator created the user with is the one that arrives here. Comparing exactly
 * can neither admit a differently-cased name (a different user) nor lock out a listed one. The admin
 * list is independent: being on it does not allow anything here.
 */
export async function requireAllowedUser(context: BlocksContext): Promise<Awaited<ReturnType<typeof auth.requireAuth>>> {
  const user = await auth.requireAuth(context);
  const allowed = await readAllowedUsers();
  if (!allowed.has(user.username)) {
    throw new ApiError(notAllowedMessage, accessStatus.forbidden, { name: accessErrors.NotAllowed });
  }
  return user;
}

/**
 * For the methods only an administrator may call: `requireAllowedUser` first (so the 401 and the
 * "not allowed" error come first, also for a user who is on the admin list only), then the admin list.
 * Returns the signed-in user.
 */
export async function requireAdmin(context: BlocksContext): ReturnType<typeof requireAllowedUser> {
  const user = await requireAllowedUser(context);
  const admins = await readAdminUsers();
  if (!admins.has(user.username)) {
    throw new ApiError(adminRequiredMessage, accessStatus.forbidden, { name: accessErrors.AdminRequired });
  }
  return user;
}
