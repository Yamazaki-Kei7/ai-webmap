import { describe, expect, it } from 'vitest';
import { devServerPort } from '../seed/seed-env.js';
import { clientConfigFile, clientUrlEnvNames, guardTarget, type GuardInput } from './upload-target.js';

const localUrl = `http://localhost:${devServerPort}/aws-blocks/api`;
const sandboxUrl = 'https://abc123.example.invalid/aws-blocks/api';

function configText(environment: string, apiUrl: string): string {
  return JSON.stringify({ apiUrl, environment });
}

function input(overrides: Partial<GuardInput>): GuardInput {
  return { target: 'local', env: {}, configText: configText('local', localUrl), ...overrides };
}

function refusalOf(guardInput: GuardInput): string {
  const result = guardTarget(guardInput);
  if (result.ok) throw new Error('expected a refusal');
  return result.message;
}

describe('guardTarget', () => {
  it('accepts a local config for the local target and returns the checked URL and host', () => {
    expect(guardTarget(input({}))).toEqual({ ok: true, guarded: { apiUrl: localUrl, environment: 'local', host: `localhost:${devServerPort}` } });
  });

  it('accepts the other spellings of this machine', () => {
    for (const host of ['127.0.0.1', '[::1]']) {
      const apiUrl = `http://${host}:${devServerPort}/aws-blocks/api`;
      expect(guardTarget(input({ configText: configText('local', apiUrl) })).ok).toBe(true);
    }
  });

  it('accepts a sandbox config for the sandbox target', () => {
    const result = guardTarget(input({ target: 'sandbox', configText: configText('sandbox', sandboxUrl) }));
    expect(result).toEqual({ ok: true, guarded: { apiUrl: sandboxUrl, environment: 'sandbox', host: 'abc123.example.invalid' } });
  });

  it('refuses when either variable that overrides the config file is set', () => {
    for (const name of Object.values(clientUrlEnvNames)) {
      const message = refusalOf(input({ env: { [name]: 'anything' } }));
      expect(message).toContain(name);
      expect(message).not.toContain('anything');
    }
    // Set but empty: the client ignores an empty value, so the guard does too.
    expect(guardTarget(input({ env: { [clientUrlEnvNames.apiUrl]: '' } })).ok).toBe(true);
  });

  it('refuses a missing config file and says what to start', () => {
    expect(refusalOf(input({ configText: undefined }))).toContain('npm run dev');
    expect(refusalOf(input({ target: 'sandbox', configText: undefined }))).toContain('npm run sandbox:deploy');
    expect(refusalOf(input({ configText: undefined }))).toContain(clientConfigFile);
  });

  it('refuses a file that is not a Blocks config, and a placeholder address', () => {
    for (const text of ['not json', '{}', JSON.stringify({ apiUrl: localUrl }), JSON.stringify({ apiUrl: 1, environment: 'local' })]) {
      expect(refusalOf(input({ configText: text }))).toContain('not a Blocks config');
    }
    for (const apiUrl of ['', 'undefined', 'https://undefined/aws-blocks/api', 'https://x.invalid/${Token[TOKEN.12]}/api', '/aws-blocks/api', `httpx://localhost:${devServerPort}/aws-blocks/api`, `ftp://localhost:${devServerPort}/x`]) {
      expect(refusalOf(input({ configText: configText('local', apiUrl) }))).toContain('no usable API address');
    }
  });

  it('refuses an environment that is not the target, in both directions', () => {
    expect(refusalOf(input({ configText: configText('sandbox', sandboxUrl) }))).toContain('sandbox environment, but the target is local');
    expect(refusalOf(input({ target: 'sandbox' }))).toContain('local environment, but the target is sandbox');
  });

  it('refuses production as the environment of the config for either target', () => {
    for (const target of ['local', 'sandbox'] as const) {
      expect(refusalOf(input({ target, configText: configText('production', sandboxUrl) }))).toContain('production environment');
    }
  });

  it('refuses a local config that is not this machine or not this dev server port', () => {
    expect(refusalOf(input({ configText: configText('local', 'http://example.invalid:3000/aws-blocks/api') }))).toContain('not this machine');
    expect(refusalOf(input({ configText: configText('local', `http://localhost:${devServerPort + 1}/aws-blocks/api`) }))).toContain('not this machine');
    expect(refusalOf(input({ configText: configText('local', 'http://localhost/aws-blocks/api') }))).toContain('not this machine');
  });

  it('does not print the address in any refusal', () => {
    const messages = [
      refusalOf(input({ configText: configText('sandbox', sandboxUrl) })),
      refusalOf(input({ configText: configText('local', 'http://example.invalid:3000/aws-blocks/api') })),
      refusalOf(input({ configText: configText('local', 'undefined') })),
    ];
    for (const message of messages) {
      expect(message).not.toContain('example.invalid');
      expect(message).not.toContain('abc123');
      expect(message).not.toContain('/aws-blocks/api');
    }
  });
});
