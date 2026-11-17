<script lang="ts">
  import { formatLegendNumber } from '$lib/map/legend';
  import { removeLayer, setVisible, type LayerState } from '$lib/map/mapState.svelte';
  import Legend from './Legend.svelte';
  import { panelHeadingId } from './panelIds';

  let { layer }: { layer: LayerState } = $props();

  let sqlOpen = $state(false);
  let card: HTMLLIElement | undefined = $state();

  /** Where the focus goes when the card is removed: the next card's remove button, else the previous one's, else the panel heading. */
  function remove(): void {
    const neighbour = card?.nextElementSibling ?? card?.previousElementSibling;
    const target = neighbour?.querySelector<HTMLElement>('[data-testid=layer-remove]') ?? document.getElementById(panelHeadingId);
    removeLayer(layer.id);
    target?.focus();
  }

  const label = $derived(`${layer.id} ${layer.name}`);
</script>

<li bind:this={card} class="flex flex-col gap-2 rounded border border-bb-border bg-bb-surface p-2 text-sm" data-testid="layer-item" data-layer-id={layer.id}>
  <div class="flex items-center gap-2">
    <input
      type="checkbox"
      checked={layer.visible}
      aria-label={`${label} を表示`}
      data-testid="layer-visible"
      onchange={(event) => setVisible(layer.id, event.currentTarget.checked)}
    />
    <div class="min-w-0 flex-1">
      <p class="truncate font-medium" data-testid="layer-name">{layer.name}</p>
      <p class="text-xs text-bb-muted">
        <span data-testid="layer-id">{layer.id}</span> ・ <span data-testid="layer-count">{formatLegendNumber(layer.featureCount)}</span> 件
      </p>
    </div>
    <button
      type="button"
      class="rounded border border-bb-border px-2 text-xs"
      aria-label={`${label} を削除`}
      data-testid="layer-remove"
      onclick={remove}
    >
      削除
    </button>
  </div>

  {#if layer.status === 'loading'}
    <p class="flex items-center gap-2 text-xs text-bb-muted" role="status" data-testid="layer-status">
      <span class="inline-block size-3 animate-spin rounded-full border-2 border-bb-border border-t-bb-accent" aria-hidden="true"></span>
      読み込み中…
    </p>
  {:else if layer.status === 'error'}
    <p class="text-xs break-words text-bb-danger" role="alert" data-testid="layer-status">{layer.errorMessage ?? 'エラーが発生しました'}</p>
  {/if}

  {#if layer.status !== 'error'}
    <Legend {layer} />
  {/if}

  <div class="flex flex-col gap-1">
    <button
      type="button"
      class="flex items-center gap-1 self-start text-xs text-bb-muted"
      aria-expanded={sqlOpen}
      aria-label={`${label} の SQL を${sqlOpen ? '隠す' : '表示'}`}
      data-testid="layer-sql-toggle"
      onclick={() => (sqlOpen = !sqlOpen)}
    >
      <span aria-hidden="true">{sqlOpen ? '▾' : '▸'}</span>SQL
    </button>
    {#if sqlOpen}
      <pre class="max-h-40 overflow-auto rounded bg-bb-surface-alt p-2 font-mono text-xs break-words whitespace-pre-wrap" data-testid="layer-sql">{layer.sql}</pre>
    {/if}
  </div>
</li>
