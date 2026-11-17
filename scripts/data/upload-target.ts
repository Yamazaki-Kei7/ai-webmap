/**
 * The target guard of `npm run data:upload`. The generated client takes its API URL from the environment or from
 * `.blocks-sandbox/config.json`, which the dev server and every deploy overwrite: following it blindly would upload to
 * whatever was started or deployed last. So the command checks what the file says against the target it was asked for,
 * and hands the checked URL to the client itself (see `upload.ts`).
 */
import { z } from 'zod';
import { devServerPort } from '../seed/seed-env.js';
import { type UploadTarget } from './upload-args.js';

/** Where the client looks for the API URL, in this order: the two variables first, then the file. */
export const clientUrlEnvNames = { apiUrl: 'BLOCKS_API_URL', config: 'BLOCKS_CONFIG' } as const;
export const clientConfigFile = '.blocks-sandbox/config.json';

const environments = ['local', 'sandbox', 'production'] as const;
const configSchema = z.object({ apiUrl: z.string(), environment: z.enum(environments) });

/** Host names that mean this machine. `URL.hostname` keeps the brackets of an IPv6 address. */
const localHostnames = ['localhost', '127.0.0.1', '[::1]'];

const httpProtocols = ['http:', 'https:'];

/** What a deploy that has not finished, or a template, leaves in the URL. */
const placeholderMarkers = ['undefined', '${Token['];

export type GuardInput = {
  target: UploadTarget;
  /** The environment of the process (`process.env`). */
  env: Record<string, string | undefined>;
  /** The text of the client's config file, or undefined when there is none. */
  configText: string | undefined;
};

export type Guarded = { apiUrl: string; environment: UploadTarget; host: string };
export type GuardResult = { ok: true; guarded: Guarded } | { ok: false; message: string };

const startHint: Record<UploadTarget, string> = {
  local: 'Start the local dev server with `npm run dev` (it writes the file).',
  sandbox: 'Deploy the sandbox with `npm run sandbox:deploy` (it writes the file).',
};

function refuse(message: string): GuardResult {
  return { ok: false, message };
}

function isPlaceholder(apiUrl: string): boolean {
  return placeholderMarkers.some((marker) => apiUrl.includes(marker));
}

function parseUrl(apiUrl: string): URL | undefined {
  try {
    return new URL(apiUrl);
  } catch {
    return undefined;
  }
}

function configFromText(text: string): z.infer<typeof configSchema> | undefined {
  try {
    const parsed = configSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function guardTarget({ target, env, configText }: GuardInput): GuardResult {
  const overriding = Object.values(clientUrlEnvNames).filter((name) => env[name]);
  if (overriding.length > 0) {
    return refuse(
      `${overriding.join(' and ')} is set. The client would use it instead of ${clientConfigFile}, so the target could not be checked. Unset it and run this again.`,
    );
  }
  if (configText === undefined) return refuse(`${clientConfigFile} does not exist. ${startHint[target]}`);
  const config = configFromText(configText);
  if (config === undefined) return refuse(`${clientConfigFile} is not a Blocks config (an apiUrl and an environment). ${startHint[target]}`);
  const url = parseUrl(config.apiUrl);
  if (url === undefined || !httpProtocols.includes(url.protocol) || isPlaceholder(config.apiUrl)) {
    return refuse(`${clientConfigFile} has no usable API address yet. ${startHint[target]}`);
  }
  if (config.environment !== target) {
    return refuse(
      `${clientConfigFile} is for the ${config.environment} environment, but the target is ${target}. Nothing was changed. ${startHint[target]}`,
    );
  }
  if (target === 'local' && !(localHostnames.includes(url.hostname) && Number(url.port) === devServerPort)) {
    return refuse(`${clientConfigFile} says local, but its address is not this machine's dev server on port ${devServerPort}. Nothing was changed.`);
  }
  return { ok: true, guarded: { apiUrl: config.apiUrl, environment: target, host: url.host } };
}
