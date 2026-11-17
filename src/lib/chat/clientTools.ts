import { queryLayer, queryTable } from '../duckdb/engine';
import { fittedLayerIds } from '../map/fit';
import { addLayer, appliedOf, currentSession, getLayer, layerIds, removeLayer, replaceLayer, setLabel, setStyle } from '../map/mapState.svelte';
import { markingFitted } from './fitRegistration';
import { createMapView, type CameraMap } from './mapView';
import { createToolExecutor, type ToolExecutor } from './toolExecutor';

/**
 * The tool executor wired to the real engine, the map state and the map. `getMap` is read at every call: the map exists
 * only after the page has mounted (a call before that answers `ENGINE_UNAVAILABLE`).
 */
export function createClientToolExecutor(getMap: () => CameraMap | undefined): ToolExecutor {
  return createToolExecutor({
    queryLayer,
    queryTable,
    map: {
      addLayer: markingFitted(addLayer, fittedLayerIds),
      replaceLayer,
      setStyle,
      setLabel,
      removeLayer,
      getLayer,
      layerIds,
      appliedOf,
      currentSession
    },
    view: createMapView(getMap)
  });
}
