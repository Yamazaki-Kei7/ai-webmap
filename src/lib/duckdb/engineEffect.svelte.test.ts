import { flushSync, untrack } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { bindEngineToUser, runEngine } from './engineEffect.svelte';
import type { EngineStatus } from './engineCore';

function setup() {
  const state = $state<{ user: { username: string } | null }>({ user: null });
  const signIn = (username: string): void => {
    state.user = { username };
  };
  const calls: string[] = [];
  const statuses: EngineStatus[] = [];
  const deps = {
    getUser: () => state.user,
    initEngine: vi.fn(async () => {
      // Read untracked: the effect must not depend on it by accident.
      calls.push(`init:${untrack(() => state.user?.username)}`);
    }),
    disposeEngine: vi.fn(async () => {
      calls.push('dispose');
    }),
    setStatus: (status: EngineStatus) => statuses.push(status)
  };
  const stop = $effect.root(() => bindEngineToUser(deps));
  flushSync();
  return { state, signIn, calls, statuses, deps, stop };
}

describe('bindEngineToUser', () => {
  it('does nothing while signed out', () => {
    const { calls, stop } = setup();
    expect(calls).toEqual([]);
    stop();
  });

  it('starts the engine when a user signs in, and disposes it at sign-out', () => {
    const { state, signIn, calls, statuses, stop } = setup();
    signIn('A');
    flushSync();
    expect(calls).toEqual(['init:A']);
    state.user = null;
    flushSync();
    expect(calls).toEqual(['init:A', 'dispose']);
    expect(statuses.at(-1)).toEqual({ state: 'idle' });
    stop();
  });

  it('disposes and starts again when the user changes straight from A to B', () => {
    const { signIn, calls, stop } = setup();
    signIn('A');
    flushSync();
    signIn('B');
    flushSync();
    expect(calls).toEqual(['init:A', 'dispose', 'init:B']);
    stop();
  });

  it('does not restart when the same user is notified again as a new object', () => {
    const { signIn, calls, stop } = setup();
    signIn('A');
    flushSync();
    signIn('A');
    flushSync();
    expect(calls).toEqual(['init:A']);
    stop();
  });

  it('disposes when the component is destroyed', () => {
    const { signIn, calls, stop } = setup();
    signIn('A');
    flushSync();
    stop();
    expect(calls).toEqual(['init:A', 'dispose']);
  });
});

describe('runEngine', () => {
  it('does not throw when the start fails', async () => {
    const failing = vi.fn(async () => {
      throw new Error('boom');
    });
    runEngine(failing, () => undefined);
    await Promise.resolve();
    expect(failing).toHaveBeenCalledTimes(1);
  });
});
