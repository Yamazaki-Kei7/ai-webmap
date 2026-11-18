<script lang="ts">
  import type { Map as MaplibreMap } from 'maplibre-gl';
  import { devPanelConfig } from '../../../shared/config';
  import DevSqlBox from './DevSqlBox.svelte';
  import DevStyleBox from './DevStyleBox.svelte';
  import DevToolBox from './DevToolBox.svelte';

  /** The development boxes in one section of the left panel, closed until opened (dev builds only: the shell leaves it out of the build). */
  let { ready, map }: { ready: boolean; map?: MaplibreMap } = $props();
</script>

<details class="rounded border border-bb-border" data-testid="dev-panel">
  <summary class="cursor-pointer px-2 py-1 text-xs text-bb-muted">{devPanelConfig.title}</summary>
  <div class="flex flex-col gap-3 border-t border-bb-border p-2">
    <DevSqlBox {ready} />
    <DevStyleBox />
    <DevToolBox {ready} {map} />
  </div>
</details>
