/**
 * Operator-only: creates the local / E2E users by calling the block's `auth.signUp` directly,
 * and puts them on the local lists (the admin on the allowed and admin lists, the allowed user
 * on the allowed list; the denied user on neither). Sign-up is not reachable through the app's API.
 * Run with the dev server stopped (the local mock store is read once at start-up), from the repository root.
 */
import { ApiError, AuthBasicErrors } from '@aws-blocks/blocks';
import { isServerRunning } from '@aws-blocks/blocks/utils';
import { adminUsersSetting, allowedUsersSetting } from '../../aws-blocks/access.js';
import { auth } from '../../aws-blocks/auth.js';
import { listsHolding, parseUserList, planMerge } from '../../aws-blocks/user-list.js';
import { devServerPort, missingCredentialsMessage, readSeedCredentials, seedEnvNames, seedRoles } from './seed-env.js';

type ListSetting = typeof allowedUsersSetting;

/** Adds the names that are missing, keeping every existing entry and its order. Never removes. */
async function mergeIntoList(setting: ListSetting, label: string, names: string[]): Promise<void> {
  const plan = planMerge(await setting.get(), names);
  if (plan.malformed) {
    // The app treats a malformed list as empty, so nothing usable is lost. The content is not printed.
    console.warn(`The local ${label} list is not a JSON array of strings; it is treated as empty and replaced.`);
  }
  if (plan.next === null) {
    console.log(`The ${label} list already has these users; left as is.`);
    return;
  }
  await setting.put(plan.next);
  console.log(`Updated the ${label} list.`);
}

async function main(): Promise<number> {
  if (await isServerRunning(devServerPort)) {
    console.error(`The dev server is running on port ${devServerPort}. Stop it first (npm run dev:stop), then run this again.`);
    return 1;
  }
  const read = readSeedCredentials();
  if ('missing' in read) {
    console.error(missingCredentialsMessage(read.missing));
    return 1;
  }
  const { admin, allowed, denied } = read.credentials;
  if (new Set([admin.username, allowed.username, denied.username]).size !== seedRoles.length) {
    console.error('The three seed user names must differ.');
    return 1;
  }

  // The denied user must be on neither list; this script never removes names, so refuse before changing anything.
  const held = listsHolding(denied.username, {
    allowed: parseUserList(await allowedUsersSetting.get()).users,
    admin: parseUserList(await adminUsersSetting.get()).users,
  });
  if (held.length > 0) {
    console.error(
      `The user name set in ${seedEnvNames.denied.username} is already on the local ${held.join(' and ')} list. ` +
        `Choose another name for the denied user (this script never removes names). Nothing was created or changed.`,
    );
    return 1;
  }

  for (const role of seedRoles) {
    const { username, password } = read.credentials[role];
    try {
      await auth.signUp(username, password);
      console.log(`Created the ${role} user "${username}".`);
    } catch (error) {
      if (!(error instanceof ApiError && error.name === AuthBasicErrors.UserAlreadyExists)) throw error;
      console.log(`The ${role} user "${username}" already exists; left as is.`);
    }
  }

  await mergeIntoList(allowedUsersSetting, 'allowed', [admin.username, allowed.username]);
  await mergeIntoList(adminUsersSetting, 'admin', [admin.username]);
  return 0;
}

process.exitCode = await main();
