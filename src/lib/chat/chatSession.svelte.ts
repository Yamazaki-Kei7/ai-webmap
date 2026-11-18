import { createChat, realtimeTransport, type ChatController, type ChatMessage as AgentChatMessage } from '@aws-blocks/bb-agent/client';
import { chatConfig } from '../../../shared/config';
import { conversationErrors, conversationStatus } from '../../../shared/conversation';
import type { MapContext } from '../../../shared/mapSpec';
import { stripMapState } from '../../../shared/mapState';
import {
  clientToolRequestSchema,
  fitToolResults,
  toolError,
  toolNameSchema,
  type ClientToolResult,
  type ToolName,
  type ToolResultData
} from '../../../shared/toolProtocol';
import type { ActivityCode } from './chatPanelState';
import type { ConversationStore } from './conversationStore';
import type { ToolExecutor } from './toolExecutor';

/**
 * The browser side of the chat: one `createChat` per conversation, a Realtime transport onto the `agent*` API, and the
 * interrupts (the model's tool calls) answered by the tool executor. `createChat`'s own `loading` goes false the moment a
 * turn pauses at an interrupt, so the session keeps its own state: a turn is open from `send` until `done` or an error,
 * across the interrupts and their answers.
 */

/** A message of the conversation as the panel shows it (no tool, interrupt or approval rows). */
export type ChatMessage = { id: string; role: 'user' | 'assistant'; content: string };

export type OpenConversationResult = 'opened' | 'notFound' | 'failed';

/** `code` is why a failed call failed (the code of the result the model is given). */
export type ToolActivity = { id: string; tool: ToolName; state: 'running' | 'done' | 'failed'; code?: ActivityCode };

export interface ChatSession {
  readonly messages: ChatMessage[];
  /** A turn is open (sent, running, or paused at interrupts being executed or answered): `send` is refused meanwhile. */
  readonly isLoading: boolean;
  /** The tool calls of the current turn, each once (the interrupt id is the tool call's identity). */
  readonly activity: ToolActivity[];
  readonly error: string | null;
  /** The id of the current conversation (it exists once a message was sent, or a saved one was opened), else null: a saved map keeps it. */
  readonly conversationId: string | null;
  send(text: string): Promise<void>;
  /** A new conversation: the open turn is abandoned and its pending tool calls answered `SESSION_RESET`. */
  reset(): void;
  /**
   * Continues a saved conversation: its history is shown, it becomes the current one (and the stored one), and what it left
   * pending is answered `SESSION_RESET` (the map was rebuilt from its SQL, not from those calls). When it cannot be opened
   * (gone, or not the user's) the chat stays on a new conversation and `error` says so. Says how it went: `notFound` is the
   * conversation being gone for good, `failed` any other reason (the connection, a later opening taking over): it may still exist.
   */
  openConversation(conversationId: string): Promise<OpenConversationResult>;
  /** Closes the subscriptions (when the panel goes away). */
  dispose(): void;
}

/** An interrupt as `createChat` notifies it: `interruptId`, the name, and the reason the backend raised. */
type NotifiedInterrupt = Parameters<NonNullable<Parameters<typeof createChat>[0]['onInterrupt']>>[0][number];

type TransportIo = Parameters<typeof realtimeTransport>[0];

export type InterruptAnswer = { interruptId: string; response: string };

/** The conversation API, as the session needs it (`chatApi.ts` maps it onto the typed client). */
export type ChatSessionApi = {
  createConversationId: () => Promise<{ conversationId: string }>;
  subscribe: TransportIo['subscribe'];
  stream: (message: string, conversationId: string, mapContext: MapContext) => Promise<{ channelId: string }>;
  resume: (conversationId: string, answers: InterruptAnswer[]) => Promise<void>;
  getConversation: (conversationId: string) => Promise<{ messages: { role: string; content: string; metadata?: object }[] }>;
  getPendingInterrupts: (conversationId: string) => Promise<{ interrupts: { id: string; name: string; reason?: object | string }[] }>;
};

