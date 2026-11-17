<script lang="ts">
  import { tick } from 'svelte';
  import { agentConfig, chatConfig, layoutConfig } from '../../../shared/config';
  import { canSend, chatEngineState, draftLength, inputBlock, inputBlockText, isNearBottom, isSendKey, mayRestoreFocus } from '$lib/chat/chatPanelState';
  import type { ChatSession } from '$lib/chat/chatSession.svelte';
  import type { EngineStatus } from '$lib/duckdb/engineCore';
  import { isRetryableMessage } from '$lib/duckdb/errors';
  import ChatMessage from './ChatMessage.svelte';
  import { narrowViewport } from './narrowViewport';
  import ToolActivity from './ToolActivity.svelte';

  /** `session`: the chat of the signed-in user (the shell owns it: saving and opening a map reach it), undefined before there is one. `restoring`: how far the map being rebuilt is, or null. */
  let {
    engineStatus,
    session,
    owner,
    restoring = null,
    onRetry
  }: { engineStatus: EngineStatus; session: ChatSession | undefined; owner: string | null; restoring?: { done: number; total: number } | null; onRetry: () => void } = $props();

  const text = chatConfig.text;
  const messages = $derived(session?.messages ?? []);
  const activity = $derived(session?.activity ?? []);
  const busy = $derived(session?.isLoading ?? false);
  const error = $derived(session?.error ?? null);

  const engine = $derived(chatEngineState(engineStatus));
  const block = $derived(inputBlock(engine, busy, restoring !== null));
  const blockText = $derived(block === null ? null : inputBlockText(block, restoring));
  const retryable = $derived(engineStatus.state === 'error' && isRetryableMessage(engineStatus.message));

  let draft = $state('');
  // A draft is the writer's: another user (or sign-out) does not inherit it.
  $effect(() => {
    void owner;
    draft = '';
  });
  const length = $derived(draftLength(draft));
  const narrow = $derived(narrowViewport.current);
  const overLimit = $derived(length > agentConfig.maxUtteranceChars);

  let input = $state<HTMLTextAreaElement>();
  let list = $state<HTMLElement>();
  let panel = $state<HTMLElement>();
  // The list follows the newest text until the reader scrolls up; sending (or a new conversation) follows again.
  let following = true;
  let refocus = false;

  // A disabled textarea loses the focus: it goes back to it when the turn is over, unless the user has moved it elsewhere.
  $effect(() => {
    if (busy || !refocus) return;
    refocus = false;
    if (mayRestoreFocus(document.activeElement, document.body, panel)) input?.focus();
  });

  // The completed reply is announced (not the tokens while it streams, nor the user's own messages or the activity lines).
  let announcement = $state('');
  let turnRan = false;
  $effect(() => {
    if (busy) {
      turnRan = true;
      return;
    }
    if (!turnRan) return;
    turnRan = false;
    const last = messages.at(-1);
    const reply = last?.role === 'assistant' ? last.content : '';
    // Emptied first: the same text again is a change a screen reader announces.
    announcement = '';
    if (reply !== '') void tick().then(() => (announcement = reply));
  });

  // Follows the newest message, token by token, and the activity lines.
  $effect(() => {
    void messages.length;
    void messages.at(-1)?.content;
    void activity.length;
    if (!following) return;
    void tick().then(() => {
      if (list) list.scrollTop = list.scrollHeight;
    });
  });

  async function submit(): Promise<void> {
    const message = draft;
    if (!session || block !== null || !canSend(message, agentConfig.maxUtteranceChars)) return;
    draft = '';
    following = true;
    refocus = true;
    await session.send(message);
  }

  function reset(): void {
    session?.reset();
    following = true;
    input?.focus();
  }
</script>

<div bind:this={panel} class="flex min-h-0 flex-col gap-2 border-t border-bb-border p-3 text-sm" data-testid="chat-panel">
  {#if engine === 'denied'}
    <p class="rounded border border-bb-border bg-bb-surface-alt p-2 text-bb-danger" role="status" data-testid="chat-denied">{text.notAllowed}</p>
  {:else if engine === 'failed'}
    <div class="flex flex-wrap items-center gap-2 rounded border border-bb-border bg-bb-surface-alt p-2" role="alert" data-testid="chat-engine-banner">
      <span class="text-bb-danger">{text.engineFailed}</span>
      {#if retryable}
        <button type="button" class="rounded border border-bb-border px-2 py-0.5" data-testid="chat-engine-retry" onclick={onRetry}>{text.engineRetry}</button>
      {/if}
    </div>
  {/if}

  <p class="sr-only" role="status" data-testid="chat-announcement">{announcement}</p>

  <div
    bind:this={list}
    class="flex max-h-[40dvh] min-h-24 flex-col gap-2 overflow-y-auto"
    style:max-height={narrow ? layoutConfig.narrowChat.listMaxHeight : undefined}
    role="region"
    aria-label={text.messagesLabel}
    data-testid="chat-messages"
    onscroll={(event) => (following = isNearBottom(event.currentTarget))}
  >
    {#if messages.length === 0}
      <div class="flex flex-col gap-1 text-bb-muted" data-testid="chat-empty">
        <p>{text.emptyHint}</p>
        <ul class="flex flex-col gap-1">
          {#each text.examples as example (example)}
            <li>
              <button
                type="button"
                class="w-full rounded border border-bb-border px-2 py-1 text-left hover:bg-bb-surface-alt disabled:opacity-50"
                data-testid="chat-example"
                disabled={!session || block !== null}
                onclick={() => {
                  draft = example;
                  input?.focus();
                }}
              >
                {example}
              </button>
            </li>
          {/each}
        </ul>
      </div>
    {:else}
      <ul class="flex flex-col gap-2">
        {#each messages as message (message.id)}
          <ChatMessage {message} />
        {/each}
      </ul>
    {/if}
    <ToolActivity entries={activity} />
  </div>

  {#if error}
    <p class="text-xs break-words text-bb-danger" role="alert" data-testid="chat-error">{error}</p>
  {/if}
  {#if blockText}
    <p class="text-xs text-bb-muted" data-testid="chat-block-reason">{blockText}</p>
  {/if}

  <textarea
    bind:this={input}
    class="h-20 w-full rounded border border-bb-border bg-bb-surface p-2 focus-visible:outline-2 focus-visible:outline-bb-focus-ring disabled:opacity-50"
    placeholder={text.inputPlaceholder}
    aria-label={text.inputLabel}
    data-testid="chat-input"
    style:height={narrow ? layoutConfig.narrowChat.inputHeight : undefined}
    disabled={!session || block !== null}
    bind:value={draft}
    onkeydown={(event) => {
      if (!isSendKey(event)) return;
      event.preventDefault();
      void submit();
    }}
  ></textarea>
  <div class="flex items-center gap-2">
    <button
      type="button"
      class="rounded bg-bb-accent px-3 py-1 text-bb-accent-text hover:bg-bb-accent-hover disabled:opacity-50"
      data-testid="chat-send"
      disabled={!session || block !== null || !canSend(draft, agentConfig.maxUtteranceChars)}
      onclick={submit}
    >
      {text.send}
    </button>
    <button
      type="button"
      class="rounded border border-bb-border px-3 py-1 disabled:opacity-50"
      data-testid="chat-reset"
      disabled={!session || engine === 'denied'}
      onclick={reset}
    >
      {text.reset}
    </button>
    <span class={['ml-auto text-xs', overLimit ? 'text-bb-danger' : 'text-bb-muted']} data-testid="chat-counter">{length} / {agentConfig.maxUtteranceChars}</span>
  </div>
</div>
