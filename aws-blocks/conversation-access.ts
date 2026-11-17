import { ApiError } from '@aws-blocks/blocks';
import {
  conversationErrors,
  conversationNotFoundMessage,
  conversationStatus,
  interruptNotPendingMessage,
  interruptsPendingMessage
} from '../shared/conversation.js';
import { checkConversationId, type Checked } from './conversation-input.js';

/** The part of the owner record (a `KVStore` of conversation id to user name) the ownership check uses (a test passes a fake). */
export type ConversationOwners = {
  get(conversationId: string): Promise<string | null>;
};

export function invalidRequest(message: string): ApiError {
  return new ApiError(message, conversationStatus.badRequest, { name: conversationErrors.InvalidRequest });
}

/** The value of a passed check; a failed one is the 400. */
export function unwrap<T>(checked: Checked<T>): T {
  if (!checked.ok) throw invalidRequest(checked.message);
  return checked.value;
}

/**
 * The Agent block does not check who owns a conversation (it reads by id alone), so every conversation method calls this
 * first: the id must be well-formed and recorded as the caller's (one lookup, however many conversations the caller has).
 * A conversation that is someone else's and one that does not exist both answer 404. Returns the checked id.
 */
export async function requireOwnedConversation(owners: ConversationOwners, userId: string, conversationId: string): Promise<string> {
  const id = unwrap(checkConversationId(conversationId));
  if ((await owners.get(id)) !== userId) {
    throw new ApiError(conversationNotFoundMessage, conversationStatus.notFound, { name: conversationErrors.NotFound });
  }
  return id;
}

/**
 * `agentResume` answers only interrupts that are pending, each once. A forged, repeated or already answered id would
 * break the paused session or start a model turn nobody asked for, so the call is refused before it reaches the Agent.
 * The pending list is read from an eventually consistent store: the refusal is a 409 the client may retry once.
 */
export function requirePendingInterrupts(pending: readonly { id: string }[], answeredIds: readonly string[]): void {
  const pendingIds = new Set(pending.map(({ id }) => id));
  const unique = new Set(answeredIds);
  if (unique.size !== answeredIds.length || answeredIds.some((id) => !pendingIds.has(id))) {
    throw new ApiError(interruptNotPendingMessage, conversationStatus.conflict, { name: conversationErrors.InterruptNotPending });
  }
}

/** `agentStream` starts a turn only when no interrupt is waiting for an answer. */
export function requireNoPendingInterrupts(pending: readonly { id: string }[]): void {
  if (pending.length > 0) {
    throw new ApiError(interruptsPendingMessage, conversationStatus.conflict, { name: conversationErrors.InterruptsPending });
  }
}
