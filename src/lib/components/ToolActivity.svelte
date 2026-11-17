<script lang="ts">
  import { chatConfig } from '../../../shared/config';
  import { activityText } from '$lib/chat/chatPanelState';
  import type { ToolActivity } from '$lib/chat/chatSession.svelte';

  let { entries }: { entries: readonly ToolActivity[] } = $props();
</script>

<!-- One line per tool call of the turn, each once; the state is spelled out in words (not only a colour). -->
<ul class="flex flex-col gap-0.5 text-xs text-bb-muted" aria-label={chatConfig.text.activityLabel} data-testid="chat-activity">
  {#each entries as entry (entry.id)}
    <li class={entry.state === 'failed' ? 'text-bb-danger' : ''} data-state={entry.state}>
      <span aria-hidden="true">{chatConfig.text.activityMarks[entry.state]}</span>
      {activityText(entry.tool, entry.state, entry.code)}
    </li>
  {/each}
</ul>
