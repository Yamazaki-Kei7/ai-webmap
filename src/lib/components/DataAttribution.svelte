<script lang="ts">
  import { legendConfig } from '../../../shared/config';
  import { attributionLine, sourceKey, visibleSources } from '$lib/map/attribution';
  import { mapState } from '$lib/map/mapState.svelte';
  import { attributionDetailsId } from './panelIds';

  const sources = $derived(visibleSources(mapState.layers));
  const line = $derived(attributionLine(sources));

  let open = $state(false);
</script>

{#if line}
  <div
    class="pointer-events-auto flex max-w-full shrink-0 flex-col rounded border border-bb-border bg-bb-surface/90 text-xs text-bb-muted shadow"
    data-testid="data-attribution"
  >
    {#if open}
      <ul
        id={attributionDetailsId}
        class="flex flex-col gap-1 overflow-y-auto border-b border-bb-border px-2 py-1"
        style:max-height="{legendConfig.attribution.maxListPx}px"
        data-testid="data-attribution-list"
      >
        {#each sources as source (sourceKey(source))}
          <li data-testid="data-attribution-item">
            出典：<a class="text-bb-accent underline" href={source.url} target="_blank" rel="noopener noreferrer">{source.name}</a>（{source.year}）を加工して作成
          </li>
        {/each}
      </ul>
    {/if}
    <p class="flex items-baseline gap-2 px-2 py-1" data-testid="data-attribution-line">
      <span class="min-w-0">{line}</span>
      <button
        type="button"
        class="shrink-0 text-bb-accent underline"
        aria-expanded={open}
        aria-controls={open ? attributionDetailsId : undefined}
        data-testid="data-attribution-toggle"
        onclick={() => (open = !open)}
      >
        {legendConfig.attribution.details}
      </button>
    </p>
  </div>
{/if}
