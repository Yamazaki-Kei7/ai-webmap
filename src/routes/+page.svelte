<script lang="ts">
  import { onMount } from 'svelte';
  import { authApi } from 'aws-blocks';
  import { Authenticator, onAuthChange } from '@aws-blocks/blocks/ui';
  import { mountNode } from '$lib/mountNode';

  type AuthUser = Parameters<Parameters<typeof onAuthChange>[1]>[0];

  const appTitle = 'AI Webmap';

  let user = $state<AuthUser>(null);

  // Follows sign-in / sign-out from this window and other tabs.
  onMount(() => onAuthChange(authApi, (next) => { user = next; }));
</script>

<svelte:head>
  <title>{appTitle}</title>
</svelte:head>

<h1 class="mb-6 text-3xl font-bold">{appTitle}</h1>

{#if user}
  <p data-testid="signed-in-user">Signed in as <strong>{user.username}</strong>.</p>
{:else}
  <!-- The server offers sign-in only; accounts are created by the operator. -->
  <div {@attach mountNode(() => Authenticator(authApi))}></div>
{/if}
