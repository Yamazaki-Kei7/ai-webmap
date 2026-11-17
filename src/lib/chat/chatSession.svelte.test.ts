import type { AgentStreamChunk, ChatMessage as AgentChatMessage } from '@aws-blocks/bb-agent/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatConfig, resultConfig } from '../../../shared/config';
import { conversationErrors, conversationStatus } from '../../../shared/conversation';
import type { MapContext } from '../../../shared/mapSpec';
import { appendMapState } from '../../../shared/mapState';
import { fitToolResults, type ClientToolRequest, type ClientToolResult, type ToolResultData } from '../../../shared/toolProtocol';
import type { ConversationStore, StoredConversation } from './conversationStore';
import { createChatSession, displayMessages, type ChatSession, type ChatSessionApi, type InterruptAnswer } from './chatSession.svelte';
import type { ToolExecutor } from './toolExecutor';

const mapContext: MapContext = { view: { center: [139.7, 35.7], zoom: 9 }, layers: [] };

const setViewRequest: ClientToolRequest = { tool: 'setView', input: { target: { type: 'center', center: [139.7, 35.7], zoom: 9 } } };
const runQueryRequest: ClientToolRequest = { tool: 'runQuery', input: { sql: 'SELECT 1' } };

const setViewResult: ClientToolResult<ToolResultData> = { ok: true, data: { center: [139.7, 35.7], zoom: 9 } };

type Interrupt = NonNullable<AgentStreamChunk['interrupts']>[number];
const interruptOf = (id: string, request: ClientToolRequest): Interrupt => ({ id, name: `client:${request.tool}`, reason: request });
const interruptChunk = (...interrupts: Interrupt[]): AgentStreamChunk => ({ type: 'interrupt', interrupts });

/** What `ApiError` carries across the wire: a name and a status. */
function apiError(status: number, name: string): Error {
  return Object.assign(new Error(`${name} (${status})`), { name, status });
}
const conflict = (name: string): Error => apiError(conversationStatus.conflict, name);

type Fake = {
  api: ChatSessionApi;
  /** Every `agentStream` call: message, conversation id. */
  streams: { message: string; conversationId: string }[];
  resumes: { conversationId: string; answers: InterruptAnswer[] }[];
  /** Pushes a chunk to the latest subscription of the conversation, as the Realtime channel would. */
  emit: (conversationId: string, chunk: AgentStreamChunk) => void;
  conversationIds: string[];
  createConversationId: ReturnType<typeof vi.fn<ChatSessionApi['createConversationId']>>;
  stream: ReturnType<typeof vi.fn<ChatSessionApi['stream']>>;
  resume: ReturnType<typeof vi.fn<ChatSessionApi['resume']>>;
  getPendingInterrupts: ReturnType<typeof vi.fn<ChatSessionApi['getPendingInterrupts']>>;
};

