<script lang="ts">
  import { onMount } from 'svelte';
  import { authApi } from 'aws-blocks';
  import { Authenticator, onAuthChange } from '@aws-blocks/blocks/ui';
  import { mountNode } from '$lib/mountNode';
  import { disposeEngine, initEngine, type EngineStatus } from '$lib/duckdb/engine';
  import { bindEngineToUser } from '$lib/duckdb/engineEffect.svelte';
  import AppShell from '$lib/components/AppShell.svelte';
  import { resetMapState } from '$lib/map/mapState.svelte';
  import type { Map as MaplibreMap } from 'maplibre-gl';

  type AuthUser = Parameters<Parameters<typeof onAuthChange>[1]>[0];

  const appTitle = 'AI Webmap';

  let user = $state<AuthUser>(null);
  let map = $state<MaplibreMap>();
  let engineStatus = $state<EngineStatus>({ state: 'idle' });
  const setStatus = (next: EngineStatus): void => { engineStatus = next; };

  // The data engine runs for the signed-in user; sign-out or another user drops its worker and the fetched data.
  bindEngineToUser({ getUser: () => user, initEngine, disposeEngine, setStatus });

  // Signing out (or another user signing in) leaves no layer of the previous user behind.
  const owner = $derived(user?.username ?? null);
  $effect(() => {
    void owner;
    return resetMapState;
  });

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

{#if user}
  <AppShell title={appTitle} {owner} {engineStatus} {setStatus} bind:map />
{:else}
  <!-- The server offers sign-in only; accounts are created by the operator. -->
  <div class="mx-auto my-10 max-w-4xl p-5">
    <h1 class="mb-6 text-3xl font-bold">{appTitle}</h1>
    <div {@attach mountNode(() => Authenticator(authApi))}></div>
  </div>
{/if}
