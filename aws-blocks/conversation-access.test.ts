import { ApiError } from '@aws-blocks/blocks';
import { describe, expect, it, vi } from 'vitest';
import { conversationErrors, conversationStatus } from '../shared/conversation';
import { requireNoPendingInterrupts, requireOwnedConversation, requirePendingInterrupts, type ConversationOwners } from './conversation-access';

const mine = '3f2b8c1e-5d4a-4b7e-9c1d-2a6f8e0b1c3d';
const theirs = '9a7c1d2e-8b3f-4c6a-a1e5-0d4b7f2c9e18';

/** A fake owner record: conversation id to user name. */
function fakeOwners(owners: Record<string, string>) {
  return { get: vi.fn(async (conversationId: string) => owners[conversationId] ?? null) } satisfies ConversationOwners;
}

async function rejection<T>(promise: Promise<T>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

function thrown(call: () => void): ApiError {
  try {
    call();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected a throw');
}

describe('requireOwnedConversation', () => {
  const owners = fakeOwners({ [mine]: 'alice', [theirs]: 'bob' });

  it('returns the id of a conversation the user owns, with one lookup of that id', async () => {
    await expect(requireOwnedConversation(owners, 'alice', mine)).resolves.toBe(mine);
    expect(owners.get).toHaveBeenCalledTimes(1);
    expect(owners.get).toHaveBeenCalledWith(mine);
  });

  it("answers 404 for another user's conversation and for one that does not exist alike", async () => {
    for (const id of [theirs, '00000000-0000-4000-8000-000000000000']) {
      const error = await rejection(requireOwnedConversation(owners, 'alice', id));
      expect(error.status).toBe(conversationStatus.notFound);
      expect(error.name).toBe(conversationErrors.NotFound);
    }
  });

  it('answers 400 for a malformed id, before it asks the owner record anything', async () => {
    const fresh = fakeOwners({ [mine]: 'alice' });
    for (const id of ['', 'L1', mine.toUpperCase().slice(1)]) {
      const error = await rejection(requireOwnedConversation(fresh, 'alice', id));
      expect(error.status).toBe(conversationStatus.badRequest);
      expect(error.name).toBe(conversationErrors.InvalidRequest);
    }
    expect(fresh.get).not.toHaveBeenCalled();
  });

  it('answers 404 for a user who owns nothing', async () => {
    const error = await rejection(requireOwnedConversation(owners, 'carol', mine));
    expect(error.status).toBe(conversationStatus.notFound);
  });
});

describe('requirePendingInterrupts', () => {
  const pending = [{ id: 'a' }, { id: 'b' }];

  it('accepts answers for pending interrupts, all or some', () => {
    expect(() => requirePendingInterrupts(pending, ['a', 'b'])).not.toThrow();
    expect(() => requirePendingInterrupts(pending, ['b'])).not.toThrow();
  });

  it.each([
    ['a forged id', ['forged']],
    ['a forged id among real ones', ['a', 'forged']],
    ['a repeated id', ['a', 'a']]
  ])('answers 409 for %s', (_what, ids) => {
    const error = thrown(() => requirePendingInterrupts(pending, ids));
    expect(error.status).toBe(conversationStatus.conflict);
    expect(error.name).toBe(conversationErrors.InterruptNotPending);
  });

  it('answers 409 when nothing is pending (an answer after the turn is done)', () => {
    expect(thrown(() => requirePendingInterrupts([], ['a'])).status).toBe(conversationStatus.conflict);
  });
});

describe('requireNoPendingInterrupts', () => {
  it('lets a turn start when nothing is pending, and refuses with 409 when something is', () => {
    expect(() => requireNoPendingInterrupts([])).not.toThrow();
    const error = thrown(() => requireNoPendingInterrupts([{ id: 'a' }]));
    expect(error.status).toBe(conversationStatus.conflict);
    expect(error.name).toBe(conversationErrors.InterruptsPending);
  });
});
