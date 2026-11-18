import type { Map as MaplibreMap } from 'maplibre-gl';
import { api } from 'aws-blocks';
import type { ChatSession } from '../chat/chatSession.svelte';
import { createClientToolExecutor } from '../chat/clientTools';
import { createMapView } from '../chat/mapView';
import type { ToolExecutor } from '../chat/toolExecutor';
import { addLayer } from '../map/mapState.svelte';
import { restoreMap, toPersisted, type PersistResult, type RestoreReport } from '../map/persist.svelte';
import type { PersistedMapState } from '../../../shared/persistedMap';
import type { ClientToolResult } from '../../../shared/toolProtocol';
import { ensureViews, queryLayer, queryScalar, queryTable, type LayerQueryResult, type TableQueryResult } from './engine';
import type { QueryTimeouts } from './query';

/** Browser-check helpers; the page installs them only when `import.meta.env.DEV`. */
export type EngineDevHandle = {
  ensureViews: (ids: readonly string[]) => Promise<void>;
  /** `SELECT count(*)` of a view (registered first if needed). */
  count: (id: string) => Promise<number>;
  /** The first value of the first row of a query, as text (for the settings experiments). */
  scalar: (sql: string) => Promise<string>;
  /** `queryLayer` (the timeouts are overridable for the browser check of the cancellation). */
  queryLayer: (sql: string, overrides?: Partial<QueryTimeouts>) => Promise<ClientToolResult<LayerQueryResult>>;
  queryTable: (sql: string, maxRows: number, overrides?: Partial<QueryTimeouts>) => Promise<ClientToolResult<TableQueryResult>>;
};

/** Browser-check helpers for the saved maps: the live map as a persisted state, a restore, and the maps API. */
export type PersistDevHandle = {
  toPersisted: () => PersistResult;
  restore: (state: PersistedMapState) => Promise<RestoreReport>;
  save: (title: string, state: PersistedMapState, conversationId?: string) => Promise<{ mapId: string; updatedAt: number }>;
  get: (mapId: string) => ReturnType<typeof api.getMap>;
  remove: (mapId: string) => Promise<{ success: true }>;
  list: () => ReturnType<typeof api.listMaps>;
};

declare global {
  interface Window {
    __aiWebmapEngine?: EngineDevHandle;
    /** The MapLibre instance of the map view (browser checks of the style layers and the draw order). */
    __aiWebmapMap?: MaplibreMap;
    /** Adds layers without the dev SQL box (the browser check of layers added in one tick). */
    __aiWebmapAddLayer?: typeof addLayer;
    /** The tool executor of the chat (the six tools) on the real engine and map, for browser checks without the dev tool box. */
    __aiWebmapTool?: ToolExecutor;
    /** Save and restore of the map through the saved-maps API, without the (later) save and open UI. */
    __aiWebmapPersist?: PersistDevHandle;
    /** The chat session of the signed-in user (`openConversation`, the messages), for browser checks. */
    __aiWebmapChat?: ChatSession;
  }
}

export function installDevHandle(): void {
  window.__aiWebmapAddLayer = addLayer;
  window.__aiWebmapTool = createClientToolExecutor(() => window.__aiWebmapMap);
  window.__aiWebmapPersist = {
    toPersisted,
    restore: (state) => restoreMap(state, { queryLayer, jumpTo: (center, zoom) => createMapView(() => window.__aiWebmapMap).jumpTo(center, zoom) }),
    save: (title, state, conversationId) => api.saveMap({ title, state, ...(conversationId === undefined ? {} : { conversationId }) }),
    get: (mapId) => api.getMap(mapId),
    remove: (mapId) => api.deleteMap(mapId),
    list: () => api.listMaps()
  };
  window.__aiWebmapEngine = {
    ensureViews,
    count: async (id) => {
      await ensureViews([id]);
      return Number(await queryScalar(`SELECT count(*) FROM "${id}"`));
    },
    scalar: queryScalar,
    queryLayer,
    queryTable
  };
}

export function exposeMap(map: MaplibreMap): void {
  window.__aiWebmapMap = map;
}
