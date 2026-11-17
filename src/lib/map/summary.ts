import { clipDistinct, clipTexts, truncate } from '../../../shared/clip';
import { mapConfig } from '../../../shared/config';
import type { AppliedStyle, MapContext, MapContextLayer, StyleSpec } from '../../../shared/mapSpec';
import type { LayerState, MapState } from './mapState.svelte';
import { summarizeResolved } from './styleCompiler';

/*
 * What the model is told about the map (`summarizeForLlm`): the view and the layers' facts and styles, never the
 * features. Every list and text is capped (`mapConfig.summary*`), and a summary that is still over `summaryMaxBytes` is
 * shrunk step by step, so a turn never carries more than that.
 */

const bytesOf = (context: MapContext): number => new TextEncoder().encode(JSON.stringify(context)).length;

const clip = (text: string): string => clipDistinct([text], mapConfig.summaryMaxStringChars)[0];

/** The style as the model gave it, with the override values cut (and kept distinct, with the same text for the same value as in `applied`). */
function summarizeStyle(style: StyleSpec, shown: ReadonlyMap<string, string>): StyleSpec {
  if (style.type !== 'categorized' || !style.overrides) return style;
  return { ...style, overrides: Object.fromEntries(Object.entries(style.overrides).map(([value, color]) => [shown.get(value) ?? value, color])) };
}

function summarizeApplied(applied: AppliedStyle, shown: ReadonlyMap<string, string>): AppliedStyle {
  if (applied.type !== 'categorized') return applied;
  return {
    ...applied,
    categories: applied.categories.map((category) => ({ ...category, value: shown.get(category.value) ?? category.value })),
    warnings: applied.warnings.slice(0, mapConfig.summaryMaxWarnings).map((warning) => truncate(warning, mapConfig.summaryMaxWarningChars))
  };
}

function summarizeLayer(layer: LayerState): MapContextLayer {
  const resolved = summarizeResolved(layer.resolved);
  // One numbering for the values of the overrides and of the categories: the same `…#1` is the same value in both.
  const values = [
    ...(layer.style.type === 'categorized' ? Object.keys(layer.style.overrides ?? {}) : []),
    ...(resolved.type === 'categorized' ? resolved.categories.map(({ value }) => value) : [])
  ];
  const shown = clipTexts(values, mapConfig.summaryMaxStringChars);
  return {
    id: layer.id,
    name: clip(layer.name),
    geometryType: layer.geometryType,
    featureCount: layer.featureCount,
    visible: layer.visible,
    sql: truncate(layer.sql, mapConfig.summarySqlChars),
    // A column whose name is too long is left out, not cut: a cut name would not be a column.
    columns: layer.columns
      .filter(({ name }) => name.length <= mapConfig.summaryMaxColumnNameChars)
      .slice(0, mapConfig.summaryMaxColumns)
      .map(({ name, type }) => ({ name, type })),
    columnCount: layer.columns.length,
    style: summarizeStyle(layer.style, shown),
    label: layer.label,
    applied: summarizeApplied(resolved, shown)
  };
}

const isDetailed = (layer: MapContext['layers'][number]): layer is MapContextLayer => 'columns' in layer;

/** Maps the detailed layers of a context (the others stay as they are). */
const mapDetailed = (context: MapContext, change: (layer: MapContextLayer) => MapContextLayer): MapContext => ({
  ...context,
  layers: context.layers.map((layer) => (isDetailed(layer) ? change(layer) : layer))
});

/** The steps that make the summary smaller, mildest first; each is tried only while the summary is over the limit. */
const shrinkSteps: ((context: MapContext) => MapContext)[] = [
  // The hidden layers' columns first: the model is least likely to work on them.
  (context) => mapDetailed(context, (layer) => (layer.visible ? layer : { ...layer, columns: [] })),
  (context) => mapDetailed(context, (layer) => ({ ...layer, columns: [] })),
  (context) =>
    mapDetailed(context, (layer) =>
      layer.applied.type === 'categorized'
        ? { ...layer, applied: { ...layer.applied, categories: layer.applied.categories.slice(0, mapConfig.summaryShrunkCategories) } }
        : layer
    )
];

/** The last resort: layers from the end are reduced to an id and a name until it fits, and the summary says it was cut. */
function dropDetails(context: MapContext, maxBytes: number): MapContext {
  const layers = [...context.layers];
  let result: MapContext = { ...context, layers, truncated: true };
  for (let i = layers.length - 1; i >= 0 && bytesOf(result) > maxBytes; i--) {
    layers[i] = { id: layers[i].id, name: layers[i].name };
    result = { ...context, layers: [...layers], truncated: true };
  }
  return result;
}

export function buildMapContext(
  view: MapState['view'],
  layers: readonly LayerState[],
  maxBytes: number = mapConfig.summaryMaxBytes
): MapContext {
  const [lng, lat] = view.center;
  const listed = layers.slice(0, mapConfig.summaryMaxLayers).map(summarizeLayer);
  const rest = layers.slice(mapConfig.summaryMaxLayers).map(({ id, name }) => ({ id, name: clip(name) }));
  let context: MapContext = { view: { center: [lng, lat], zoom: view.zoom }, layers: [...listed, ...rest] };
  for (const step of shrinkSteps) {
    if (bytesOf(context) <= maxBytes) return context;
    context = step(context);
  }
  return bytesOf(context) <= maxBytes ? context : dropDetails(context, maxBytes);
}