function fakeApi(): Fake {
  const handlers = new Map<string, (chunk: AgentStreamChunk) => void>();
  const conversationIds: string[] = [];
  const streams: Fake['streams'] = [];
  const resumes: Fake['resumes'] = [];
  const createConversationId = vi.fn<ChatSessionApi['createConversationId']>(async () => {
    const conversationId = `conversation-${conversationIds.length + 1}`;
    conversationIds.push(conversationId);
    return { conversationId };
  });
  const stream = vi.fn<ChatSessionApi['stream']>(async (message, conversationId) => {
    streams.push({ message, conversationId });
    return { channelId: conversationId };
  });
  const resume = vi.fn<ChatSessionApi['resume']>(async (conversationId, answers) => {
    resumes.push({ conversationId, answers });
  });
  const getPendingInterrupts = vi.fn<ChatSessionApi['getPendingInterrupts']>(async () => ({ interrupts: [] }));
  const api: ChatSessionApi = {
    createConversationId,
    subscribe: async (channelId, handlerOrOptions) => {
      handlers.set(channelId, typeof handlerOrOptions === 'function' ? handlerOrOptions : handlerOrOptions.onMessage);
      return { unsubscribe: () => undefined, established: Promise.resolve() };
    },
    stream,
    resume,
    getConversation: async () => ({ messages: [] }),
    getPendingInterrupts
  };
  return {
    api,
    streams,
    resumes,
    conversationIds,
    createConversationId,
    stream,
    resume,
    getPendingInterrupts,
    emit: (conversationId, chunk) => handlers.get(conversationId)?.(chunk)
  };
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const executorReturning = (result: ClientToolResult<ToolResultData> = setViewResult) => vi.fn<ToolExecutor>(async () => result);

const owner = 'user-a';

type MemoryStore = ConversationStore & { entry: StoredConversation | null };

function memoryStore(entry: StoredConversation | null = null): MemoryStore {
  const store: MemoryStore = {
    entry,
    read: () => store.entry,
    write: (next) => {
      store.entry = next;
    },
    clear: () => {
      store.entry = null;
    }
  };
  return store;
}

function makeSession(fake: Fake, executor: ToolExecutor = executorReturning(), wait?: (ms: number) => Promise<void>, store: ConversationStore = memoryStore()): ChatSession {
  return createChatSession({ api: fake.api, owner, store, executor, mapContext: () => mapContext, wait });
}

const noWait = async (): Promise<void> => undefined;
const networkFailure = (): Error => Object.assign(new Error('Failed to fetch'), { name: 'TypeError' });
const resetAnswer = { ok: false, error: expect.objectContaining({ code: 'SESSION_RESET' }) };

/** Sends a message and waits until the first conversation is subscribed and the turn is on the server. */
async function sendAndStart(session: ChatSession, fake: Fake, text = '駅を表示して'): Promise<void> {
  await session.send(text);
  await vi.waitFor(() => expect(fake.stream).toHaveBeenCalled());
}

const answersOf = (fake: Fake, index: number): { interruptId: string; result: ClientToolResult<ToolResultData> }[] =>
  fake.resumes[index].answers.map(({ interruptId, response }) => ({ interruptId, result: JSON.parse(response) }));

describe('createChatSession', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs a turn with one interrupt: the map is sent, the call is executed and answered once, then the text shows', async () => {
    const fake = fakeApi();
    const executor = executorReturning();
    const session = makeSession(fake, executor);

    await sendAndStart(session, fake, '  駅を表示して  ');
    expect(fake.streams).toEqual([{ message: '駅を表示して', conversationId: 'conversation-1' }]);
    expect(fake.stream).toHaveBeenCalledWith('駅を表示して', 'conversation-1', mapContext);
    expect(session.isLoading).toBe(true);

    fake.emit('conversation-1', interruptChunk(interruptOf('i1', setViewRequest)));
    await vi.waitFor(() => expect(fake.resumes).toHaveLength(1));
    expect(executor).toHaveBeenCalledExactlyOnceWith(setViewRequest);
    expect(answersOf(fake, 0)).toEqual([{ interruptId: 'i1', result: setViewResult }]);
    expect(session.isLoading, 'the turn goes on after the interrupt').toBe(true);

    fake.emit('conversation-1', { type: 'text-delta', text: '表示しました' });
    fake.emit('conversation-1', { type: 'done', text: '表示しました' });
    await vi.waitFor(() => expect(session.isLoading).toBe(false));
    expect(session.messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: 'user', content: '駅を表示して' },
      { role: 'assistant', content: '表示しました' }
    ]);
    expect(session.error).toBeNull();
    session.dispose();
  });

  it('answers interrupts that come together in one resume, in the order received, with the results fitted', async () => {
    const fake = fakeApi();
    const rows = Array.from({ length: 50 }, (_, index) => ({ name: `駅${index}`.repeat(40), note: 'x'.repeat(200) }));
    const big: ClientToolResult<ToolResultData> = {
      ok: true,
      data: { columns: [{ name: 'name', type: 'string' }, { name: 'note', type: 'string' }], rows, rowCount: rows.length, truncated: false }
    };
    const order: string[] = [];
    const executor = vi.fn<ToolExecutor>(async (request) => {
      order.push(request.tool);
      return request.tool === 'runQuery' ? big : setViewResult;
    });
    const session = makeSession(fake, executor);

    await sendAndStart(session, fake);
    fake.emit('conversation-1', interruptChunk(interruptOf('a', runQueryRequest), interruptOf('b', runQueryRequest), interruptOf('c', setViewRequest)));
    await vi.waitFor(() => expect(fake.resumes).toHaveLength(1));

    expect(order).toEqual(['runQuery', 'runQuery', 'setView']);
    expect(fake.resumes[0].answers.map(({ interruptId }) => interruptId)).toEqual(['a', 'b', 'c']);
    const fitted = fitToolResults([big, big, setViewResult]);
    expect(answersOf(fake, 0).map(({ result }) => result)).toEqual(fitted);
    const sizes = fake.resumes[0].answers.map(({ response }) => new TextEncoder().encode(response).length);
    for (const size of sizes) expect(size).toBeLessThanOrEqual(resultConfig.maxToolResultBytes);
    expect(new TextEncoder().encode(JSON.stringify(big)).length, 'the raw result was over the limit of one result').toBeGreaterThan(resultConfig.maxToolResultBytes);
    session.dispose();
  });

  it('does not run or answer an interrupt it has already answered, nor one still being run', async () => {
    const fake = fakeApi();
    const running = deferred<ClientToolResult<ToolResultData>>();
    const executor = vi.fn<ToolExecutor>(() => running.promise);
    const session = makeSession(fake, executor);

    await sendAndStart(session, fake);
    fake.emit('conversation-1', interruptChunk(interruptOf('i1', setViewRequest)));
    await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(1));
    // The same notification again while the call runs.
    fake.emit('conversation-1', interruptChunk(interruptOf('i1', setViewRequest)));
    running.resolve(setViewResult);
    await vi.waitFor(() => expect(fake.resumes).toHaveLength(1));

    // And again after it was answered (a reconnect re-reads the pending interrupts).
    fake.emit('conversation-1', interruptChunk(interruptOf('i1', setViewRequest)));
    await vi.waitFor(() => expect(session.isLoading).toBe(true));
    await new Promise((done) => setTimeout(done, 20));
    expect(executor).toHaveBeenCalledTimes(1);
    expect(fake.resumes).toHaveLength(1);
    session.dispose();
  });

  it('counts a tool call once in the activity, however often its interrupt arrives, and follows its state', async () => {
    const fake = fakeApi();
    const running = deferred<ClientToolResult<ToolResultData>>();
    const session = makeSession(fake, vi.fn<ToolExecutor>(() => running.promise));

    await sendAndStart(session, fake);
    fake.emit('conversation-1', interruptChunk(interruptOf('i1', setViewRequest)));
    await vi.waitFor(() => expect(session.activity).toEqual([{ id: 'i1', tool: 'setView', state: 'running' }]));
    fake.emit('conversation-1', interruptChunk(interruptOf('i1', setViewRequest)));
    running.resolve(setViewResult);
    await vi.waitFor(() => expect(session.activity).toEqual([{ id: 'i1', tool: 'setView', state: 'done' }]));

    // A second round of the same turn adds its own call.
    fake.emit('conversation-1', interruptChunk(interruptOf('i1', setViewRequest), interruptOf('i2', runQueryRequest)));
    await vi.waitFor(() => expect(session.activity.map(({ id }) => id)).toEqual(['i1', 'i2']));
    session.dispose();
  });

  it('marks a call whose result is an error as failed', async () => {
    const fake = fakeApi();
    const session = makeSession(fake, executorReturning({ ok: false, error: { code: 'SQL_ERROR', message: 'no' } }));
    await sendAndStart(session, fake);
    fake.emit('conversation-1', interruptChunk(interruptOf('i1', runQueryRequest)));
    await vi.waitFor(() => expect(session.activity).toEqual([{ id: 'i1', tool: 'runQuery', state: 'failed' }]));
    session.dispose();
  });

  it('answers ENGINE_UNAVAILABLE when the executor itself fails, and INVALID_INPUT for a request that does not parse', async () => {
    const fake = fakeApi();
    const executor = vi.fn<ToolExecutor>(async () => {
      throw new Error('boom');
    });
    const session = makeSession(fake, executor);
    await sendAndStart(session, fake);
    fake.emit('conversation-1', interruptChunk(interruptOf('bad', runQueryRequest), { id: 'junk', name: 'client:setView', reason: { tool: 'nope' } }));
    await vi.waitFor(() => expect(fake.resumes).toHaveLength(1));
    const [first, second] = answersOf(fake, 0);
    expect(first.result).toMatchObject({ ok: false, error: { code: 'ENGINE_UNAVAILABLE' } });
    expect(second.result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(executor).toHaveBeenCalledTimes(1);
    session.dispose();
  });

  it('refuses to send while a turn is open: running, paused at an interrupt, or executing it', async () => {
    const fake = fakeApi();
    const running = deferred<ClientToolResult<ToolResultData>>();
    const session = makeSession(fake, vi.fn<ToolExecutor>(() => running.promise));

    await sendAndStart(session, fake);
    await session.send('もう一つ');
    expect(fake.stream).toHaveBeenCalledTimes(1);

    fake.emit('conversation-1', interruptChunk(interruptOf('i1', setViewRequest)));
    await vi.waitFor(() => expect(session.activity).toHaveLength(1));
    // createChat's own loading is false here (the turn is paused at the interrupt); the session's is not.
    expect(session.isLoading).toBe(true);
    await session.send('実行中に送る');
    expect(fake.stream).toHaveBeenCalledTimes(1);

    running.resolve(setViewResult);
    await vi.waitFor(() => expect(fake.resumes).toHaveLength(1));
    expect(session.isLoading).toBe(true);
    await session.send('答えの後にも');
    expect(fake.stream).toHaveBeenCalledTimes(1);

    fake.emit('conversation-1', { type: 'done', text: 'ok' });
    await vi.waitFor(() => expect(session.isLoading).toBe(false));
    await session.send('次の発話');
    expect(fake.stream).toHaveBeenCalledTimes(2);
    expect(fake.createConversationId, 'the conversation goes on').toHaveBeenCalledTimes(1);
    session.dispose();
  });

  it('ignores an empty message', async () => {
    const fake = fakeApi();
    const session = makeSession(fake);
    await session.send('  \n ');
    expect(fake.createConversationId).not.toHaveBeenCalled();
    expect(session.isLoading).toBe(false);
  });

  it('ends the loading state with an error when only onError reports a failure (a rejected resume, no error chunk)', async () => {
    const fake = fakeApi();
    fake.resume.mockRejectedValueOnce(new Error('resume refused'));
    const session = makeSession(fake);
    await sendAndStart(session, fake);
    fake.emit('conversation-1', interruptChunk(interruptOf('i1', setViewRequest)));
    await vi.waitFor(() => expect(session.isLoading).toBe(false));
    expect(session.error).toBe(chatConfig.text.errorGeneric);
    session.dispose();
  });

  it('ends the loading state when the message cannot be sent', async () => {
    const fake = fakeApi();
    fake.stream.mockRejectedValueOnce(new Error('offline'));
    const session = makeSession(fake);
    await session.send('駅');
    await vi.waitFor(() => expect(session.isLoading).toBe(false));
    expect(session.error).toBe(chatConfig.text.errorGeneric);
    // The next message is accepted (and clears the error).
    await session.send('もう一度');
    expect(session.error).toBeNull();
    expect(fake.stream).toHaveBeenCalledTimes(2);
    session.dispose();
  });

  it('shows an error chunk once and ends the turn', async () => {
    const fake = fakeApi();
    const session = makeSession(fake);
    await sendAndStart(session, fake);
    fake.emit('conversation-1', { type: 'error', error: 'model failed' });
    await vi.waitFor(() => expect(session.isLoading).toBe(false));
    expect(session.error).toBe(chatConfig.text.errorGeneric);
    session.dispose();
  });

  describe('a store that is not consistent yet', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('retries a resume refused with 409 after the configured waits, then goes on', async () => {
      const fake = fakeApi();
      fake.resume.mockRejectedValueOnce(conflict(conversationErrors.InterruptNotPending)).mockRejectedValueOnce(conflict(conversationErrors.InterruptNotPending));
      const waits: number[] = [];
      const session = makeSession(fake, executorReturning(), async (ms) => void waits.push(ms));
      // The real timers of the default wait are not used here: the waits are recorded and return at once.
      await sendAndStart(session, fake);
      fake.emit('conversation-1', interruptChunk(interruptOf('i1', setViewRequest)));
      await vi.waitFor(() => expect(fake.resume).toHaveBeenCalledTimes(3));
      expect(waits).toEqual([chatConfig.retryDelaysMs[0], chatConfig.retryDelaysMs[1]]);
      expect(session.error).toBeNull();
      expect(session.isLoading).toBe(true);
      session.dispose();
    });

    it('waits the real delays between the retries', async () => {
      const fake = fakeApi();
      fake.stream.mockRejectedValueOnce(conflict(conversationErrors.InterruptsPending));
      const session = makeSession(fake);
      const sending = session.send('駅');
      await vi.advanceTimersByTimeAsync(0);
      expect(fake.stream).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(chatConfig.retryDelaysMs[0] - 1);
      expect(fake.stream).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fake.stream).toHaveBeenCalledTimes(2);
      await sending;
      expect(session.error).toBeNull();
      session.dispose();
    });

    it('ends the turn with an error when the resume stays refused and the answered interrupts are no longer pending', async () => {
      const fake = fakeApi();
      fake.resume.mockRejectedValue(conflict(conversationErrors.InterruptNotPending));
      fake.getPendingInterrupts.mockResolvedValue({ interrupts: [] });
      const session = makeSession(fake);
      await session.send('駅');
      await vi.advanceTimersByTimeAsync(0);
      fake.emit('conversation-1', interruptChunk(interruptOf('i1', setViewRequest)));
      await vi.advanceTimersByTimeAsync(chatConfig.retryDelaysMs.reduce((sum, delay) => sum + delay, 0) + 10);
      expect(fake.resume).toHaveBeenCalledTimes(chatConfig.retryDelaysMs.length + 1);
      expect(fake.getPendingInterrupts).toHaveBeenCalledWith('conversation-1');
      expect(session.isLoading).toBe(false);
      expect(session.error).toBe(chatConfig.text.errors[chatConfig.errorNames.answerRefused]);
      session.dispose();
    });

    it('reports the refusal itself when the answered interrupts are still pending after the retries', async () => {
      const fake = fakeApi();
      fake.resume.mockRejectedValue(conflict(conversationErrors.InterruptNotPending));
      fake.getPendingInterrupts.mockResolvedValue({ interrupts: [{ id: 'i1', name: 'client:setView' }] });
      const session = makeSession(fake);
      await session.send('駅');
      await vi.advanceTimersByTimeAsync(0);
      fake.emit('conversation-1', interruptChunk(interruptOf('i1', setViewRequest)));
      await vi.advanceTimersByTimeAsync(chatConfig.retryDelaysMs.reduce((sum, delay) => sum + delay, 0) + 10);
      expect(session.isLoading).toBe(false);
      expect(session.error).toBe(chatConfig.text.errors[conversationErrors.InterruptNotPending]);
      session.dispose();
    });

    it('retries the first message after a 404 right after the conversation was created', async () => {
      const fake = fakeApi();
      fake.stream
        .mockRejectedValueOnce(apiError(conversationStatus.notFound, conversationErrors.NotFound))
        .mockRejectedValueOnce(apiError(conversationStatus.notFound, conversationErrors.NotFound));
      const session = makeSession(fake);
      const sending = session.send('駅');
      await vi.advanceTimersByTimeAsync(chatConfig.retryDelaysMs[0] + chatConfig.retryDelaysMs[1] + 10);
      expect(fake.stream).toHaveBeenCalledTimes(3);
      await sending;
      expect(session.error).toBeNull();
      expect(session.isLoading).toBe(true);
      session.dispose();
    });

    it('does not retry an error that is not a refusal of the store', async () => {
      const fake = fakeApi();
      fake.stream.mockRejectedValue(apiError(conversationStatus.badRequest, conversationErrors.InvalidRequest));
      const session = makeSession(fake);
      await session.send('駅');
      await vi.advanceTimersByTimeAsync(chatConfig.retryDelaysMs.reduce((sum, delay) => sum + delay, 0) + 10);
      expect(fake.stream).toHaveBeenCalledTimes(1);
      expect(session.error).toBe(chatConfig.text.errors[conversationErrors.InvalidRequest]);
      session.dispose();
    });
  });

  describe('reset', () => {
    it('answers the pending tool calls SESSION_RESET, then starts a new conversation', async () => {
      const fake = fakeApi();
      const running = deferred<ClientToolResult<ToolResultData>>();
      const executor = vi.fn<ToolExecutor>(() => running.promise);
      const session = makeSession(fake, executor);

      await sendAndStart(session, fake);
      fake.emit('conversation-1', interruptChunk(interruptOf('i1', runQueryRequest), interruptOf('i2', setViewRequest)));
      await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(1));

      session.reset();
      expect(session.isLoading).toBe(false);
      expect(session.messages).toEqual([]);
      expect(session.activity).toEqual([]);
      running.resolve(setViewResult);
      await vi.waitFor(() => expect(fake.resumes).toHaveLength(1));
      expect(executor, 'the second call of the batch is not run any more').toHaveBeenCalledTimes(1);
      expect(fake.resumes[0].conversationId).toBe('conversation-1');
      expect(answersOf(fake, 0)).toEqual([
        { interruptId: 'i1', result: expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'SESSION_RESET' }) }) },
        { interruptId: 'i2', result: expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'SESSION_RESET' }) }) }
      ]);

      await session.send('新しい話');
      expect(fake.conversationIds).toEqual(['conversation-1', 'conversation-2']);
      expect(fake.streams.at(-1)).toEqual({ message: '新しい話', conversationId: 'conversation-2' });
      session.dispose();
    });

    it('answers the tool calls that the abandoned turn still makes SESSION_RESET, without running them, and shows nothing of it', async () => {
      const fake = fakeApi();
      const executor = executorReturning();
      const session = makeSession(fake, executor);
      await sendAndStart(session, fake);

      session.reset();
      fake.emit('conversation-1', { type: 'text-delta', text: '古い会話の文' });
      fake.emit('conversation-1', interruptChunk(interruptOf('late', setViewRequest)));
      await vi.waitFor(() => expect(fake.resumes).toHaveLength(1));
      expect(executor).not.toHaveBeenCalled();
      expect(answersOf(fake, 0)).toEqual([{ interruptId: 'late', result: expect.objectContaining({ error: expect.objectContaining({ code: 'SESSION_RESET' }) }) }]);
      expect(session.messages).toEqual([]);
      expect(session.activity).toEqual([]);
      session.dispose();
    });

    it('resets while nothing runs: the next message opens a new conversation', async () => {
      const fake = fakeApi();
      const session = makeSession(fake);
      await sendAndStart(session, fake);
      fake.emit('conversation-1', { type: 'done', text: 'ok' });
      await vi.waitFor(() => expect(session.isLoading).toBe(false));

      session.reset();
      expect(session.messages).toEqual([]);
      expect(fake.resumes).toEqual([]);
      await session.send('次');
      expect(fake.conversationIds).toHaveLength(2);
      session.dispose();
    });
  });

  it('does not show the approvals that `createChat` records for the answers', async () => {
    const fake = fakeApi();
    const session = makeSession(fake);
    await sendAndStart(session, fake);
    fake.emit('conversation-1', interruptChunk(interruptOf('i1', setViewRequest)));
    await vi.waitFor(() => expect(fake.resumes).toHaveLength(1));
    fake.emit('conversation-1', { type: 'done', text: '済み' });
    await vi.waitFor(() => expect(session.isLoading).toBe(false));
    expect(session.messages.map(({ role }) => role)).toEqual(['user', 'assistant']);
    session.dispose();
  });
});

