import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/**
 * Names of the environment variables that carry the seeded users' credentials.
 *  - admin:   on the allowed list and the admin list (also the upload user)
 *  - allowed: on the allowed list only
 *  - denied:  on neither list
 */
export const seedEnvNames = {
  admin: { username: 'SEED_USERNAME', password: 'SEED_PASSWORD' },
  allowed: { username: 'SEED_ALLOWED_USERNAME', password: 'SEED_ALLOWED_PASSWORD' },
  denied: { username: 'SEED_DENIED_USERNAME', password: 'SEED_DENIED_PASSWORD' },
} as const;

export type SeedRole = keyof typeof seedEnvNames;
function isSeedRole(name: string): name is SeedRole {
  return name in seedEnvNames;
}
// Derived from `seedEnvNames` itself: there is no second list that can drift.
export const seedRoles: SeedRole[] = Object.keys(seedEnvNames).filter(isSeedRole);

/** Every variable name above, for removing them from a child process's environment. */
// Derived from `seedEnvNames` itself, so a role added there cannot be left out.
export const allSeedEnvNames: string[] = Object.values(seedEnvNames).flatMap((names) => Object.values(names));

/** Local file (git-ignored) read when the variables are not already set. */
export const seedEnvFile = '.env';

/** Port of this project's dev server; the seed script refuses to run while it is listening. */
export const devServerPort = 3000;

export type SeedCredentials = { username: string; password: string };
export type SeedUsers = Record<SeedRole, SeedCredentials>;

/** Reads a variable from the environment, falling back to `.env`; `process.env` is not modified. */
function envReader(): (name: string) => string | undefined {
  const fileValues = existsSync(seedEnvFile) ? parseEnv(readFileSync(seedEnvFile, 'utf8')) : {};
  return (name) => process.env[name] ?? fileValues[name];
}

/** One role's pair; the names of the variables that are not set are added to `missing`. */
function credentialsOf(read: (name: string) => string | undefined, role: SeedRole, missing: string[]): SeedCredentials {
  const { username: usernameName, password: passwordName } = seedEnvNames[role];
  const username = read(usernameName);
  const password = read(passwordName);
  if (!username) missing.push(usernameName);
  if (!password) missing.push(passwordName);
  return { username: username ?? '', password: password ?? '' };
}

/** Reads the credentials from the environment, falling back to `.env`; `process.env` is not modified. Returns the names of missing variables. */
export function readSeedCredentials(): { credentials: SeedUsers } | { missing: string[] } {
  const read = envReader();
  const missing: string[] = [];
  const credentials: SeedUsers = {
    admin: credentialsOf(read, 'admin', missing),
    allowed: credentialsOf(read, 'allowed', missing),
    denied: credentialsOf(read, 'denied', missing),
  };
  return missing.length > 0 ? { missing } : { credentials };
}

/** Reads one role's pair only (the other roles need not be set), the same way as `readSeedCredentials`. */
export function readSeedRole(role: SeedRole): { credentials: SeedCredentials } | { missing: string[] } {
  const missing: string[] = [];
  const credentials = credentialsOf(envReader(), role, missing);
  return missing.length > 0 ? { missing } : { credentials };
}

export function missingCredentialsMessage(missing: string[]): string {
  return `Seed credentials are not set (${missing.join(', ')}). Set them in ${seedEnvFile} (see .env.example) or in the environment.`;
}
