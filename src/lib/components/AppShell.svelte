<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { Map as MaplibreMap } from 'maplibre-gl';
  import { authApi } from 'aws-blocks';
  import { AccountMenuBar } from '@aws-blocks/blocks/ui';
  import { mountNode } from '$lib/mountNode';
  import { restartEngine, type EngineStatus } from '$lib/duckdb/engine';
  import { runEngine } from '$lib/duckdb/engineEffect.svelte';
  import { isRetryableMessage } from '$lib/duckdb/errors';
  import DataAttribution from './DataAttribution.svelte';
  import DevSqlBox from './DevSqlBox.svelte';
  import DevStyleBox from './DevStyleBox.svelte';
  import DevToolBox from './DevToolBox.svelte';
  import LayerPanel from './LayerPanel.svelte';
  import MapView from './MapView.svelte';
  import TempChatBox from './TempChatBox.svelte';
  import { narrowViewport } from './narrowViewport';

  let {
    title,
    owner,
    engineStatus,
    setStatus,
    map = $bindable()
  }: {
    title: string;
    /** The signed-in user's name (the chat is kept per user). */
    owner: string | null;
    engineStatus: EngineStatus;
    setStatus: (next: EngineStatus) => void;
    map?: MaplibreMap;
  } = $props();

  let dockOpen = $state(true);

  // MapLibre's own attribution sits at the bottom right (two lines when opened on a narrow map). Where it reaches under the left
  // column, the data attribution is lifted above it, so that the two never cover each other; elsewhere it stays at the bottom edge.
  let leftColumn: HTMLElement | undefined = $state();
  let liftPx = $state(0);
  $effect(() => {
    const container = map?.getContainer();
    const corner = container?.querySelector('.maplibregl-ctrl-bottom-right');
    if (!container || !corner || !leftColumn) return;
    const column = leftColumn;
    const measure = () => {
      const overlaps = corner.getBoundingClientRect().left < column.getBoundingClientRect().right;
      liftPx = overlaps ? corner.getBoundingClientRect().height : 0;
    };
    const observer = new ResizeObserver(measure);
    observer.observe(corner);
    observer.observe(container);
    return () => observer.disconnect();
  });
</script>

<div class="flex h-dvh flex-col">
  <header class="flex items-center gap-4 border-b border-bb-border bg-bb-surface px-4 py-2">
    <h1 class="text-lg font-bold">{title}</h1>
    <p class="min-w-0 flex-1 truncate text-sm text-bb-muted" data-testid="engine-status">
      {#if engineStatus.state === 'loading'}
        データエンジン: 準備中（{engineStatus.step}）
      {:else if engineStatus.state === 'ready'}
        データエンジン: 準備完了（DuckDB {engineStatus.duckdbVersion}）
      {:else if engineStatus.state === 'error'}
        データエンジン: エラー: {engineStatus.message}
        {#if isRetryableMessage(engineStatus.message)}
          <button
            type="button"
            class="ml-2 rounded border border-bb-border px-2 py-0.5"
            data-testid="engine-retry"
            onclick={() => runEngine(restartEngine, setStatus)}
          >
            再試行
          </button>
        {/if}
      {/if}
    </p>
    <div {@attach mountNode(() => AccountMenuBar(authApi))}></div>
  </header>

  <!-- One dock for both layouts, so that its content survives a resize across the breakpoint. Wide: it floats over the map at the right;
       narrow: header, map and dock are stacked, and the dock is below the map. -->
  <div class="relative flex min-h-0 flex-1 flex-col">
    <div class="relative min-h-0 flex-1">
      <MapView bind:map />

      <!-- Left column over the map: the layer panel (shrinks and scrolls when tall) above the data attribution. -->
      <div
        bind:this={leftColumn}
        class={['pointer-events-none absolute top-3 left-3 flex flex-col justify-between gap-2', narrowViewport.current ? 'right-12' : 'w-72']}
        style:bottom="{liftPx + 8}px"
      >
        <LayerPanel>
          {#if import.meta.env.DEV}
            <DevSqlBox ready={engineStatus.state === 'ready'} />
            <DevStyleBox />
            <DevToolBox ready={engineStatus.state === 'ready'} {map} />
          {/if}
        </LayerPanel>
        <DataAttribution />
      </div>
    </div>

    <!-- The chat panel (Task 4.6) replaces the temporary chat box in this dock. -->
    <aside
      class={[
        'flex flex-col border-bb-border bg-bb-surface shadow',
        narrowViewport.current ? 'border-t' : 'absolute top-3 right-3 w-80 rounded border'
      ]}
      data-testid="chat-dock"
    >
      <button
        type="button"
        class="flex items-center justify-between px-3 py-2 text-sm font-medium"
        aria-expanded={dockOpen}
        data-testid="chat-dock-toggle"
        onclick={() => (dockOpen = !dockOpen)}
      >
        <span>チャット</span>
        <span aria-hidden="true">{dockOpen ? '▾' : '▸'}</span>
      </button>
      <!-- Hidden, not removed, when closed: the conversation lives in the chat box. -->
      <div class={dockOpen ? '' : 'hidden'}>
        <TempChatBox ready={engineStatus.state === 'ready'} {map} {owner} />
      </div>
    </aside>
  </div>
</div>
