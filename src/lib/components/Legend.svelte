<script lang="ts">
  import { legendConfig } from '../../../shared/config';
  import type { GeometryFamily } from '../../../shared/mapSpec';
  import { formatLegendNumber, intervalLabel, intervalPosition, scaleNote, toLegend } from '$lib/map/legend';
  import type { LayerState } from '$lib/map/mapState.svelte';

  let { layer }: { layer: LayerState } = $props();

  const legend = $derived(toLegend(layer));

  const shapeClass: Record<GeometryFamily, string> = {
    point: 'size-3 rounded-full',
    line: 'h-1 w-4 rounded-full',
    polygon: 'size-3 rounded-sm'
  };
</script>

{#snippet swatch(color: string, geometryType: GeometryFamily)}
  <span class={['inline-block shrink-0 border border-bb-border', shapeClass[geometryType]]} style:background-color={color}></span>
{/snippet}

<div class="flex flex-col gap-1 text-xs" data-testid="legend" data-legend-type={legend.type}>
  {#if legend.type === 'single'}
    <div class="flex items-center gap-2">
      {@render swatch(legend.color, legend.geometryType)}
    </div>
  {:else}
    <p class="truncate text-bb-muted" data-testid="legend-column">{legend.column}</p>
    {#if legend.type === 'categorized'}
      <ul class="flex flex-col gap-0.5">
        {#each legend.items as item, i (i)}
          <li class="flex items-center gap-2" data-testid="legend-item">
            {@render swatch(item.color, legend.geometryType)}
            <span class="min-w-0 flex-1 truncate">{item.label}</span>
            <span class="text-bb-muted tabular-nums">{formatLegendNumber(item.count)}</span>
          </li>
        {/each}
      </ul>
    {:else if legend.type === 'graduated'}
      <ul class="flex flex-col gap-0.5">
        {#each legend.items as item, i (i)}
          <li class="flex items-center gap-2" data-testid="legend-item" class:text-bb-muted={item.empty}>
            {@render swatch(item.color, legend.geometryType)}
            <span class="tabular-nums">{intervalLabel(item, intervalPosition(i, legend.items.length))}</span>
          </li>
        {/each}
        {#if legend.noData}
          <li class="flex items-center gap-2" data-testid="legend-item">
            {@render swatch(legend.noData.color, legend.geometryType)}
            <span class="min-w-0 flex-1 truncate">{legendConfig.text.noData}</span>
            <span class="text-bb-muted tabular-nums">{formatLegendNumber(legend.noData.count)}</span>
          </li>
        {/if}
      </ul>
    {:else}
      {@const size = 2 * Math.max(...legend.items.map((item) => item.radius)) * legend.scale}
      <div class="flex items-end gap-3" data-testid="legend-circles">
        <!-- Nested circles, aligned at the bottom: the width is that of the largest one. -->
        <div class="relative shrink-0" style:width="{size}px" style:height="{size}px">
          {#each [...legend.items].reverse() as item (item.value)}
            <span
              class="absolute bottom-0 left-1/2 -translate-x-1/2 rounded-full border border-bb-border"
              style:width="{2 * item.radius * legend.scale}px"
              style:height="{2 * item.radius * legend.scale}px"
              style:background-color={legend.color}
              style:opacity="0.8"
            ></span>
          {/each}
        </div>
        <ul class="flex min-w-0 flex-col gap-0.5 tabular-nums">
          {#each [...legend.items].reverse() as item (item.value)}
            <li data-testid="legend-item">{formatLegendNumber(item.value)}</li>
          {/each}
        </ul>
      </div>
      {#if legend.noData}
        <p class="flex items-center gap-2" data-testid="legend-item">
          <!-- A fixed symbol on the map (not a value): drawn at the map's size, whatever the scale. -->
          <span
            class="inline-block shrink-0 rounded-full"
            style:width="{2 * legend.noData.radius}px"
            style:height="{2 * legend.noData.radius}px"
            style:background-color={legend.noData.color}
          ></span>
          <span class="min-w-0 flex-1 truncate">{legendConfig.text.noData}</span>
          <span class="text-bb-muted tabular-nums">{formatLegendNumber(legend.noData.count)}</span>
        </p>
      {/if}
      {#if scaleNote(legend.scale)}
        <p class="text-bb-muted" data-testid="legend-scale-note">{scaleNote(legend.scale)}</p>
      {/if}
    {/if}
  {/if}
</div>
