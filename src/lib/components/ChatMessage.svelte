<script lang="ts">
  import { chatConfig } from '../../../shared/config';
  import type { ChatMessage } from '$lib/chat/chatSession.svelte';

  let { message }: { message: ChatMessage } = $props();

  const user = $derived(message.role === 'user');
</script>

<!-- The text is the model's or the user's: it is shown as text only (line breaks kept), never as HTML. -->
<li class={['flex max-w-full flex-col gap-0.5', user ? 'items-end' : 'items-start']} data-testid="chat-message-{message.role}">
  <span class="text-xs text-bb-muted">{user ? chatConfig.text.roleUser : chatConfig.text.roleAssistant}</span>
  <p class={['max-w-full rounded px-2 py-1 whitespace-pre-wrap [overflow-wrap:anywhere]', user ? 'bg-bb-surface-alt' : 'border border-bb-border']}>{message.content}</p>
</li>
