import { describe, expect, it, vi } from 'vitest';
import { conversationErrors, conversationStatus } from '../../../shared/conversation';
import { chatConfig } from '../../../shared/config';
import type { MapContext } from '../../../shared/mapSpec';
import { appendMapState } from '../../../shared/mapState';
import type { ClientToolRequest } from '../../../shared/toolProtocol';
import type { ConversationStore, StoredConversation } from './conversationStore';
import { createChatSession, type ChatSession, type ChatSessionApi, type InterruptAnswer } from './chatSession.svelte';
import type { ToolExecutor } from './toolExecutor';

// Opening a saved conversation: the history it shows, the pending calls it answers, the conversation it continues.

const mapContext: MapContext = { view: { center: [139.7, 35.7], zoom: 9 }, layers: [] };
const setViewRequest: ClientToolRequest = { tool: 'setView', input: { target: { type: 'center', center: [139.7, 35.7], zoom: 9 } } };
const owner = 'user-a';
const savedId = 'saved-conversation';

type History = { role: string; content: string; metadata?: object }[];
type Pending = { id: string; name: string; reason?: object }[];

const history: History = [
  { role: 'user', content: appendMapState('学校を表示して', mapContext) },
  { role: 'interrupt', content: '', metadata: { toolName: 'client:addLayer' } },
  { role: 'tool-call', content: 'addLayer' },
  { role: 'approval', content: 'ok', metadata: { approved: true } },
  { role: 'assistant', content: '' },
  { role: 'assistant', content: '表示しました' },
  { role: 'user', content: appendMapState('色分けして', mapContext) },
  { role: 'assistant', content: '' }
];

type Setup = {
  session: ChatSession;
  api: ChatSessionApi;
  executor: ReturnType<typeof vi.fn<ToolExecutor>>;
  store: ConversationStore & { entry: StoredConversation | null };
  resumes: { conversationId: string; answers: InterruptAnswer[] }[];
  streams: { message: string; conversationId: string }[];
  created: string[];
};

function setup(options: { getConversation?: ChatSessionApi['getConversation']; pending?: Pending; resume?: ChatSessionApi['resume'] } = {}): Setup {
  const resumes: Setup['resumes'] = [];
  const streams: Setup['streams'] = [];
  const created: string[] = [];
  const store: Setup['store'] = {
    entry: { owner, conversationId: 'previous-conversation' },
    read: () => store.entry,
    write: (next) => {
      store.entry = next;
    },
    clear: () => {
      store.entry = null;
    }
  };
  const executor = vi.fn<ToolExecutor>(async () => ({ ok: true, data: { center: [139.7, 35.7], zoom: 9 } }));
  const api: ChatSessionApi = {
    createConversationId: async () => {
      const conversationId = `new-${created.length + 1}`;
      created.push(conversationId);
      return { conversationId };
    },
    subscribe: async () => ({ unsubscribe: () => undefined, established: Promise.resolve() }),
    stream: async (message, conversationId) => {
      streams.push({ message, conversationId });
      return { channelId: conversationId };
    },
    resume:
      options.resume ??
      (async (conversationId, answers) => {
        resumes.push({ conversationId, answers });
      }),
    getConversation: options.getConversation ?? (async () => ({ messages: history })),
    getPendingInterrupts: async (conversationId) => ({ interrupts: conversationId === savedId ? (options.pending ?? []) : [] })
  };
  const session = createChatSession({ api, owner, store, executor, mapContext: () => mapContext, wait: async () => undefined });
  return { session, api, executor, store, resumes, streams, created };
}

const apiError = (status: number, name: string): Error => Object.assign(new Error(`${name} (${status})`), { name, status });