describe('a conversation left with interrupts the server still holds', () => {
  const pending = { interrupts: [{ id: 'i1', name: 'client:setView' }, { id: 'i2', name: 'client:runQuery' }] };

  it('recovers at the next send after a resume that failed on the network: the pending are answered SESSION_RESET, and the message goes to a new conversation', async () => {
    const fake = fakeApi();
    fake.resume.mockRejectedValueOnce(networkFailure());
    fake.getPendingInterrupts.mockResolvedValue(pending);
    const session = makeSession(fake);
    await sendAndStart(session, fake);
    fake.emit('conversation-1', interruptChunk(interruptOf('i1', setViewRequest)));
    await vi.waitFor(() => expect(session.isLoading).toBe(false));
    expect(session.error).toBe(chatConfig.text.errors.TypeError);

    await session.send('次の発話');
    expect(fake.resumes).toHaveLength(1);
    expect(fake.resumes[0].conversationId).toBe('conversation-1');
    expect(answersOf(fake, 0).map(({ interruptId, result }) => ({ interruptId, result }))).toEqual([
      { interruptId: 'i1', result: expect.objectContaining(resetAnswer) },
      { interruptId: 'i2', result: expect.objectContaining(resetAnswer) }
    ]);
    expect(fake.streams.at(-1)).toEqual({ message: '次の発話', conversationId: 'conversation-2' });
    expect(session.messages.map(({ content }) => content)).toEqual(['次の発話']);
    expect(session.error).toBeNull();
    session.dispose();
  });

  it('clears them at reset when the resume stayed refused with the interrupts still pending', async () => {
    const fake = fakeApi();
    fake.resume.mockRejectedValueOnce(conflict(conversationErrors.InterruptNotPending)).mockRejectedValueOnce(conflict(conversationErrors.InterruptNotPending)).mockRejectedValueOnce(conflict(conversationErrors.InterruptNotPending)).mockRejectedValueOnce(conflict(conversationErrors.InterruptNotPending));
    fake.getPendingInterrupts.mockResolvedValue(pending);
    const session = makeSession(fake, executorReturning(), noWait);
    await sendAndStart(session, fake);
    fake.emit('conversation-1', interruptChunk(interruptOf('i1', setViewRequest)));
    await vi.waitFor(() => expect(session.isLoading).toBe(false));
    expect(fake.resume).toHaveBeenCalledTimes(chatConfig.retryDelaysMs.length + 1);

    session.reset();
    await vi.waitFor(() => expect(fake.resumes).toHaveLength(1));
    expect(fake.resumes[0].conversationId).toBe('conversation-1');
    expect(fake.resumes[0].answers.map(({ interruptId }) => interruptId)).toEqual(['i1', 'i2']);
    await session.send('新しい話');
    expect(fake.streams.at(-1)?.conversationId).toBe('conversation-2');
    session.dispose();
  });

  it('does not let a failing recovery block the next message', async () => {
    const fake = fakeApi();
    fake.resume.mockRejectedValueOnce(networkFailure());
    fake.getPendingInterrupts.mockRejectedValue(networkFailure());
    const session = makeSession(fake);
    await sendAndStart(session, fake);
    fake.emit('conversation-1', interruptChunk(interruptOf('i1', setViewRequest)));
    await vi.waitFor(() => expect(session.isLoading).toBe(false));

    await session.send('次');
    expect(fake.streams.at(-1)).toEqual({ message: '次', conversationId: 'conversation-2' });
    expect(session.error).toBeNull();
    session.dispose();
  });

  it('does not settle a conversation whose turn ended in a failure before any interrupt', async () => {
    const fake = fakeApi();
    const session = makeSession(fake);
    await sendAndStart(session, fake);
    fake.emit('conversation-1', { type: 'error', error: 'model failed' });
    await vi.waitFor(() => expect(session.isLoading).toBe(false));
    await session.send('もう一度');
    expect(fake.getPendingInterrupts).not.toHaveBeenCalled();
    expect(fake.streams.at(-1)?.conversationId, 'the same conversation goes on').toBe('conversation-1');
    session.dispose();
  });
});

