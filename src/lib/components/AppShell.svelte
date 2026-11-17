<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { Map as MaplibreMap } from 'maplibre-gl';
  import { authApi } from 'aws-blocks';
  import { AccountMenuBar } from '@aws-blocks/blocks/ui';
  import { mountNode } from '$lib/mountNode';
  import { restartEngine, type EngineStatus } from '$lib/duckdb/engine';
  import { runEngine } from '$lib/duckdb/engineEffect.svelte';
  import { isRetryableMessage } from '$lib/duckdb/errors';
  import DevSqlBox from './DevSqlBox.svelte';
  import LayerList from './LayerList.svelte';
  import MapView from './MapView.svelte';

  let {
    title,
    engineStatus,
    setStatus,
    map = $bindable()
  }: {
    title: string;
    engineStatus: EngineStatus;
    setStatus: (next: EngineStatus) => void;
    map?: MaplibreMap;
  } = $props();

  let dockOpen = $state(true);
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

  <div class="relative min-h-0 flex-1">
    <MapView bind:map />

    <!-- Left overlay: Phase 3 replaces this list with the layer cards. -->
    <aside
      class="absolute top-3 left-3 flex max-h-[calc(100%-1.5rem)] w-72 flex-col gap-3 overflow-y-auto rounded border border-bb-border bg-bb-surface p-3 shadow"
      data-testid="layer-panel"
    >
      {#if import.meta.env.DEV}
        <DevSqlBox ready={engineStatus.state === 'ready'} />
      {/if}
      <LayerList />
    </aside>

    <!-- Right dock: Phase 4 puts the chat here. -->
    <aside
      class="absolute top-3 right-3 flex w-80 flex-col rounded border border-bb-border bg-bb-surface shadow"
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
      {#if dockOpen}
        <p class="border-t border-bb-border p-3 text-sm text-bb-muted">チャット（準備中）</p>
      {/if}
    </aside>
  </div>
</div>
