<script lang="ts">
  import { queryLayer } from '$lib/duckdb/engine';
  import { addLayer, currentSession, mapState } from '$lib/map/mapState.svelte';

  let { ready }: { ready: boolean } = $props();

  let sql = $state('');
  let running = $state(false);
  let errorText = $state('');

  const viewNamePattern = /\bFROM\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/i;

  /** The first view name of the query, or `レイヤー N`. */
  function layerName(text: string): string {
    return viewNamePattern.exec(text)?.[1] ?? `レイヤー ${mapState.nextLayerSeq}`;
  }

  async function submit(): Promise<void> {
    const text = sql.trim();
    if (!ready || running || text === '') return;
    running = true;
    errorText = '';
    const session = currentSession();
    try {
      const result = await queryLayer(text);
      // A user who signed out (or another one who signed in) meanwhile gets nothing of it.
      if (session !== currentSession()) return;
      const added = result.ok ? addLayer({ name: layerName(text), sql: text }, result.data) : result;
      if (!added.ok) errorText = `${added.error.code}: ${added.error.message}`;
    } finally {
      running = false;
    }
  }
</script>

<div class="flex flex-col gap-2">
  <textarea
    class="h-24 w-full rounded border border-bb-border bg-bb-surface p-2 font-mono text-xs"
    placeholder="SELECT * FROM stations WHERE …"
    aria-label="SQL（開発用）"
    data-testid="dev-sql-input"
    bind:value={sql}
  ></textarea>
  <button
    type="button"
    class="self-start rounded border border-bb-border px-3 py-1 text-sm disabled:opacity-50"
    data-testid="dev-sql-submit"
    disabled={!ready || running}
    onclick={submit}
  >
    追加
  </button>
  {#if errorText}
    <p class="text-xs break-words text-bb-danger" data-testid="dev-sql-error">{errorText}</p>
  {/if}
</div>
