import type { ChatController } from '@aws-blocks/bb-agent/client';
import { describe, expect, it, vi } from 'vitest';
import type { ClientToolRequest, ClientToolResult, ToolResultData } from '../../../shared/toolProtocol';

// A conversation is closed when a reset has discarded it and its turn ends. The tool calls it still runs then have nobody to
// answer to: the controller is destroyed, and a message sent through it would resubscribe a channel nothing listens to. The
// events that end a turn mid-call are driven here through a stand-in controller.
type Handlers = {
  onInterrupt?: (interrupts: { interruptId: string; name: string; reason?: object }[]) => void;
  onError?: (message: string, cause?: Error) => void;
};
/** The handlers of every controller made, in order: the first is the conversation of the test, the second the one the reset opens. */
const created: Handlers[] = [];
const sendMessage = vi.fn<ChatController['sendMessage']>(async () => true);
const destroy = vi.fn();

vi.mock('@aws-blocks/bb-agent/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-blocks/bb-agent/client')>()),
  createChat: (options: Handlers) => {
    created.push(options);
    return { sendMessage, destroy, getConversationId: () => 'conversation-1' };
  }
}));

const { createChatSession } = await import('./chatSession.svelte');

const request: ClientToolRequest = { tool: 'setView', input: { target: { type: 'center', center: [139.7, 35.7], zoom: 9 } } };
const result: ClientToolResult<ToolResultData> = { ok: true, data: { center: [139.7, 35.7], zoom: 9 } };

describe('a conversation closed while its tool calls run', () => {
  it('sends no answer for it', async () => {
    let finishCall: (value: ClientToolResult<ToolResultData>) => void = () => undefined;
    const executor = vi.fn(() => new Promise<ClientToolResult<ToolResultData>>((resolve) => (finishCall = resolve)));
    const session = createChatSession({
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
      executor,
      mapContext: () => ({ view: { center: [139.7, 35.7], zoom: 9 }, layers: [] })
    });
    await session.send('駅');
    created[0].onInterrupt?.([{ interruptId: 'i1', name: 'client:setView', reason: request }]);
    await vi.waitFor(() => expect(executor).toHaveBeenCalled());
    sendMessage.mockClear();

    // The reset discards the conversation; the failure ends its turn, which closes it while the call still runs.
    session.reset();
    created[0].onError?.('failed', new Error('failed'));
    expect(destroy).toHaveBeenCalled();
    finishCall(result);
    await new Promise((settle) => setTimeout(settle, 20));

    expect(sendMessage).not.toHaveBeenCalled();
    session.dispose();
  });
});
