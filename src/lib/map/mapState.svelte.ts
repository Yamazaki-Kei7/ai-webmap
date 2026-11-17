import { SvelteMap } from 'svelte/reactivity';
import { mapConfig, styleConfig } from '../../../shared/config';
import type { AppliedStyle, GeometryFamily, LabelSpec, MapContext, StyleSpec } from '../../../shared/mapSpec';
import { datasetIds } from '../../../shared/datasets';
import { validateSql } from '../../../shared/sqlGuard';
import { toolError, type ClientToolResult } from '../../../shared/toolProtocol';
import type { Bbox, ColumnInfo, GeoJsonFeatureCollection, LayerQueryResult } from '../duckdb/queryTypes';
import { checkLabel, resolveCommon, resolveStyle, type ResolvedStyle } from './styleCompiler';
import { buildMapContext, summarizeLayerApplied } from './summary';

/** What a layer is made of: the name and the query, and optionally how to draw it (else a single colour, no label). */
export type NewLayer = { name: string; sql: string; style?: StyleSpec; label?: LabelSpec | null };

export type LayerState = {
  /** 'L1', 'L2', …: short ids the LLM can refer to; never reused within a page session. */
  id: string;
  name: string;
  /** The guarded SQL that produced it. */
  sql: string;
  /** The datasets the SQL reads (each once): where the data attribution comes from. */
  datasetIds: string[];
  geometryType: GeometryFamily;
  columns: ColumnInfo[];
  featureCount: number;
  bbox: Bbox;
  visible: boolean;
  /** As given, or the default single colour. */
  style: StyleSpec;
  label: LabelSpec | null;
  /** The style resolved against the features; the map and the legend both draw from it. */
  resolved: ResolvedStyle;
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
// The map reads them from a reactive map (shallow, no proxy of the values), so replacing a layer's data reaches it.
// Counts the resets: a result that was asked for before a reset belongs to a previous user and is dropped by its caller.
let session = 0;

const featuresByLayer = new SvelteMap<string, GeoJsonFeatureCollection>();

/** The datasets a query reads; the SQL has been guarded already, so this is a lookup (a text that does not pass reads none). */
function datasetsOf(sql: string): string[] {
  const guarded = validateSql(sql, datasetIds);
  return guarded.ok ? guarded.tables : [];
}

const layerSeq = (layerId: string): number => Number(layerId.slice(1));

/** The single colour a layer gets when nothing else is asked for: the default colours, cycled by the layer's number. */
function defaultStyle(seq: number): StyleSpec {
  const colors = mapConfig.defaultLayerColors;
  return { type: 'single', color: colors[(seq - 1) % colors.length] };
}

const unknownLayer = (layerId: string) =>
  toolError('UNKNOWN_LAYER', `There is no layer "${layerId}".`, `Layers: ${mapState.layers.map((l) => l.id).join(', ') || 'none'}.`);

type PickedStyle = { style: StyleSpec; resolved: ResolvedStyle };

/** The given style if there is one (an error when it fails); else `fallback` while it resolves against `data`, else the default single. */
function pickStyle(given: StyleSpec | undefined, fallback: StyleSpec, seq: number, data: LayerQueryResult): ClientToolResult<PickedStyle> {
  const resolve = (style: StyleSpec): ClientToolResult<PickedStyle> => {
    const resolved = resolveStyle(style, data.geometryType, data.features);
    return resolved.ok ? { ok: true, data: { style, resolved: resolved.data } } : resolved;
  };
  if (given) return resolve(given);
  const kept = resolve(fallback);
  return kept.ok ? kept : resolve(defaultStyle(seq));
}

/** The given label if there is one (null clears it; an error when its column is missing); else `fallback` while its column exists, else none. */
function pickLabel(given: LabelSpec | null | undefined, fallback: LabelSpec | null, columns: readonly ColumnInfo[]): ClientToolResult<LabelSpec | null> {
  if (given === null) return { ok: true, data: null };
  if (given) return checkLabel(given, columns);
  return { ok: true, data: fallback && checkLabel(fallback, columns).ok ? fallback : null };
}

/** A layer from a query result under the given id, not yet on the map; an error when the style or the label does not fit the data. */
function buildLayer(id: string, input: NewLayer, data: LayerQueryResult): ClientToolResult<LayerState> {
  const seq = layerSeq(id);
  const picked = pickStyle(input.style, defaultStyle(seq), seq, data);
  if (!picked.ok) return picked;
  const label = pickLabel(input.label, null, data.columns);
  if (!label.ok) return label;
  return {
    ok: true,
    data: {
      id,
      name: input.name,
      sql: input.sql,
      datasetIds: datasetsOf(input.sql),
      geometryType: data.geometryType,
      columns: data.columns,
      featureCount: data.featureCount,
      bbox: data.bbox,
      visible: true,
      style: picked.data.style,
      label: label.data,
      resolved: picked.data.resolved,
      status: 'ready'
    }
  };
}

/** Puts a built layer on the map, with its features; hands back the layer as the state holds it (proxied, so that a later change to it shows). */
function pushLayer(layer: LayerState, features?: GeoJsonFeatureCollection): LayerState {
  if (features) featuresByLayer.set(layer.id, features);
  mapState.layers.push(layer);
  return mapState.layers[mapState.layers.length - 1];
}

export function addLayer(input: NewLayer, data: LayerQueryResult): ClientToolResult<LayerState> {
  const seq = mapState.nextLayerSeq;
  const built = buildLayer(`L${seq}`, input, data);
  if (!built.ok) return built;
  mapState.nextLayerSeq = seq + 1;
  return { ok: true, data: pushLayer(built.data, data.features) };
}

/** A layer of a saved map: as it was saved (id, name, SQL, style, label, whether it shows). */
export type RestoredLayer = { id: string; name: string; sql: string; style: StyleSpec; label: LabelSpec | null; visible: boolean };

/** Adds a layer of a saved map under its saved id, from the result of its SQL; an error (nothing added) when the saved style or label no longer fits the data. */
export function restoreLayer(saved: RestoredLayer, data: LayerQueryResult): ClientToolResult<LayerState> {
  const built = buildLayer(saved.id, saved, data);
  if (!built.ok) return built;
  return { ok: true, data: pushLayer({ ...built.data, visible: saved.visible }, data.features) };
}

/** Adds a layer of a saved map that could not be rebuilt: it has no features and draws nothing, and its card shows `message`. */
export function addErrorLayer(saved: RestoredLayer, message: string): LayerState {
  const geometryType = mapConfig.errorLayerGeometry;
  const placeholder: StyleSpec = { type: 'single', color: styleConfig.noDataColor };
  return pushLayer({
    id: saved.id,
    name: saved.name,
    sql: saved.sql,
    // Nothing is drawn from it, so there is nothing to attribute.
    datasetIds: [],
    geometryType,
    columns: [],
    featureCount: 0,
    bbox: [0, 0, 0, 0],
    visible: saved.visible,
    style: saved.style,
    label: saved.label,
    resolved: { type: 'single', color: styleConfig.noDataColor, common: resolveCommon(placeholder, geometryType) },
    status: 'error',
    errorMessage: message
  });
}

/** Sets the number the next layer gets (a restore): never lower than the layers it holds, or the ids it is about to restore (`reserved`), need. */
export function setNextLayerSeq(seq: number, reserved: readonly string[] = []): void {
  mapState.nextLayerSeq = Math.max(seq, ...[...mapState.layers.map((layer) => layer.id), ...reserved].map((id) => layerSeq(id) + 1));
}

/**
 * Gives a layer new data (and name, query), keeping its id, its place in the draw order and whether it shows. The style
 * is the given one, else the old one if it still resolves against the new data, else the default single colour; the
 * label likewise (the old one only while its column exists). A given style or label that fails changes nothing.
 */
export function replaceLayer(layerId: string, input: NewLayer, data: LayerQueryResult): ClientToolResult<LayerState> {
  const layer = mapState.layers.find((l) => l.id === layerId);
  if (!layer) return unknownLayer(layerId);
  const picked = pickStyle(input.style, $state.snapshot(layer.style), layerSeq(layerId), data);
  if (!picked.ok) return picked;
  const label = pickLabel(input.label, $state.snapshot(layer.label), data.columns);
  if (!label.ok) return label;

  featuresByLayer.set(layerId, data.features);
  layer.name = input.name;
  layer.sql = input.sql;
  layer.datasetIds = datasetsOf(input.sql);
  layer.geometryType = data.geometryType;
  layer.columns = data.columns;
  layer.featureCount = data.featureCount;
  layer.bbox = data.bbox;
  layer.style = picked.data.style;
  layer.label = label.data;
  layer.resolved = picked.data.resolved;
  // A layer that failed to load is ready now.
  layer.status = 'ready';
  layer.errorMessage = undefined;
  return { ok: true, data: layer };
}

/** Restyles a layer against the features it already holds (no data is sent to the map again). An error changes nothing. */
export function setStyle(layerId: string, style: StyleSpec): ClientToolResult<LayerState> {
  const layer = mapState.layers.find((l) => l.id === layerId);
  const features = featuresByLayer.get(layerId);
  if (!layer) return unknownLayer(layerId);
  if (!features) return toolError('INVALID_STYLE', `Layer "${layerId}" failed to load, so it has no data to style.`, 'Replace it with addLayer (replaceLayerId) first.');
  const resolved = resolveStyle(style, layer.geometryType, features);
  if (!resolved.ok) return resolved;
  layer.style = style;
  layer.resolved = resolved.data;
  return { ok: true, data: layer };
}

/** Sets or (with null) clears a layer's label; the column has to be one of the layer's. An error changes nothing. */
export function setLabel(layerId: string, label: LabelSpec | null): ClientToolResult<LayerState> {
  const layer = mapState.layers.find((l) => l.id === layerId);
  if (!layer) return unknownLayer(layerId);
  const picked = pickLabel(label, null, layer.columns);
  if (!picked.ok) return picked;
  layer.label = picked.data;
  return { ok: true, data: layer };
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

/** What the model is told about the map (see `summary.ts`): never the features, and within `mapConfig.summaryMaxBytes`. */
export function summarizeForLlm(): MapContext {
  return buildMapContext(mapState.view, $state.snapshot(mapState.layers));
}

/** A copy of a layer's state (plain data, no proxy), or undefined for an id that is not on the map. */
export function getLayer(layerId: string): LayerState | undefined {
  const layer = mapState.layers.find((l) => l.id === layerId);
  return layer && $state.snapshot(layer);
}

/** The ids of the layers, in the order of the layer list. */
export function layerIds(): string[] {
  return mapState.layers.map((layer) => layer.id);
}

/** What `<map_state>` says the layer's style came out as (`applied`); the tool answers use it, so the model reads one numbering in both. */
export function appliedOf(layerId: string): AppliedStyle | undefined {
  const layer = getLayer(layerId);
  return layer && summarizeLayerApplied(layer);
}

/** The view the map has moved to; the caller passes the centre wrapped into -180..180 (a map panned across the date line reports more). */
export function setView(center: { lng: number; lat: number }, zoom: number): void {
  mapState.view = { center: [center.lng, center.lat], zoom };
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
