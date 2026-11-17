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

const ellipsis = '…';

const truncate = (text: string, maxChars: number): string => (text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}${ellipsis}`);

/**
 * Cuts each text to `maxChars` characters, ending in "…", and keeps the results apart: a cut text that would come out
 * like another text gets `#n` before the end, so two values are never merged into one.
 */
export function clipDistinct(texts: readonly string[], maxChars: number): string[] {
  const cut = texts.map((text) => truncate(text, maxChars));
  const occurrences = new Map<string, number>();
  for (const shown of cut) occurrences.set(shown, (occurrences.get(shown) ?? 0) + 1);
  const taken = new Set(texts.filter((text) => text.length <= maxChars));
  const numbered = new Map<string, number>();
  return texts.map((text, i) => {
    if (text.length <= maxChars) return text;
    if (occurrences.get(cut[i]) === 1 && !taken.has(cut[i])) return cut[i];
    let n = numbered.get(cut[i]) ?? 0;
    let unique: string;
    do {
      n++;
      const suffix = `#${n}`;
      unique = `${text.slice(0, maxChars - 1 - suffix.length)}${ellipsis}${suffix}`;
    } while (taken.has(unique));
    numbered.set(cut[i], n);
    taken.add(unique);
    return unique;
  });
}

const clip = (text: string): string => clipDistinct([text], mapConfig.summaryMaxStringChars)[0];

/** The style as the model gave it, with the override values cut (and kept distinct). */
function summarizeStyle(style: StyleSpec): StyleSpec {
  if (style.type !== 'categorized' || !style.overrides) return style;
  const entries = Object.entries(style.overrides);
  const shown = clipDistinct(entries.map(([value]) => value), mapConfig.summaryMaxStringChars);
  return { ...style, overrides: Object.fromEntries(entries.map(([, color], i) => [shown[i], color])) };
}

function summarizeApplied(applied: AppliedStyle): AppliedStyle {
  if (applied.type !== 'categorized') return applied;
  const shown = clipDistinct(applied.categories.map(({ value }) => value), mapConfig.summaryMaxStringChars);
  return {
    ...applied,
    categories: applied.categories.map((category, i) => ({ ...category, value: shown[i] })),
    warnings: applied.warnings.slice(0, mapConfig.summaryMaxWarnings).map((warning) => truncate(warning, mapConfig.summaryMaxWarningChars))
  };
}

function summarizeLayer(layer: LayerState): MapContextLayer {
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
    style: summarizeStyle(layer.style),
    label: layer.label,
    applied: summarizeApplied(summarizeResolved(layer.resolved))
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
