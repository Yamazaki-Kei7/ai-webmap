<script lang="ts">
  import { mapState, removeLayer, setVisible } from '$lib/map/mapState.svelte';
</script>

<ul class="flex flex-col gap-1" data-testid="layer-list">
  {#each mapState.layers as layer (layer.id)}
    <li class="flex items-center gap-2 text-sm" data-testid="layer-item" data-layer-id={layer.id}>
      <input
        type="checkbox"
        checked={layer.visible}
        aria-label={`${layer.id} ${layer.name} を表示`}
        data-testid="layer-visible"
        onchange={(event) => setVisible(layer.id, event.currentTarget.checked)}
      />
      <span class="inline-block size-3 shrink-0 rounded-full" style:background-color={layer.color}></span>
      <span class="min-w-0 flex-1 truncate">{layer.id} {layer.name}（{layer.featureCount.toLocaleString('ja-JP')}）</span>
      <button
        type="button"
        class="rounded border border-bb-border px-2 text-xs"
        aria-label={`${layer.id} ${layer.name} を削除`}
        data-testid="layer-remove"
        onclick={() => removeLayer(layer.id)}
      >
        削除
      </button>
    </li>
  {/each}
</ul>