export type ChatSessionDeps = {
  api: ChatSessionApi;
  /** The signed-in user: the stored conversation is answered after a reload only when it is this user's. */
  owner: string;
  store: ConversationStore;
  executor: ToolExecutor;
  /** The map as the model is told about it, taken at every `send`. */
  mapContext: () => MapContext;
  /** Waits `ms` milliseconds (the retries of the conversation API). */
  wait?: (ms: number) => Promise<void>;
};

type Conversation = {
  chat: ChatController;
  /** Reset away: its later tool calls are answered `SESSION_RESET`, and nothing of it is shown. */
  discarded: boolean;
  /** A turn of this session is open (a reset leaves a conversation without one to go at once). */
  turnOpen: boolean;
  /** The interrupts handed to the executor and not yet answered. */
  handling: Set<string>;
  /** The interrupts answered: a repeated notification (reconnect, reload) is ignored. */
  answered: Set<string>;
  /** The current turn raised interrupts. */
  interrupted: boolean;
  /** The turn ended in a failure after raising interrupts: the server may still hold them pending. */
  unsettled: boolean;
  /**
   * The `tool-result` chunks still to come for the calls this session answered, by tool. A result beyond them is of a call the
   * server answered itself (it never raised an interrupt for it): the browser did not run it, so the user would not see it.
   */
  awaitedResults: Map<ToolName, number>;
  /** Its history is being loaded: the interrupts that notifies are not run (they are answered `SESSION_RESET` once it is loaded). */
  restoring: boolean;
  /** Opened from a saved conversation whose pending calls could not be answered: the next `send` tries once more before it leaves it. */
  reopened: boolean;
};

const sessionReset = toolError('SESSION_RESET', 'The conversation was reset by the user: the map no longer matches this request.', 'Do not call more tools. Stop.');

const nothing = (): void => undefined;

const defaultWait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The conversation API refused for a state the store has not reached yet (or never will: the caller decides after the retries). */
function isTransientRefusal(error: Error): boolean {
  if (!('status' in error)) return false;
  if (error.status === conversationStatus.notFound) return error.name === conversationErrors.NotFound;
  return error.status === conversationStatus.conflict && (error.name === conversationErrors.InterruptNotPending || error.name === conversationErrors.InterruptsPending);
}

/** The message of a failure, in Japanese: by its error name, never its own text (which is English and may carry server details). */
const describeError = (error: Error): string => chatConfig.text.errors[error.name] ?? chatConfig.text.errorGeneric;

/** What the panel shows of `createChat`'s messages: the user's text without the map state, and the assistant's text; the approvals carry raw results. */
export function displayMessages(messages: readonly AgentChatMessage[]): ChatMessage[] {
  return messages.flatMap(({ id, role, content }): ChatMessage[] => {
    if (role === 'user') return [{ id, role, content: stripMapState(content) }];
    // The empty assistant message is the placeholder of the reply that has not started.
    if (role === 'assistant' && content !== '') return [{ id, role, content }];
    return [];
  });
}

