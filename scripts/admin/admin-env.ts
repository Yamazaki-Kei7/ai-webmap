/**
 * Names of the environment variables read by `npm run admin:create-user`, and its one flag.
 * They describe a deployed app, so they are set in the shell for that one command: the command does not
 * read `.env`, and they are not in `.env.example`. The password is never taken from the command line.
 */
export const adminEnvNames = {
  /** Name of the auth block's user table (see README, "デプロイ先"). */
  table: 'ADMIN_USERS_TABLE',
  /** Name of the user to create, stored exactly as given. */
  username: 'ADMIN_NEW_USERNAME',
  /** Read only when stdin is not a terminal; on a terminal the password is asked at a hidden prompt. */
  password: 'ADMIN_NEW_PASSWORD',
} as const;

/** Builds and validates everything but makes no AWS call and creates no AWS client. */
export const dryRunFlag = '--dry-run';

/** True when every argument is the dry-run flag (none, or the flag). Anything else is refused by the command. */
export function hasOnlyDryRunFlag(args: readonly string[]): boolean {
  return args.every((arg) => arg === dryRunFlag);
}
