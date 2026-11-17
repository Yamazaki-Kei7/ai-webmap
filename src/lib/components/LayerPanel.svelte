<script lang="ts">
  import type { Snippet } from 'svelte';
  import { inTopDownOrder } from '$lib/map/drawOrder';
  import { mapState } from '$lib/map/mapState.svelte';
  import { restoreProgress } from '$lib/map/persist.svelte';
  import { restoreProgressText, restoreSummaryText } from '$lib/map/savedMaps';
  import LayerCard from './LayerCard.svelte';
  import { narrowViewport } from './narrowViewport';
  import { panelBodyId, panelHeadingId } from './panelIds';

  /** Extra content above the cards (the dev boxes). */
  let { children }: { children?: Snippet } = $props();

  // The top of the list is the top of the map.
  const topDown = $derived(inTopDownOrder(mapState.layers));

  // Collapsible only on a narrow screen, where the panel would cover the map; it starts collapsed there until the user chooses.
  let chosenOpen = $state<boolean | undefined>(undefined);
  const narrow = $derived(narrowViewport.current);
  const open = $derived(!narrow || (chosenOpen ?? false));

  // While a saved map is rebuilt: how far it is. Afterwards: how many layers stayed behind (they are error layers, until removed).
  const progress = $derived(restoreProgress.current);
  const summary = $derived(restoreSummaryText(mapState.layers.filter((layer) => layer.status === 'error').length));
</script>

<aside
  class={[
    'pointer-events-auto flex min-h-0 flex-col rounded border border-bb-border bg-bb-surface shadow',
    narrow ? (open ? 'w-full' : 'w-fit') : 'w-72'
  ]}
  data-testid="layer-panel"
>
  <div class="flex items-center justify-between gap-3 px-3 py-2">
    <h2 id={panelHeadingId} tabindex="-1" class="text-sm font-medium outline-none">レイヤー（{mapState.layers.length}）</h2>
    {#if narrow}
      <button
        type="button"
        class="rounded border border-bb-border px-2 text-xs"
        aria-expanded={open}
        aria-controls={open ? panelBodyId : undefined}
        aria-label={open ? 'レイヤーパネルを閉じる' : 'レイヤーパネルを開く'}
        data-testid="layer-panel-toggle"
        onclick={() => (chosenOpen = !open)}
      >
        {open ? '閉じる' : '開く'}
      </button>
    {/if}
  </div>
  {#if progress}
    <p class="px-3 pb-2 text-xs text-bb-muted" role="status" data-testid="restore-progress">{restoreProgressText(progress)}</p>
  {:else if summary}
    <p class="px-3 pb-2 text-xs text-bb-danger" role="status" data-testid="restore-summary">{summary}</p>
  {/if}
  {#if open}
    <div id={panelBodyId} class="flex min-h-0 flex-col gap-3 overflow-y-auto border-t border-bb-border p-3" data-testid="layer-panel-body">
      {@render children?.()}
      {#if topDown.length === 0}
        <p class="text-xs text-bb-muted" data-testid="layer-empty">レイヤーはまだありません。</p>
      {/if}
      <ul class="flex flex-col gap-2" data-testid="layer-list">
        {#each topDown as layer (layer.id)}
          <LayerCard {layer} />
        {/each}
      </ul>
    </div>
  {/if}
</aside>
