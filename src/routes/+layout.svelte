<script lang="ts">
  import '../app.css';
  import { authApi } from 'aws-blocks';
  import { AccountMenuBar, injectTheme } from '@aws-blocks/blocks/ui';
  import { mountNode } from '$lib/mountNode';

  let { children } = $props();

  injectTheme();
</script>

<div class="mx-auto my-10 max-w-4xl p-5">
  <!-- Account Menu bar that pops open the authenticator when Sign In is clicked. -->
  <div {@attach mountNode(() => AccountMenuBar(authApi))}></div>
  {@render children()}
</div>
