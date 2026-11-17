import type { ChatController } from '@aws-blocks/bb-agent/client';
import { describe, expect, it, vi } from 'vitest';
import { chatConfig } from '../../../shared/config';
import type { ClientToolRequest } from '../../../shared/toolProtocol';

// `createChat` refuses a message (returns false) while its own `loading` is true. The turns of this app do not reach that
// state, so the refusal is produced here with a stand-in controller: the session must end the turn with the message,
// not leave the loading state on.
const handlers: { onInterrupt?: (interrupts: { interruptId: string; name: string; reason?: object }[]) => void } = {};
const sendMessage = vi.fn<ChatController['sendMessage']>(async () => false);

vi.mock('@aws-blocks/bb-agent/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-blocks/bb-agent/client')>()),
  createChat: (options: { onInterrupt?: typeof handlers.onInterrupt }) => {
    handlers.onInterrupt = options.onInterrupt;
    return { sendMessage, destroy: vi.fn(), getConversationId: () => 'conversation-1' };
  }
}));

const { createChatSession } = await import('./chatSession.svelte');

const request: ClientToolRequest = { tool: 'setView', input: { target: { type: 'center', center: [139.7, 35.7], zoom: 9 } } };

function session() {
  return createChatSession({
    api: {
      createConversationId: async () => ({ conversationId: 'conversation-1' }),
      subscribe: async () => ({ unsubscribe: () => undefined, established: Promise.resolve() }),
      stream: async () => ({ channelId: 'conversation-1' }),
      resume: async () => undefined,
      getConversation: async () => ({ messages: [] }),
      getPendingInterrupts: async () => ({ interrupts: [] })
    },
    owner: 'a',
    store: { read: () => null, write: () => undefined, clear: () => undefined },
    executor: async () => ({ ok: true, data: { center: [139.7, 35.7], zoom: 9 } }),
    mapContext: () => ({ view: { center: [139.7, 35.7], zoom: 9 }, layers: [] })
  });
}

describe('a message that createChat does not accept', () => {
  it('ends the turn with the message when the answer to the interrupts is refused', async () => {
    const chat = session();
    await chat.send('駅');
    expect(chat.isLoading).toBe(false);
    expect(chat.error).toBe(chatConfig.text.answerNotSent);

    sendMessage.mockClear();
    // A turn paused at an interrupt whose answer is refused.
    sendMessage.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await chat.send('もう一度');
    expect(chat.isLoading).toBe(true);
    handlers.onInterrupt?.([{ interruptId: 'i1', name: 'client:setView', reason: request }]);
    await vi.waitFor(() => expect(chat.isLoading).toBe(false));
    expect(chat.error).toBe(chatConfig.text.answerNotSent);
    chat.dispose();
  });
});
