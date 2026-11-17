import { api } from 'aws-blocks';
import type { ChatSessionApi } from './chatSession.svelte';

/** The `agent*` methods of the typed client, as the chat session uses them. */
export const chatApi: ChatSessionApi = {
  createConversationId: () => api.agentCreateConversationId(),
  // `channel.subscribe` is overloaded (a handler, or the options with the reconnect callbacks): the options must reach it intact.
  subscribe: async (conversationId, handlerOrOptions) => {
    const { channel } = await api.agentGetChannel(conversationId);
    return typeof handlerOrOptions === 'function' ? channel.subscribe(handlerOrOptions) : channel.subscribe(handlerOrOptions);
  },
  stream: (message, conversationId, mapContext) => api.agentStream(message, conversationId, mapContext),
  resume: (conversationId, answers) => api.agentResume(conversationId, answers),
  getConversation: (conversationId) => api.agentGetConversation(conversationId),
  getPendingInterrupts: (conversationId) => api.agentGetPendingInterrupts(conversationId)
};
