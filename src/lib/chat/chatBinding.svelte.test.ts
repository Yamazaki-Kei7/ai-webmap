import { flushSync } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { bindChatToUser } from './chatBinding.svelte';
import type { ChatSession } from './chatSession.svelte';

function fakeSession(): ChatSession {
  return { messages: [], isLoading: false, activity: [], error: null, send: vi.fn(async () => undefined), reset: vi.fn(), dispose: vi.fn() };
}

function setup() {
  const state = $state<{ user: { username: string } | null }>({ user: null });
  const created: { owner: string; session: ChatSession }[] = [];
  let binding: ReturnType<typeof bindChatToUser> | undefined;
  const stop = $effect.root(() => {
    binding = bindChatToUser({
      getOwner: () => state.user?.username ?? null,
      createSession: (owner) => {
        const session = fakeSession();
        created.push({ owner, session });
        return session;
      }
    });
  });
  flushSync();
  return { state, created, session: () => binding?.session, stop };
}

describe('bindChatToUser', () => {
  it('has no session while signed out', () => {
    const { created, session, stop } = setup();
    expect(created).toEqual([]);
    expect(session()).toBeUndefined();
    stop();
  });

  it('makes a session for the user and disposes it at sign-out', () => {
    const { state, created, session, stop } = setup();
    state.user = { username: 'A' };
    flushSync();
    expect(created.map(({ owner }) => owner)).toEqual(['A']);
    expect(session()).toBe(created[0].session);
    state.user = null;
    flushSync();
    expect(created[0].session.dispose).toHaveBeenCalledOnce();
    expect(session()).toBeUndefined();
    stop();
  });

  it('disposes the session of A and makes one for B when the user changes straight from A to B', () => {
    const { state, created, session, stop } = setup();
    state.user = { username: 'A' };
    flushSync();
    state.user = { username: 'B' };
    flushSync();
    expect(created.map(({ owner }) => owner)).toEqual(['A', 'B']);
    expect(created[0].session.dispose).toHaveBeenCalledOnce();
    expect(created[1].session.dispose).not.toHaveBeenCalled();
    expect(session()).toBe(created[1].session);
    stop();
  });

  it('keeps the session when the same user is notified again as a new object', () => {
    const { state, created, stop } = setup();
    state.user = { username: 'A' };
    flushSync();
    state.user = { username: 'A' };
    flushSync();
    expect(created).toHaveLength(1);
    expect(created[0].session.dispose).not.toHaveBeenCalled();
    stop();
  });

  it('disposes the session when its owner goes away with the component', () => {
    const { state, created, stop } = setup();
    state.user = { username: 'A' };
    flushSync();
    stop();
    expect(created[0].session.dispose).toHaveBeenCalledOnce();
  });
});
