<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { Map as MaplibreMap } from 'maplibre-gl';
  import { authApi } from 'aws-blocks';
  import { AccountMenuBar } from '@aws-blocks/blocks/ui';
  import { mountNode } from '$lib/mountNode';
  import { bindChatToUser } from '$lib/chat/chatBinding.svelte';
  import { chatApi } from '$lib/chat/chatApi';
  import { createChatSession } from '$lib/chat/chatSession.svelte';
  import { createClientToolExecutor } from '$lib/chat/clientTools';
  import { createConversationStore } from '$lib/chat/conversationStore';
  import { createMapView } from '$lib/chat/mapView';
  import { queryLayer, restartEngine, type EngineStatus } from '$lib/duckdb/engine';
  import { runEngine } from '$lib/duckdb/engineEffect.svelte';
  import { isRetryableMessage } from '$lib/duckdb/errors';
  import { mapsApi } from '$lib/map/mapsApi';
  import { summarizeForLlm } from '$lib/map/mapState.svelte';
  import { restoreMap, restoreProgress } from '$lib/map/persist.svelte';
  import { createMapFlow } from '$lib/map/savedMapFlow.svelte';
  import { chatConfig } from '../../../shared/config';
  import DataAttribution from './DataAttribution.svelte';
  import ChatPanel from './ChatPanel.svelte';
  import DevPanel from './DevPanel.svelte';
  import LayerPanel from './LayerPanel.svelte';
  import MapBar from './MapBar.svelte';
  import MapView from './MapView.svelte';
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

  const retryEngine = (): void => runEngine(restartEngine, setStatus);

  // One chat session per signed-in user: another user, or signing out, drops it. The shell owns it, because saving and opening a map reach it.
  const store = createConversationStore(() => sessionStorage);
  const binding = bindChatToUser({
    getOwner: () => owner,
    createSession: (name) => createChatSession({ api: chatApi, owner: name, store, executor: createClientToolExecutor(() => map), mapContext: summarizeForLlm })
  });
  const session = $derived(binding.session);
  if (import.meta.env.DEV) {
    // Browser checks reach the session (`openConversation`) through this.
    $effect(() => {
      window.__aiWebmapChat = session;
      return () => {
        window.__aiWebmapChat = undefined;
      };
    });
  }

  // The map may not exist yet (it mounts with the shell): the view is kept in the state either way.
  const jumpTo = (center: [number, number], zoom: number): void => {
    if (map) createMapView(() => map).jumpTo(center, zoom);
  };
  const flow = createMapFlow({
    api: mapsApi,
    chat: () => session,
    restore: (state) => restoreMap(state, { queryLayer, jumpTo }),
    jumpTo
  });

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
  <header class="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-bb-border bg-bb-surface px-4 py-2">
    <h1 class="text-lg font-bold">{title}</h1>
    <!-- Narrow: the map's controls take a row of their own, under the title and the account menu. -->
    <div class={narrowViewport.current ? 'order-last basis-full' : ''}>
      <MapBar {flow} engineReady={engineStatus.state === 'ready'} />
    </div>
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
            onclick={retryEngine}
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
            <DevPanel ready={engineStatus.state === 'ready'} {map} />
          {/if}
        </LayerPanel>
        <DataAttribution />
      </div>
    </div>

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
        <span>{chatConfig.text.title}</span>
        <span aria-hidden="true">{dockOpen ? '▾' : '▸'}</span>
      </button>
      <!-- Hidden, not removed, when closed: the conversation lives in the chat panel. -->
      <div class={dockOpen ? '' : 'hidden'}>
        <ChatPanel {engineStatus} {session} {owner} restoring={restoreProgress.current} onRetry={retryEngine} />
      </div>
    </aside>
  </div>
</div>
