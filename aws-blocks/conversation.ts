import type { BlocksContext } from '@aws-blocks/blocks';
import { appendMapState } from '../shared/mapState.js';
import type { MapContext } from '../shared/mapSpec.js';
import { requireAllowedUser } from './access.js';
import { agent } from './agent.js';
import { requireNoPendingInterrupts, requireOwnedConversation, requirePendingInterrupts, unwrap } from './conversation-access.js';
import { checkInterruptAnswers, checkMapContext, checkMessage, type InterruptAnswer } from './conversation-input.js';
import { conversationOwners } from './conversation-owners.js';

/**
 * The conversation API of the chat (the `agent*` methods of `api`). Each method: sign-in and the allow-list first, then
 * the arguments, then ownership of the conversation. The Realtime channel is named after the conversation id the server
 * issued, never after anything the caller supplies, so only the owner is ever handed its handle.
 */
export function conversationMethods(context: BlocksContext) {
  /** Signs in, checks the allow-list and the ownership of `conversationId`: the user's name and the checked id. */
  async function owned(conversationId: string): Promise<{ userId: string; id: string }> {
    const { username } = await requireAllowedUser(context);
    return { userId: username, id: await requireOwnedConversation(conversationOwners, username, conversationId) };
  }

  return {
    async agentCreateConversationId(): Promise<{ conversationId: string }> {
      const { username } = await requireAllowedUser(context);
      const conversationId = await agent.createConversationId(username);
      await conversationOwners.put(conversationId, username);
      return { conversationId };
    },

    async agentGetChannel(conversationId: string) {
      const { id } = await owned(conversationId);
      return { channel: await agent.getChannel(id) };
    },

    async agentStream(message: string, conversationId: string, mapContext: MapContext): Promise<{ channelId: string }> {
      const { userId, id } = await owned(conversationId);
      const text = unwrap(checkMessage(message));
      const map = unwrap(checkMapContext(mapContext));
      requireNoPendingInterrupts(await agent.getPendingInterrupts(id));
      const result = await agent.stream(appendMapState(text, map), { conversationId: id, channelId: id, userId });
      return { channelId: result.channelId };
    },

    async agentResume(conversationId: string, responses: InterruptAnswer[]): Promise<void> {
      const { userId, id } = await owned(conversationId);
      const answers = unwrap(checkInterruptAnswers(responses));
      requirePendingInterrupts(await agent.getPendingInterrupts(id), answers.map(({ interruptId }) => interruptId));
      await agent.resume(id, answers, { conversationId: id, userId });
    },

    async agentGetConversation(conversationId: string) {
      const { id } = await owned(conversationId);
      return { messages: await agent.getConversation(id) };
    },

    async agentGetPendingInterrupts(conversationId: string) {
      const { id } = await owned(conversationId);
      return { interrupts: await agent.getPendingInterrupts(id) };
    }
  };
}