export function createChatSession(deps: ChatSessionDeps): ChatSession {
  const { api, executor } = deps;
  const wait = deps.wait ?? defaultWait;

  let messages = $state<ChatMessage[]>([]);
  let loading = $state(false);
  let activity = $state<ToolActivity[]>([]);
  /** Numbers the calls the server refused, so that each has its own line. */
  let refusedCalls = 0;
  let error = $state<string | null>(null);

  const conversations = new Set<Conversation>();
  let disposed = false;
  // Counts the openings of a saved conversation: one that finds a later one has started stops.
  let openings = 0;

  /** `call`, and again after each wait of `retryDelaysMs` while the store refuses for a state it has not reached yet. */
  async function retrying<T>(call: () => Promise<T>): Promise<T> {
    for (const delay of chatConfig.retryDelaysMs) {
      try {
        return await call();
      } catch (failure) {
        if (!(failure instanceof Error) || !isTransientRefusal(failure)) throw failure;
      }
      await wait(delay);
    }
    return call();
  }

  const transport = realtimeTransport({
    subscribe: (channelId, handlerOrOptions) => retrying(() => api.subscribe(channelId, handlerOrOptions)),
    sendMessage: async (channelId, message, conversationId) => {
      const mapContext = deps.mapContext();
      await retrying(() => api.stream(message, conversationId ?? channelId, mapContext));
    },
    resume: async (channelId, responses, conversationId) => {
      const id = conversationId ?? channelId;
      const answers = responses.map(({ interruptId, response }) => ({ interruptId, response: typeof response === 'string' ? response : JSON.stringify(response) }));
      try {
        await retrying(() => api.resume(id, answers));
      } catch (failure) {
        if (failure instanceof Error && failure.name === conversationErrors.InterruptNotPending) {
          // Still refused after the waits: when the answered interrupts are not pending any more, the turn cannot go on.
          const { interrupts } = await api.getPendingInterrupts(id);
          if (!answers.some(({ interruptId }) => interrupts.some((pending) => pending.id === interruptId))) throw Object.assign(new Error('The answered interrupts are not pending any more.'), { name: chatConfig.errorNames.answerRefused });
        }
        throw failure;
      }
    }
  });

  let current = startConversation();

  // A reload leaves the conversation of the last page behind: what it left pending is answered `SESSION_RESET` (the map is not restored), and it is forgotten.
  const stored = deps.store.read();
  if (stored !== null && stored.owner === deps.owner) {
    deps.store.clear();
    void settlePending(stored.conversationId);
  }

  function startConversation(): Conversation {
    const chat = createChat({
      transport,
      api: {
        createConversation: async () => {
          const created = await api.createConversationId();
          deps.store.write({ owner: deps.owner, conversationId: created.conversationId });
          return created;
        },
        getConversation: (id) => api.getConversation(id),
        getPendingInterrupts: (id) => api.getPendingInterrupts(id)
      },
      onMessagesChange: (list) => {
        if (!conversation.discarded) messages = displayMessages(list);
      },
      onChunk: (chunk) => {
        if (chunk.type === 'done') endTurn(conversation);
        else if (chunk.type === 'tool-result') noteToolResult(conversation, chunk.toolName);
      },
      onError: (message, cause) => endTurn(conversation, cause instanceof Error ? cause : new Error(message)),
      onInterrupt: (interrupts) => handleInterrupts(conversation, interrupts)
    });
    const conversation: Conversation = { chat, discarded: false, turnOpen: false, handling: new Set(), answered: new Set(), interrupted: false, unsettled: false, awaitedResults: new Map(), restoring: false, reopened: false };
    conversations.add(conversation);
    return conversation;
  }

  function closeConversation(conversation: Conversation): void {
    conversation.chat.destroy();
    conversations.delete(conversation);
  }

  /**
   * Answers every interrupt the server still holds pending in the conversation `SESSION_RESET`, in one resume. Best effort:
   * there is nobody to tell when it fails (the conversation is being left anyway), and it is never waited on for long.
   * Says whether nothing is left pending (as far as it could tell).
   */
  async function settlePending(conversationId: string): Promise<boolean> {
    try {
      const { interrupts } = await api.getPendingInterrupts(conversationId);
      if (interrupts.length === 0) return true;
      await api.resume(conversationId, interrupts.map(({ id }) => ({ interruptId: id, response: JSON.stringify(sessionReset) })));
      return true;
    } catch {
      // Left as it is.
      return false;
    }
  }

  /** The turn is over (`done`, or a failure: an `Error` is described by its name, a string is the message as it is). A discarded conversation has nothing more to do. */
  function endTurn(conversation: Conversation, failure?: Error | string): void {
    conversation.turnOpen = false;
    conversation.awaitedResults.clear();
    // The server says it holds interrupts of this conversation (the answer to the stream request may have been lost), or the turn raised some and failed.
    if (failure instanceof Error && failure.name === conversationErrors.InterruptsPending) conversation.unsettled = true;
    if (failure !== undefined && conversation.interrupted) conversation.unsettled = true;
    if (conversation.discarded) {
      const id = conversation.chat.getConversationId();
      closeConversation(conversation);
      if (conversation.unsettled && id !== null && !disposed) void settlePending(id);
      return;
    }
    loading = false;
    if (failure !== undefined) error = typeof failure === 'string' ? failure : describeError(failure);
  }

  /** Leaves the current conversation for a new one: it is discarded (a running turn ends by itself), what it left pending is answered `SESSION_RESET`, and the display is empty. */
  function replaceConversation(): Promise<void> {
    const abandoned = current;
    abandoned.discarded = true;
    let settled: Promise<void> = Promise.resolve();
    // A running turn stays to answer the tool calls that still come, and ends with its turn. Otherwise nothing runs: it can go.
    if (!abandoned.turnOpen) {
      const id = abandoned.chat.getConversationId();
      closeConversation(abandoned);
      if (abandoned.unsettled && id !== null) settled = settlePending(id).then(nothing);
    }
    current = startConversation();
    messages = [];
    activity = [];
    return settled;
  }

  function track(conversation: Conversation, id: string, tool: ToolName, state: ToolActivity['state'], code?: ActivityCode): void {
    if (conversation.discarded) return;
    const known = activity.find((entry) => entry.id === id);
    if (known) {
      known.state = state;
      known.code = code;
    } else activity.push({ id, tool, state, code });
  }

  /**
   * A `tool-result` chunk. The server publishes one for every call it finished, but none for a call it paused on an interrupt until
   * the answer came. So a result the answers do not account for is a call the server refused itself (SQL guard, input check):
   * the chunk does not say why, so the line carries one reason.
   */
  function noteToolResult(conversation: Conversation, name: string | undefined): void {
    const parsed = toolNameSchema.safeParse(name);
    if (!parsed.success) return;
    const awaited = conversation.awaitedResults.get(parsed.data) ?? 0;
    if (awaited > 0) {
      conversation.awaitedResults.set(parsed.data, awaited - 1);
      return;
    }
    refusedCalls += 1;
    track(conversation, `${chatConfig.serverRejectedCode}:${refusedCalls}`, parsed.data, 'failed', chatConfig.serverRejectedCode);
  }

  /** The tool call of one interrupt, answered as the result the model reads. */
  async function runInterrupt(conversation: Conversation, { interruptId, reason }: NotifiedInterrupt): Promise<ClientToolResult<ToolResultData>> {
    const request = clientToolRequestSchema.safeParse(reason);
    if (!request.success) return toolError('INVALID_INPUT', 'The tool request is not one this app can run.');
    if (conversation.discarded) return sessionReset;
    track(conversation, interruptId, request.data.tool, 'running');
    try {
      const result = await executor(request.data);
      track(conversation, interruptId, request.data.tool, result.ok ? 'done' : 'failed', result.ok ? undefined : result.error.code);
      return result;
    } catch {
      track(conversation, interruptId, request.data.tool, 'failed', 'ENGINE_UNAVAILABLE');
      return toolError('ENGINE_UNAVAILABLE', 'The tool stopped unexpectedly.');
    }
  }

  function handleInterrupts(conversation: Conversation, interrupts: NotifiedInterrupt[]): void {
    if (conversation.restoring) return;
    const fresh = interrupts.filter(({ interruptId }) => !conversation.answered.has(interruptId) && !conversation.handling.has(interruptId));
    if (fresh.length === 0) return;
    conversation.interrupted = true;
    for (const { interruptId } of fresh) conversation.handling.add(interruptId);
    void answerInterrupts(conversation, fresh);
  }

  /** Runs the calls in the model's order, then answers all of them in one resume (an answer to only some brings the rest again). */
  async function answerInterrupts(conversation: Conversation, interrupts: NotifiedInterrupt[]): Promise<void> {
    const results: ClientToolResult<ToolResultData>[] = [];
    for (const interrupt of interrupts) results.push(await runInterrupt(conversation, interrupt));
    // A reset while the calls ran: whatever they did, the model is told the conversation is gone.
    const answers = conversation.discarded ? interrupts.map(() => sessionReset) : fitToolResults(results);
    const responses = interrupts.map(({ interruptId }, index) => ({ interruptId, response: JSON.stringify(answers[index]) }));
    for (const { interruptId } of interrupts) {
      conversation.handling.delete(interruptId);
      conversation.answered.add(interruptId);
    }
    // Disposed, or the conversation closed (a reset ended its turn), while the calls ran: its subscriptions are closed, nothing more is sent.
    if (disposed || !conversations.has(conversation)) return;
    if (!conversation.discarded) {
      for (const interrupt of interrupts) {
        const request = clientToolRequestSchema.safeParse(interrupt.reason);
        if (request.success) conversation.awaitedResults.set(request.data.tool, (conversation.awaitedResults.get(request.data.tool) ?? 0) + 1);
      }
    }
    const accepted = await conversation.chat.sendMessage({ interruptResponses: responses });
    if (!accepted) endTurn(conversation, chatConfig.text.answerNotSent);
  }

  return {
    get messages() {
      return messages;
    },
    get isLoading() {
      return loading;
    },
    get activity() {
      return activity;
    },
    get error() {
      return error;
    },
    get conversationId() {
      return current.chat.getConversationId();
    },
    async send(text) {
      const message = text.trim();
      if (message === '' || loading || disposed) return;
      error = null;
      loading = true;
      // The last turn left interrupts the server may still hold: they are answered `SESSION_RESET`, and the message goes to a new conversation.
      // The same happens once more when the server refuses the message for interrupts it holds (the browser never saw them).
      for (let recoveries = 0; ; recoveries++) {
        if (current.unsettled) {
          const id = current.chat.getConversationId();
          const retry = current.reopened && id !== null;
          if (retry && (await settlePending(id))) {
            current.unsettled = false;
            current.reopened = false;
          } else {
            await replaceConversation();
            // What the user sees of the conversation they opened is gone: they are told.
            if (retry) error = chatConfig.text.restoreNotContinued;
          }
        }
        if (disposed) return;
        const conversation = current;
        activity = [];
        conversation.turnOpen = true;
        conversation.interrupted = false;
        const accepted = await conversation.chat.sendMessage(message);
        if (!accepted) endTurn(conversation, chatConfig.text.answerNotSent);
        if (!conversation.unsettled || conversation.interrupted || recoveries > 0 || disposed) return;
        error = null;
        loading = true;
      }
    },
    async openConversation(conversationId) {
      if (disposed) return 'failed';
      const opening = ++openings;
      // Busy while it loads: nothing is sent to the conversation that is being left, or to this one before it is whole.
      loading = true;
      await replaceConversation();
      if (opening !== openings || disposed) return 'failed';
      error = null;
      const conversation = current;
      conversation.restoring = true;
      try {
        await conversation.chat.loadConversation(conversationId);
        if (opening !== openings) return 'failed';
        conversation.restoring = false;
        deps.store.write({ owner: deps.owner, conversationId });
        // What it left pending belongs to a map that is gone: answered, and when that fails the next `send` settles it.
        if (!(await settlePending(conversationId))) {
          conversation.unsettled = true;
          conversation.reopened = true;
        }
        return 'opened';
      } catch (failure) {
        if (opening !== openings) return 'failed';
        // The chat is bound to the conversation it failed to load: it is left for a new one.
        await replaceConversation();
        const gone = failure instanceof Error && failure.name === conversationErrors.NotFound;
        if (failure instanceof Error) error = gone ? chatConfig.text.restoreNotFound : describeError(failure);
        else error = chatConfig.text.errorGeneric;
        return gone ? 'notFound' : 'failed';
      } finally {
        if (opening === openings) loading = false;
      }
    },
    reset() {
      if (disposed) return;
      openings++;
      void replaceConversation();
      error = null;
      loading = false;
    },
    dispose() {
      disposed = true;
      for (const conversation of conversations) {
        conversation.discarded = true;
        conversation.chat.destroy();
      }
      conversations.clear();
    }
  };
}
