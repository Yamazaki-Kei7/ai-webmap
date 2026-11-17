<script lang="ts">
  import { onMount } from 'svelte';
  import { authApi } from 'aws-blocks';
  import { onAuthChange } from '@aws-blocks/blocks/ui';
  import TodoList from '$lib/components/TodoList.svelte';

  type AuthUser = Parameters<Parameters<typeof onAuthChange>[1]>[0];

  let user = $state<AuthUser>(null);

  // Follows sign-in / sign-out from this window and other tabs.
  onMount(() => onAuthChange(authApi, (next) => { user = next; }));
</script>

<svelte:head>
  <title>Blocks App</title>
</svelte:head>

<h1 class="mb-1 text-3xl font-bold">Blocks App</h1>
<p class="mb-6 text-sm leading-normal text-bb-muted">
  This starter app demonstrates:
  <strong class="text-bb-text">authentication</strong> with cross-tab coordination,
  <strong class="text-bb-text">real-time sync</strong> across browser tabs,
  and <strong class="text-bb-text">todos stored in a distributed table</strong> with per-user isolation.
</p>

{#if user}
  <!-- Keyed so a different user gets a fresh list and realtime subscription. -->
  {#key user.username}
    <TodoList />
  {/key}
{:else}
  <p>Sign in to get started.</p>
{/if}
