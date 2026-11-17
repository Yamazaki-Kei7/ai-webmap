<script lang="ts">
  import 'svelte-maplibre-gl/vite';
  import 'maplibre-gl/dist/maplibre-gl.css';
  import { untrack } from 'svelte';
  import type { Map as MaplibreMap } from 'maplibre-gl';
  import { GeoJSONSource, MapLibre as MapLibreMap, RawLayer } from 'svelte-maplibre-gl';
  import { mapConfig, styleConfig } from '../../../shared/config';
  import { beforeLabelLayerId, beforeMapLayerId, inDrawOrder } from '$lib/map/drawOrder';
  import { fittedLayerIds, pickFitBounds } from '$lib/map/fit';
  import { getFeatures, mapState, setView } from '$lib/map/mapState.svelte';
  import { toMapLibreLayers } from '$lib/map/styleCompiler';

  let { map = $bindable() }: { map?: MaplibreMap } = $props();

  // Bottom to top. The map layers are added after the render, in this order; the geometry of each goes below the nearest
  // layer above it that is already on the map, else below the hidden anchor; the labels go above the anchor (see `drawOrder.ts`).
  const bottomUp = $derived(inDrawOrder(mapState.layers));

  const onMap = (id: string): boolean => map?.getLayer(id) !== undefined;
  const beforeIdOf = (index: number): string => beforeMapLayerId(bottomUp, index, onMap);
  const beforeLabelIdOf = (index: number): string | undefined => beforeLabelLayerId(bottomUp, index, onMap);

  // The view is the start of the map and follows it: the map is not driven by the state afterwards.
  const startView = untrack(() => mapState.view);

  if (import.meta.env.DEV) {
    $effect(() => {
      const current = map;
      if (!current) return;
      void import('$lib/duckdb/dev').then((dev) => dev.exposeMap(current));
      return () => {
        window.__aiWebmapMap = undefined;
      };
    });
  }

  // Fit the map to a layer when it appears (not when the others change, and not for a layer with no feature). The layers
  // the tools add are fitted (or not) by the tool executor, which marks them as fitted.
  $effect(() => {
    if (!map) return;
    const bounds = pickFitBounds(mapState.layers, fittedLayerIds);
    if (bounds) {
      map.fitBounds(bounds, { padding: mapConfig.fitPaddingPx, maxZoom: mapConfig.fitMaxZoom, duration: mapConfig.fitDurationMs });
    }
  });
</script>

<MapLibreMap
  bind:map
  class="h-full w-full"
  style={mapConfig.basemapStyleUrl}
  center={startView.center}
  zoom={startView.zoom}
  minZoom={styleConfig.zoom.min}
  autoloadGlobalCss={false}
  localIdeographFontFamily={mapConfig.localIdeographFontFamily}
  onmoveend={(event) => {
    setView(event.target.getCenter().wrap(), event.target.getZoom());
  }}
>
  <!-- The anchor comes first, so that it is on the map before any layer that is placed below it: geometry below it, labels above it, whenever they were added. -->
  <RawLayer id={mapConfig.labelAnchorLayerId} type="background" layout={{ visibility: 'none' }} />
  <!-- The map layers sit inside their layer's source, so they are removed before it. Their order is set by `beforeId`: geometry below every label. -->
  {#each bottomUp as layer, index (layer.id)}
    {@const features = getFeatures(layer.id)}
    {#if features}
      <GeoJSONSource id={layer.id} data={features}>
        {#each toMapLibreLayers(layer) as spec (spec.id)}
          <RawLayer {...spec} beforeId={spec.type === 'symbol' ? beforeLabelIdOf(index) : beforeIdOf(index)} />
        {/each}
      </GeoJSONSource>
    {/if}
  {/each}
</MapLibreMap>
