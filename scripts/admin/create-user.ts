/**
 * Operator-only: creates a user of the DEPLOYED app by writing the user record straight into the auth
 * block's table (the app has no sign-up and no API that creates users). Run from the repository root with
 * the operator's own AWS credentials and region in the standard environment (AWS_PROFILE, AWS_REGION).
 * Never overwrites an existing user. Reads no `.env`. The password is asked at a hidden prompt (or, when
 * stdin is not a terminal, read from the environment). The command never reads the password from an argument and
 * never prints it. (npm does print the arguments it is given, so a password typed after the command would show.)
 * `--dry-run` validates and builds the record, prints what would be written without the secret, and makes no AWS client.
 */
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { adminEnvNames, dryRunFlag, hasOnlyDryRunFlag } from './admin-env.js';
import { createUser, type SendPut } from './create-user-command.js';
import { askHidden } from './hidden-prompt.js';
import { buildUserItem, keyAttribute, valueAttribute } from './user-record.js';

/** Printed in place of the hash in the dry run. */
const hashMask = '<hash masked>';

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

/** Prints one error line and returns the failing exit code. */
function fail(message: string): number {
  console.error(message);
  return 1;
}

async function readPassword(): Promise<{ password: string } | { error: string }> {
  if (!process.stdin.isTTY) {
    const password = readEnv(adminEnvNames.password);
    return password === undefined
      ? { error: `stdin is not a terminal: set ${adminEnvNames.password} in the environment of this command.` }
      : { password };
  }
  const password = await askHidden('Password: ');
  const again = await askHidden('Password (again): ');
  return password === again ? { password } : { error: 'The two passwords differ.' };
}

/** The password, or null after the reason has been printed. */
async function readPasswordOrReport(): Promise<string | null> {
  const read = await readPassword();
  if ('error' in read) {
    fail(read.error);
    return null;
  }
  return read.password;
}

async function dryRunCommand(tableName: string | undefined, username: string): Promise<number> {
  const password = await readPasswordOrReport();
  if (password === null) return 1;
  const built = await buildUserItem({ username, password, now: new Date() });
  if (!built.ok) return fail(built.message);
  console.log('Dry run: nothing was sent and no AWS client was created.');
  console.log(`${adminEnvNames.table}: ${tableName === undefined ? 'not set' : 'set'}`);
  console.log(`Would create the user "${username}".`);
  console.log(`Item attributes: ${keyAttribute} (the user name), ${valueAttribute} (the record as a JSON string)`);
  console.log(`Record: ${JSON.stringify({ ...built.record, hash: hashMask })}`);
  return 0;
}

async function createCommand(tableName: string, username: string): Promise<number> {
  const password = await readPasswordOrReport();
  if (password === null) return 1;
  const client = new DynamoDBClient({});
  const send: SendPut = async (input) => {
    await client.send(new PutItemCommand(input));
  };
  const result = await createUser({ tableName, username, password, now: new Date(), send });
  switch (result.status) {
    case 'created':
      console.log(`Created the user "${username}".`);
      return 0;
    case 'exists':
      return fail(`The user "${username}" already exists. Nothing was changed.`);
    case 'invalid':
      return fail(result.message);
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  // Anything but the flag is refused first, and the message does not repeat the argument: it could be a password
  // typed on the command line by mistake (npm itself prints the arguments it is given).
  if (!hasOnlyDryRunFlag(args)) {
    return fail(`Only ${dryRunFlag} is accepted as an argument. The password is never taken from the command line.`);
  }
  const tableName = readEnv(adminEnvNames.table);
  const username = readEnv(adminEnvNames.username);
  if (username === undefined) return fail(`Not set: ${adminEnvNames.username}.`);
  if (args.includes(dryRunFlag)) return dryRunCommand(tableName, username);
  if (tableName === undefined) return fail(`Not set: ${adminEnvNames.table}.`);
  return createCommand(tableName, username);
}

try {
  process.exitCode = await main();
} catch (error) {
  // Only the error's name and message: no stack, and nothing from the inputs is added.
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : 'The command failed.');
  process.exitCode = 1;
}