describe('a message the server refuses for interrupts the browser never saw (the stream response was lost)', () => {
  const pending = { interrupts: [{ id: 'hidden', name: 'client:runQuery' }] };
  const refused = (): Error => conflict(conversationErrors.InterruptsPending);

  it('recovers within one send: the pending are answered SESSION_RESET and the same text goes to a new conversation', async () => {
    const fake = fakeApi();
    fake.getPendingInterrupts.mockResolvedValue(pending);
    fake.stream.mockImplementation(async (message, conversationId) => {
      if (conversationId === 'conversation-1') throw refused();
      fake.streams.push({ message, conversationId });
      return { channelId: conversationId };
    });
    const session = makeSession(fake, executorReturning(), noWait);
    await session.send('駅を表示して');
    expect(fake.resumes).toHaveLength(1);
    expect(fake.resumes[0]).toMatchObject({ conversationId: 'conversation-1', answers: [{ interruptId: 'hidden' }] });
    expect(answersOf(fake, 0)[0].result).toEqual(expect.objectContaining(resetAnswer));
    expect(fake.streams).toEqual([{ message: '駅を表示して', conversationId: 'conversation-2' }]);
    expect(session.error).toBeNull();
    expect(session.isLoading).toBe(true);
    expect(session.messages.map(({ content }) => content)).toEqual(['駅を表示して']);
    session.dispose();
  });

  it('recovers once per send, however the new conversation answers, and reset() then answers what that one holds', async () => {
    const fake = fakeApi();
    fake.getPendingInterrupts.mockResolvedValue(pending);
    fake.stream.mockRejectedValue(refused());
    const session = makeSession(fake, executorReturning(), noWait);
    await session.send('駅');
    expect(fake.createConversationId).toHaveBeenCalledTimes(2);
    expect(fake.stream).toHaveBeenCalledTimes(2 * (chatConfig.retryDelaysMs.length + 1));
    expect(fake.resumes).toHaveLength(1);
    expect(session.isLoading).toBe(false);
    expect(session.error).toBe(chatConfig.text.errors[conversationErrors.InterruptsPending]);

    session.reset();
    await vi.waitFor(() => expect(fake.resumes).toHaveLength(2));
    expect(fake.resumes[1].conversationId).toBe('conversation-2');
    session.dispose();
  });
});

