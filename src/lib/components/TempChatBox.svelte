<script lang="ts">
  import type { Map as MaplibreMap } from 'maplibre-gl';
  import { agentConfig, chatConfig } from '../../../shared/config';
  import { chatApi } from '$lib/chat/chatApi';
  import { bindChatToUser } from '$lib/chat/chatBinding.svelte';
  import { createChatSession } from '$lib/chat/chatSession.svelte';
  import { createConversationStore } from '$lib/chat/conversationStore';
  import { createClientToolExecutor } from '$lib/chat/clientTools';
  import { summarizeForLlm } from '$lib/map/mapState.svelte';

  // The temporary chat of the dock; the chat panel replaces it.
  let { ready, map, owner }: { ready: boolean; map?: MaplibreMap; owner: string | null } = $props();

  const text = chatConfig.text;
  const store = createConversationStore(() => sessionStorage);
  // One session per signed-in user: another user, or signing out, drops it.
  const binding = bindChatToUser({
    getOwner: () => owner,
    createSession: (name) => createChatSession({ api: chatApi, owner: name, store, executor: createClientToolExecutor(() => map), mapContext: summarizeForLlm })
  });
  const session = $derived(binding.session);
  const messages = $derived(session?.messages ?? []);
  const activity = $derived(session?.activity ?? []);
  const busy = $derived(session?.isLoading ?? false);
  const error = $derived(session?.error ?? null);

  let draft = $state('');
  // A draft is the writer's: another user (or sign-out) does not inherit it.
  $effect(() => {
    void owner;
    draft = '';
  });

  const activityText = (tool: keyof typeof text.activity, state: 'running' | 'done' | 'failed'): string =>
    `${text.activity[tool]}${state === 'running' ? text.activityRunning : state === 'done' ? text.activityDone : text.activityFailed}`;

  async function submit(): Promise<void> {
    const message = draft;
    if (!session || !ready || busy || message.trim() === '') return;
    draft = '';
    await session.send(message);
  }
</script>

<div class="flex max-h-[60dvh] flex-col gap-2 border-t border-bb-border p-3 text-sm">
  <ul class="flex min-h-16 flex-col gap-2 overflow-y-auto" data-testid="chat-messages">
    {#each messages as message (message.id)}
      <li
        class={['max-w-full rounded px-2 py-1 whitespace-pre-wrap [overflow-wrap:anywhere]', message.role === 'user' ? 'self-end bg-bb-border' : 'self-start border border-bb-border']}
        data-testid="chat-message"
        data-role={message.role}
      >
        {message.content}
      </li>
    {/each}
  </ul>

  <div class="flex flex-col gap-1 text-xs text-bb-muted" data-testid="chat-activity">
    {#each activity as entry (entry.id)}
      <span data-state={entry.state}>{activityText(entry.tool, entry.state)}</span>
    {/each}
    {#if busy && activity.length === 0}
      <span>{text.working}</span>
    {/if}
  </div>
  {#if error}
    <p class="text-xs break-words text-bb-danger" role="alert" data-testid="chat-error">{error}</p>
  {/if}
  {#if !ready}
    <p class="text-xs text-bb-muted">{text.engineNotReady}</p>
  {/if}

  <textarea
    class="h-20 w-full rounded border border-bb-border bg-bb-surface p-2"
    placeholder={text.inputPlaceholder}
    aria-label={text.inputLabel}
    maxlength={agentConfig.maxUtteranceChars}
    data-testid="chat-input"
    disabled={!session || !ready || busy}
    bind:value={draft}
    onkeydown={(event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submit();
    }}
  ></textarea>
  <div class="flex gap-2">
    <button
      type="button"
      class="rounded border border-bb-border px-3 py-1 disabled:opacity-50"
      data-testid="chat-send"
      disabled={!session || !ready || busy || draft.trim() === ''}
      onclick={submit}
    >
      {text.send}
    </button>
    <button type="button" class="rounded border border-bb-border px-3 py-1" data-testid="chat-reset" onclick={() => session?.reset()}>
      {text.reset}
    </button>
  </div>
</div>