describe('openConversation', () => {
  it('shows the history as the messages of the chat: no map state, no tool, interrupt or approval rows, no empty assistant rows', async () => {
    const { session } = setup();
    await session.openConversation(savedId);
    expect(session.messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: 'user', content: '学校を表示して' },
      { role: 'assistant', content: '表示しました' },
      { role: 'user', content: '色分けして' }
    ]);
    expect(session.error).toBeNull();
    expect(session.isLoading).toBe(false);
    session.dispose();
  });

  it('replaces what the chat showed, and makes the conversation the stored one', async () => {
    const { session, store } = setup();
    await session.openConversation(savedId);
    expect(store.entry).toEqual({ owner, conversationId: savedId });
    await session.openConversation(savedId);
    expect(session.messages).toHaveLength(3);
    session.dispose();
  });

  it('answers what it left pending SESSION_RESET, without running the calls', async () => {
    const { session, executor, resumes } = setup({
      pending: [
        { id: 'p1', name: 'client:setView', reason: setViewRequest },
        { id: 'p2', name: 'client:setView', reason: setViewRequest }
      ]
    });
    await session.openConversation(savedId);
    expect(executor).not.toHaveBeenCalled();
    expect(resumes).toHaveLength(1);
    expect(resumes[0].conversationId).toBe(savedId);
    expect(resumes[0].answers.map(({ interruptId, response }) => ({ interruptId, code: JSON.parse(response).error.code }))).toEqual([
      { interruptId: 'p1', code: 'SESSION_RESET' },
      { interruptId: 'p2', code: 'SESSION_RESET' }
    ]);
    session.dispose();
  });

  it('answers nothing for a conversation with nothing pending', async () => {
    const { session, resumes } = setup();
    await session.openConversation(savedId);
    expect(resumes).toEqual([]);
    session.dispose();
  });

  it('then accepts new messages into that conversation', async () => {
    const { session, streams, created } = setup();
    await session.openConversation(savedId);
    await session.send('もう一度');
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    expect(streams[0]).toEqual({ message: 'もう一度', conversationId: savedId });
    expect(created).toEqual([]);
    session.dispose();
  });

  it('is busy while it loads: a message sent meanwhile is refused', async () => {
    let finish: (value: { messages: History }) => void = () => undefined;
    const { session, streams } = setup({ getConversation: () => new Promise((resolve) => (finish = resolve)) });
    const opening = session.openConversation(savedId);
    await vi.waitFor(() => expect(session.isLoading).toBe(true));
    await session.send('待たずに送る');
    expect(streams).toEqual([]);
    finish({ messages: history });
    await opening;
    expect(session.isLoading).toBe(false);
    expect(session.messages).toHaveLength(3);
    session.dispose();
  });

  describe('a conversation that is not found', () => {
    const notFound = () => Promise.reject(apiError(conversationStatus.notFound, conversationErrors.NotFound));

    it('says so in Japanese and stays on an empty, new conversation', async () => {
      const { session, store, streams, created } = setup({ getConversation: notFound });
      await session.openConversation(savedId);
      expect(session.error).toBe(chatConfig.text.restoreNotFound);
      expect(session.messages).toEqual([]);
      expect(session.isLoading).toBe(false);
      expect(store.entry?.conversationId, 'the stored conversation is not the one that failed').not.toBe(savedId);
      await session.send('はじめから');
      await vi.waitFor(() => expect(streams).toHaveLength(1));
      expect(created).toEqual(['new-1']);
      expect(streams[0].conversationId).toBe('new-1');
      session.dispose();
    });

    it('does the same for the other failures, with the message of the error name', async () => {
      const { session } = setup({ getConversation: () => Promise.reject(Object.assign(new Error('Failed to fetch'), { name: 'TypeError' })) });
      await session.openConversation(savedId);
      expect(session.error).toBe(chatConfig.text.errors.TypeError);
      expect(session.messages).toEqual([]);
      session.dispose();
    });
  });

  it('lets a later opening win over one still loading', async () => {
    const releases: ((value: { messages: History }) => void)[] = [];
    const { session, store } = setup({ getConversation: () => new Promise((resolve) => releases.push(resolve)) });
    const first = session.openConversation('first');
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const second = session.openConversation(savedId);
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]({ messages: [{ role: 'user', content: 'second' }] });
    releases[0]({ messages: [{ role: 'user', content: 'first' }] });
    await Promise.all([first, second]);
    expect(session.messages.map(({ content }) => content)).toEqual(['second']);
    expect(store.entry?.conversationId).toBe(savedId);
    session.dispose();
  });

  it('tries once more to settle at the next send, and goes on in the same conversation when that works', async () => {
    let attempts = 0;
    const answered: InterruptAnswer[][] = [];
    const { session, streams, created } = setup({
      pending: [{ id: 'p1', name: 'client:setView', reason: setViewRequest }],
      resume: async (_conversationId, answers) => {
        attempts += 1;
        if (attempts === 1) throw new Error('down');
        answered.push(answers);
      }
    });
    await session.openConversation(savedId);
    expect(session.messages).toHaveLength(3);
    await session.send('続き');
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    expect(streams[0].conversationId).toBe(savedId);
    expect(created).toEqual([]);
    expect(answered).toHaveLength(1);
    expect(session.error).toBeNull();
    expect(session.messages.length).toBeGreaterThanOrEqual(3);
    session.dispose();
  });

  it('moves to a new conversation, and says so, when the retry fails too', async () => {
    const { session, streams, created } = setup({
      pending: [{ id: 'p1', name: 'client:setView', reason: setViewRequest }],
      resume: () => Promise.reject(new Error('down'))
    });
    await session.openConversation(savedId);
    expect(session.error).toBeNull();
    await session.send('続き');
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    expect(created).toEqual(['new-1']);
    expect(streams[0].conversationId).toBe('new-1');
    expect(session.error).toBe(chatConfig.text.restoreNotContinued);
    expect(session.messages.map(({ content }) => content)).not.toContain('表示しました');
    session.dispose();
  });

  it('does not store the opened conversation when a reset came while it loaded', async () => {
    let finish: (value: { messages: History }) => void = () => undefined;
    const { session, store } = setup({ getConversation: () => new Promise((resolve) => (finish = resolve)) });
    const opening = session.openConversation(savedId);
    await vi.waitFor(() => expect(session.isLoading).toBe(true));
    session.reset();
    finish({ messages: history });
    await opening;
    expect(store.entry?.conversationId).not.toBe(savedId);
    expect(session.messages).toEqual([]);
    expect(session.isLoading).toBe(false);
    session.dispose();
  });
});
