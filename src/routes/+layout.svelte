<script lang="ts">
  import '../app.css';
  import { injectTheme } from '@aws-blocks/blocks/ui';

  let { children } = $props();

  injectTheme();
</script>

{@render children()}
