<script lang="ts">
  import { onMount } from 'svelte';
  import { authApi } from 'aws-blocks';
  import { Authenticator, onAuthChange } from '@aws-blocks/blocks/ui';
  import { mountNode } from '$lib/mountNode';
  import { disposeEngine, initEngine, restartEngine, type EngineStatus } from '$lib/duckdb/engine';
  import { bindEngineToUser, runEngine } from '$lib/duckdb/engineEffect.svelte';
  import { isRetryableMessage } from '$lib/duckdb/errors';

  type AuthUser = Parameters<Parameters<typeof onAuthChange>[1]>[0];

  const appTitle = 'AI Webmap';

  let user = $state<AuthUser>(null);
  let engineStatus = $state<EngineStatus>({ state: 'idle' });
  const setStatus = (next: EngineStatus): void => { engineStatus = next; };

  // The data engine runs for the signed-in user; sign-out or another user drops its worker and the fetched data.
  bindEngineToUser({ getUser: () => user, initEngine, disposeEngine, setStatus });

  // Browser-check helpers; the guard removes the import from the production build.
  onMount(() => {
    if (import.meta.env.DEV) void import('$lib/duckdb/dev').then((dev) => dev.installDevHandle());
  });

  // Follows sign-in / sign-out from this window and other tabs.
  onMount(() => onAuthChange(authApi, (next) => { user = next; }));
</script>

<svelte:head>
  <title>{appTitle}</title>
</svelte:head>

<h1 class="mb-6 text-3xl font-bold">{appTitle}</h1>

{#if user}
  <p data-testid="signed-in-user">Signed in as <strong>{user.username}</strong>.</p>
  <p class="mt-2 text-sm text-bb-muted" data-testid="engine-status">
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
{:else}
  <!-- The server offers sign-in only; accounts are created by the operator. -->
  <div {@attach mountNode(() => Authenticator(authApi))}></div>
{/if}
