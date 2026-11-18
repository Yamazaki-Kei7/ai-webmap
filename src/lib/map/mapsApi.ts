import { api } from 'aws-blocks';
import type { MapsApi } from './savedMapFlow.svelte';

/** The saved-maps methods of the typed client, as the flow uses them. */
export const mapsApi: MapsApi = {
  saveMap: (input) => api.saveMap(input),
  listMaps: () => api.listMaps(),
  getMap: (mapId) => api.getMap(mapId),
  deleteMap: (mapId) => api.deleteMap(mapId)
};