describe('the conversation kept across a reload', () => {
  const pending = { interrupts: [{ id: 'old', name: 'client:setView' }] };

  it('answers what the stored conversation of the same user left pending, and forgets it', async () => {
    const fake = fakeApi();
    fake.getPendingInterrupts.mockResolvedValue(pending);
    const store = memoryStore({ owner, conversationId: 'previous' });
    const session = makeSession(fake, executorReturning(), undefined, store);
    await vi.waitFor(() => expect(fake.resumes).toHaveLength(1));
    expect(fake.getPendingInterrupts).toHaveBeenCalledWith('previous');
    expect(fake.resumes[0]).toMatchObject({ conversationId: 'previous', answers: [{ interruptId: 'old' }] });
    expect(answersOf(fake, 0)[0].result).toEqual(expect.objectContaining(resetAnswer));
    expect(store.entry).toBeNull();
    expect(session.messages).toEqual([]);
    session.dispose();
  });

  it("never touches another user's stored conversation", async () => {
    const fake = fakeApi();
    fake.getPendingInterrupts.mockResolvedValue(pending);
    const other: StoredConversation = { owner: 'user-b', conversationId: 'theirs' };
    const store = memoryStore(other);
    const session = makeSession(fake, executorReturning(), undefined, store);
    await new Promise((done) => setTimeout(done, 20));
    expect(fake.getPendingInterrupts).not.toHaveBeenCalled();
    expect(fake.resume).not.toHaveBeenCalled();
    expect(store.entry).toEqual(other);
    session.dispose();
  });

  it('remembers the conversation it creates, with its owner', async () => {
    const fake = fakeApi();
    const store = memoryStore();
    const session = makeSession(fake, executorReturning(), undefined, store);
    await sendAndStart(session, fake);
    expect(store.entry).toEqual({ owner, conversationId: 'conversation-1' });
    session.dispose();
  });

  it('works when the storage fails on every call, and when the recovery fails', async () => {
    const fake = fakeApi();
    fake.getPendingInterrupts.mockRejectedValue(networkFailure());
    const store = memoryStore({ owner, conversationId: 'previous' });
    const session = makeSession(fake, executorReturning(), undefined, store);
    await new Promise((done) => setTimeout(done, 20));
    await session.send('駅');
    expect(fake.streams).toHaveLength(1);
    session.dispose();
  });
});

