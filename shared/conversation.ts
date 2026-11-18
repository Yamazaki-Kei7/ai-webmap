/** Error names and statuses of the conversation API (`agent*` methods of `api`). The frontend recognises these. */

export const conversationErrors = {
  /** An argument is missing, malformed or over its limit. */
  InvalidRequest: 'InvalidConversationRequestException',
  /** The conversation does not exist or belongs to another user: the two are not told apart. */
  NotFound: 'ConversationNotFoundException',
  /**
   * `agentResume` named an interrupt that is not pending (forged, answered already, or not yet readable: the store is
   * eventually consistent, so the client may retry once after a short wait).
   */
  InterruptNotPending: 'InterruptNotPendingException',
  /** `agentStream` while the conversation has unanswered interrupts: answer them (`agentResume`) first. Retryable like the above. */
  InterruptsPending: 'InterruptsPendingException'
} as const;

export const conversationStatus = {
  badRequest: 400,
  notFound: 404,
  conflict: 409
} as const;

export const interruptNotPendingMessage = 'Not a pending interrupt of this conversation';
export const interruptsPendingMessage = 'The conversation has unanswered interrupts';

/** Reveals nothing about other users' conversations. */
export const conversationNotFoundMessage = 'Conversation not found';
