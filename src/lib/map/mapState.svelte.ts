import { mapConfig } from '../../../shared/config';
import type { GeometryFamily } from '../../../shared/mapSpec';
import type { Bbox, ColumnInfo, GeoJsonFeatureCollection, LayerQueryResult } from '../duckdb/queryTypes';

export type LayerState = {
  /** 'L1', 'L2', …: short ids the LLM can refer to; never reused within a page session. */
  id: string;
  name: string;
  /** The guarded SQL that produced it. */
  sql: string;
  geometryType: GeometryFamily;
  columns: ColumnInfo[];
  featureCount: number;
  bbox: Bbox;
  visible: boolean;
  /** Provisional single colour until Phase 3 replaces it with style / label / resolved. */
  color: string;
  status: 'ready' | 'loading' | 'error';
  errorMessage?: string;
};

export type MapState = {
  view: { center: [number, number]; zoom: number };
  layers: LayerState[];
  nextLayerSeq: number;
};

const [initialLng, initialLat] = mapConfig.initialView.center;

const initialView = (): MapState['view'] => ({ center: [initialLng, initialLat], zoom: mapConfig.initialView.zoom });

export const mapState: MapState = $state({
  view: initialView(),
  layers: [],
  nextLayerSeq: 1
});

// The features stay out of the deep-reactive state: a layer can hold tens of thousands of them, and a proxy of that is waste.
// Counts the resets: a result that was asked for before a reset belongs to a previous user and is dropped by its caller.
let session = 0;

const featuresByLayer = new Map<string, GeoJsonFeatureCollection>();

export function addLayer(input: { name: string; sql: string }, data: LayerQueryResult): LayerState {
  const seq = mapState.nextLayerSeq;
  mapState.nextLayerSeq = seq + 1;
  const colors = mapConfig.defaultLayerColors;
  const layer: LayerState = {
    id: `L${seq}`,
    name: input.name,
    sql: input.sql,
    geometryType: data.geometryType,
    columns: data.columns,
    featureCount: data.featureCount,
    bbox: data.bbox,
    visible: true,
    color: colors[(seq - 1) % colors.length],
    status: 'ready'
  };
  featuresByLayer.set(layer.id, data.features);
  mapState.layers.push(layer);
  // The pushed object is proxied; hand back that one, so a later change to it shows in the state.
  return mapState.layers[mapState.layers.length - 1];
}

export function removeLayer(layerId: string): boolean {
  const index = mapState.layers.findIndex((layer) => layer.id === layerId);
  if (index < 0) return false;
  mapState.layers.splice(index, 1);
  featuresByLayer.delete(layerId);
  return true;
}

export function setVisible(layerId: string, visible: boolean): void {
  const layer = mapState.layers.find((l) => l.id === layerId);
  if (layer) layer.visible = visible;
}

export function getFeatures(layerId: string): GeoJsonFeatureCollection | undefined {
  return featuresByLayer.get(layerId);
}

/** The number of the current session (user): it changes at every reset. */
export function currentSession(): number {
  return session;
}

/** Sign-out or another user: no layers and the starting view. Ids go on counting, so none is reused within the page session. */
export function resetMapState(): void {
  mapState.layers.length = 0;
  featuresByLayer.clear();
  session += 1;
  mapState.view = initialView();
}