describe('dispose', () => {
  it('sends and subscribes nothing from a batch that was still running, and refuses later sends and resets', async () => {
    const fake = fakeApi();
    const running = deferred<ClientToolResult<ToolResultData>>();
    const session = makeSession(fake, vi.fn<ToolExecutor>(() => running.promise));
    await sendAndStart(session, fake);
    fake.emit('conversation-1', interruptChunk(interruptOf('i1', setViewRequest)));
    await vi.waitFor(() => expect(session.activity).toHaveLength(1));

    session.dispose();
    running.resolve(setViewResult);
    await new Promise((done) => setTimeout(done, 30));
    expect(fake.resume).not.toHaveBeenCalled();
    await session.send('もう一度');
    session.reset();
    expect(fake.stream).toHaveBeenCalledTimes(1);
    expect(fake.createConversationId).toHaveBeenCalledTimes(1);
  });
});

describe('displayMessages', () => {
  const messages: AgentChatMessage[] = [
    { id: '1', role: 'user', content: appendMapState('学校を色分けして', mapContext) },
    { id: '2', role: 'assistant', content: '' },
    { id: '3', role: 'approval', content: '{"ok":true,"data":{"rows":[{"secret":1}]}}', metadata: {} },
    { id: '4', role: 'assistant', content: '色分けしました' }
  ];

  it('strips the map state from the user text, keeps the assistant text, and hides empty and approval messages', () => {
    expect(displayMessages(messages)).toEqual([
      { id: '1', role: 'user', content: '学校を色分けして' },
      { id: '4', role: 'assistant', content: '色分けしました' }
    ]);
  });
});
