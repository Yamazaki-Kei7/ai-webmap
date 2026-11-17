<script lang="ts">
  import 'svelte-maplibre-gl/vite';
  import 'maplibre-gl/dist/maplibre-gl.css';
  import { untrack } from 'svelte';
  import type { Map as MaplibreMap } from 'maplibre-gl';
  import { CircleLayer, FillLayer, GeoJSONSource, LineLayer, MapLibre as MapLibreMap } from 'svelte-maplibre-gl';
  import { mapConfig } from '../../../shared/config';
  import { beforeMapLayerId, inDrawOrder } from '$lib/map/drawOrder';
  import { pickFitBounds } from '$lib/map/fit';
  import { getFeatures, mapState } from '$lib/map/mapState.svelte';

  let { map = $bindable() }: { map?: MaplibreMap } = $props();

  // Bottom to top. The map layers are added after the render, in this order; each goes below the nearest layer above it
  // that is already on the map (see `beforeMapLayerId`).
  const bottomUp = $derived(inDrawOrder(mapState.layers));

  const beforeIdOf = (index: number): string | undefined =>
    beforeMapLayerId(bottomUp, index, (id) => map?.getLayer(id) !== undefined);

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

  // Fit the map to a layer when it appears (not when the others change, and not for a layer with no feature).
  const fitted = new Set<string>();
  $effect(() => {
    if (!map) return;
    const bounds = pickFitBounds(mapState.layers, fitted);
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
  autoloadGlobalCss={false}
  onmoveend={(event) => {
    const { lng, lat } = event.target.getCenter();
    mapState.view = { center: [lng, lat], zoom: event.target.getZoom() };
  }}
>
  {#each bottomUp as layer, index (layer.id)}
    {@const features = getFeatures(layer.id)}
    {@const visibility = layer.visible ? 'visible' : 'none'}
    {#if features}
      <GeoJSONSource id={layer.id} data={features}>
        {#if layer.geometryType === 'polygon'}
          <FillLayer
            id={`${layer.id}-fill`}
            beforeId={beforeIdOf(index)}
            layout={{ visibility }}
            paint={{ 'fill-color': layer.color, 'fill-opacity': mapConfig.paint.fillOpacity }}
          />
          <LineLayer
            id={`${layer.id}-outline`}
            beforeId={beforeIdOf(index)}
            layout={{ visibility }}
            paint={{ 'line-color': layer.color, 'line-width': mapConfig.paint.outlineWidth }}
          />
        {:else if layer.geometryType === 'line'}
          <LineLayer
            id={`${layer.id}-line`}
            beforeId={beforeIdOf(index)}
            layout={{ visibility }}
            paint={{ 'line-color': layer.color, 'line-width': mapConfig.paint.lineWidth }}
          />
        {:else}
          <CircleLayer
            id={`${layer.id}-circle`}
            beforeId={beforeIdOf(index)}
            layout={{ visibility }}
            paint={{
              'circle-color': layer.color,
              'circle-radius': mapConfig.paint.circleRadius,
              'circle-opacity': mapConfig.paint.circleOpacity
            }}
          />
        {/if}
      </GeoJSONSource>
    {/if}
  {/each}
</MapLibreMap>
