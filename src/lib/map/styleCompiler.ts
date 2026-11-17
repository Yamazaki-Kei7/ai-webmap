import type {
  CircleLayerSpecification,
  ExpressionSpecification,
  FillLayerSpecification,
  LineLayerSpecification,
  SymbolLayerSpecification
} from 'maplibre-gl';
import { dataConfig, mapConfig, styleConfig } from '../../../shared/config';
import type { AppliedStyle, GeometryFamily, HexColor, LabelSpec, StyleSpec } from '../../../shared/mapSpec';
import { toolError, type ClientToolResult } from '../../../shared/toolProtocol';
import type { ColumnInfo, GeoJsonFeature, GeoJsonFeatureCollection } from '../duckdb/queryTypes';
import { computeBreaks } from './classify';
import { mapLayerIds } from './drawOrder';
import { qualitativeColors, sequentialColors } from './palettes';

/**
 * The style values every symbol type shares, with the defaults filled in. `size` is the point radius or the line width
 * in pixels, by the layer's geometry; a polygon ignores it (its outline is `strokeWidth`).
 */
export type ResolvedCommon = { opacity: number; strokeColor: HexColor; strokeWidth: number; size: number };

export type ResolvedCategory = { value: string; color: HexColor; count: number };

/**
 * A style resolved against the loaded features: plain data for the layer compiler and the legend. For `graduated`,
 * `colors.length === breaks.length + 1`, and class k holds the values from `breaks[k - 1]` (inclusive) up to
 * `breaks[k]` (exclusive). `nullCount` is the number of features without a usable value in the column; those features
 * are drawn in `nullColor`, a colour the legend shows too.
 */
export type ResolvedStyle =
  | { type: 'single'; color: HexColor; common: ResolvedCommon }
  | {
      type: 'categorized';
      column: string;
      /** The coloured categories, the most frequent first (ties by value). */
      items: ResolvedCategory[];
      /** The categories that did not get a colour of their own, folded together. */
      other: { color: HexColor; count: number } | null;
      nullCount: number;
      nullColor: HexColor;
      /** What the model should be told about, e.g. an override for a value that does not occur. */
      warnings: string[];
      common: ResolvedCommon;
    }
  | {
      type: 'graduated';
      column: string;
      breaks: number[];
      colors: HexColor[];
      min: number;
      max: number;
      nullCount: number;
      nullColor: HexColor;
      common: ResolvedCommon;
    }
  | {
      type: 'proportional';
      column: string;
      color: HexColor;
      min: number;
      max: number;
      /** Radii in pixels; the symbol's radius follows the square root of the value (Task 3.3). */
      minRadius: number;
      maxRadius: number;
      common: ResolvedCommon;
    };

const { defaults } = styleConfig;

function resolveCommon(style: StyleSpec, geometryType: GeometryFamily): ResolvedCommon {
  return {
    opacity: style.opacity ?? defaults.opacity[geometryType],
    strokeColor: style.strokeColor ?? defaults.strokeColor,
    strokeWidth: style.strokeWidth ?? defaults.strokeWidth,
    size: style.size ?? (geometryType === 'line' ? defaults.size.line : defaults.size.point)
  };
}

const noFeatures = () => toolError('INVALID_STYLE', 'The layer has no features.');

function unknownColumn(column: string, available: Iterable<string>): ClientToolResult<never> {
  const listed = [...new Set(available)].slice(0, styleConfig.maxHintColumns);
  return toolError('UNKNOWN_COLUMN', `The layer has no column "${column}".`, `Columns: ${listed.join(', ')}.`);
}

/** A label can only name a column the layer has. */
export function checkLabel(label: LabelSpec, columns: readonly ColumnInfo[]): ClientToolResult<LabelSpec> {
  if (columns.some(({ name }) => name === label.column)) return { ok: true, data: label };
  return unknownColumn(
    label.column,
    columns.map(({ name }) => name)
  );
}

/** The finite numbers in a column; the rest (NULL, text, ...) counts as `nullCount`. */
function numericValues(features: readonly GeoJsonFeature[], column: string): { values: number[]; nullCount: number } {
  const values: number[] = [];
  for (const { properties } of features) {
    const value = properties[column];
    if (typeof value === 'number' && Number.isFinite(value)) values.push(value);
  }
  return { values, nullCount: features.length - values.length };
}

function minMax(values: readonly number[]): { min: number; max: number } {
  return values.reduce((range, v) => ({ min: Math.min(range.min, v), max: Math.max(range.max, v) }), {
    min: Number.POSITIVE_INFINITY,
    max: Number.NEGATIVE_INFINITY
  });
}

function resolveCategorized(
  style: Extract<StyleSpec, { type: 'categorized' }>,
  features: readonly GeoJsonFeature[],
  common: ResolvedCommon
): ResolvedStyle {
  const counts = new Map<string, number>();
  let nullCount = 0;
  for (const { properties } of features) {
    const value = properties[style.column];
    if (value === null || value === undefined) nullCount++;
    else counts.set(String(value), (counts.get(String(value)) ?? 0) + 1);
  }

  const palette = qualitativeColors(style.palette ?? defaults.categorizedPalette);
  const overrides = style.overrides ?? {};
  const { maxCategories } = dataConfig.classification;
  const hasOverride = (value: string) => Object.hasOwn(overrides, value);
  const byCount = [...counts].sort(([a, countA], [b, countB]) => countB - countA || (a < b ? -1 : a > b ? 1 : 0));
  // A value with an override keeps its colour, however rare it is; it takes no palette colour, the others share the rest.
  const overridden = byCount.filter(([value]) => hasOverride(value)).slice(0, maxCategories);
  const plain = byCount
    .filter(([value]) => !hasOverride(value))
    .slice(0, Math.min(palette.length, maxCategories - overridden.length));
  const kept = new Set([...overridden, ...plain].map(([value]) => value));

  let nextColor = 0;
  const items: ResolvedCategory[] = byCount
    .filter(([value]) => kept.has(value))
    .map(([value, count]) => ({ value, count, color: hasOverride(value) ? overrides[value] : palette[nextColor++] }));
  const folded = byCount.filter(([value]) => !kept.has(value));
  const other = folded.length === 0 ? null : { color: styleConfig.otherColor, count: folded.reduce((sum, [, n]) => sum + n, 0) };

  const withoutOverrides = new Set(byCount.slice(0, Math.min(palette.length, maxCategories)).map(([value]) => value));
  const warnings = [
    ...Object.keys(overrides)
      .filter((value) => !counts.has(value))
      .map((value) => `Override for "${value}" ignored: no feature has that value in "${style.column}".`),
    // Cannot happen for a spec that passed the schema (at most maxCategories overrides); this defends against one that did not.
    ...folded
      .filter(([value]) => hasOverride(value))
      .map(([value]) => `Override for "${value}" ignored: at most ${maxCategories} categories get a colour.`),
    ...folded
      .filter(([value]) => !hasOverride(value) && withoutOverrides.has(value))
      .map(([value]) => `"${value}" is shown as "other": the overrides took its colour.`)
  ];

  return { type: 'categorized', column: style.column, items, other, nullCount, nullColor: styleConfig.noDataColor, warnings, common };
}

/**
 * Resolves what the model asked for against the loaded features: the defaults are filled in, the class breaks are
 * computed, the palette colours are picked. A column that is missing, a style the geometry or the data cannot take,
 * and an empty layer are errors the model can read.
 */
export function resolveStyle(
  style: StyleSpec,
  geometryType: GeometryFamily,
  features: GeoJsonFeatureCollection
): ClientToolResult<ResolvedStyle> {
  const common = resolveCommon(style, geometryType);
  if (style.type === 'single') return { ok: true, data: { type: 'single', color: style.color, common } };

  if (style.type === 'proportional' && geometryType !== 'point') {
    return toolError('INVALID_STYLE', 'Proportional symbols are for point layers; use graduated colours for lines and polygons.');
  }
  const list = features.features;
  if (list.length === 0) return noFeatures();
  if (!list.some(({ properties }) => Object.hasOwn(properties, style.column))) return unknownColumn(style.column, list.flatMap(({ properties }) => Object.keys(properties)));

  if (style.type === 'categorized') return { ok: true, data: resolveCategorized(style, list, common) };

  const { values, nullCount } = numericValues(list, style.column);
  if (values.length === 0) {
    return toolError('INVALID_STYLE', `Column "${style.column}" has no numbers; ${style.type} styles need a numeric column.`);
  }
  const { min, max } = minMax(values);

  if (style.type === 'proportional') {
    const minRadius = style.minRadius ?? defaults.minRadius;
    const maxRadius = style.maxRadius ?? defaults.maxRadius;
    if (minRadius >= maxRadius) {
      return toolError('INVALID_STYLE', `minRadius (${minRadius}) must be smaller than maxRadius (${maxRadius}).`);
    }
    return { ok: true, data: { type: 'proportional', column: style.column, color: style.color, min, max, minRadius, maxRadius, common } };
  }

  const breaks =
    style.method === 'manual'
      ? [...(style.breaks ?? [])]
      : computeBreaks(values, style.method, style.classes ?? dataConfig.classification.defaultClasses);
  const colors = sequentialColors(style.palette ?? defaults.graduatedPalette, breaks.length + 1, style.reverse);
  return { ok: true, data: { type: 'graduated', column: style.column, breaks, colors, min, max, nullCount, nullColor: styleConfig.noDataColor, common } };
}

export type MapLibreLayerSpec =
  | FillLayerSpecification
  | LineLayerSpecification
  | CircleLayerSpecification
  | SymbolLayerSpecification;

/** What the map layers need of a layer: the resolved style and label, and whether it shows. */
export type StyledLayer = {
  id: string;
  geometryType: GeometryFamily;
  visible: boolean;
  label: LabelSpec | null;
  resolved: ResolvedStyle;
};

const property = (column: string): ExpressionSpecification => ['get', column];

const isNumber = (column: string): ExpressionSpecification => ['==', ['typeof', property(column)], 'number'];

/** The colour of each feature: a constant, or an expression of the styled column (NULL and non-numbers in the no-data colour). */
function colorExpression(resolved: ResolvedStyle): HexColor | ExpressionSpecification {
  if (resolved.type === 'single') return resolved.color;
  // Features without a number (NULL, text) are not part of the scale: the no-data colour, and a small fixed radius.
  if (resolved.type === 'proportional') return ['case', isNumber(resolved.column), resolved.color, styleConfig.noDataColor];
  if (resolved.type === 'categorized') {
    const fallback = resolved.other?.color ?? resolved.items[0]?.color ?? resolved.nullColor;
    const [first, ...rest] = resolved.items;
    // `match` needs at least one label.
    if (!first) return fallback;
    const match: ExpressionSpecification = [
      'match',
      ['to-string', property(resolved.column)],
      first.value,
      first.color,
      ...rest.flatMap((item) => [item.value, item.color]),
      fallback
    ];
    return ['case', ['==', property(resolved.column), null], resolved.nullColor, match];
  }
  const [firstColor, ...restColors] = resolved.colors;
  // One distinct value gives no break: a `step` needs at least one stop, so the one colour stands alone.
  const step: HexColor | ExpressionSpecification =
    restColors.length === 0
      ? firstColor
      : ['step', ['to-number', property(resolved.column)], firstColor, ...restColors.flatMap((color, k) => [resolved.breaks[k], color])];
  return ['case', isNumber(resolved.column), step, resolved.nullColor];
}

/** The symbol radius: the area follows the value, so the radius follows its square root (between `minRadius` and `maxRadius`). */
function radiusExpression(resolved: ResolvedStyle): number | ExpressionSpecification {
  if (resolved.type !== 'proportional') return resolved.common.size;
  const { column, min, max, minRadius, maxRadius } = resolved;
  const root = (n: number) => Math.sqrt(Math.max(n, 0));
  // A single value (or none above zero) has no range to interpolate over.
  const sized: number | ExpressionSpecification =
    root(min) === root(max)
      ? (minRadius + maxRadius) / 2
      : [
          'interpolate',
          ['linear'],
          ['sqrt', ['max', ['to-number', property(column)], 0]],
          root(min),
          minRadius,
          root(max),
          maxRadius
        ];
  return ['case', isNumber(column), sized, styleConfig.noDataRadius];
}

function labelLayer(layer: StyledLayer, label: LabelSpec): SymbolLayerSpecification {
  const ids = mapLayerIds(layer.id);
  const defaults = styleConfig.labelDefaults;
  const placement: Record<GeometryFamily, SymbolLayerSpecification['layout']> = {
    point: { 'text-anchor': 'top', 'text-offset': [0, mapConfig.label.pointOffsetEm] },
    line: { 'symbol-placement': 'line' },
    polygon: {}
  };
  return {
    id: ids.label,
    type: 'symbol',
    source: ids.source,
    minzoom: label.minZoom ?? defaults.minZoom,
    layout: {
      ...placement[layer.geometryType],
      visibility: layer.visible ? 'visible' : 'none',
      'text-field': ['to-string', property(label.column)],
      'text-font': [...mapConfig.label.fontStack],
      'text-size': label.size ?? defaults.size
    },
    paint: {
      'text-color': label.color ?? defaults.color,
      'text-halo-color': label.haloColor ?? defaults.haloColor,
      'text-halo-width': label.haloWidth ?? defaults.haloWidth
    }
  };
}

/**
 * The MapLibre layers of a styled layer, bottom to top: the geometry (a polygon's fill, then its outline; a line; a
 * circle), then the label when there is one. Plain data: the map view hands each one to the map.
 */
export function toMapLibreLayers(layer: StyledLayer): MapLibreLayerSpec[] {
  const ids = mapLayerIds(layer.id);
  const { resolved } = layer;
  const { common } = resolved;
  const layout = { visibility: layer.visible ? ('visible' as const) : ('none' as const) };
  const color = colorExpression(resolved);

  const geometry: Record<GeometryFamily, MapLibreLayerSpec[]> = {
    polygon: [
      { id: ids.fill, type: 'fill', source: ids.source, layout, paint: { 'fill-color': color, 'fill-opacity': common.opacity } },
      {
        id: ids.outline,
        type: 'line',
        source: ids.source,
        layout,
        paint: { 'line-color': common.strokeColor, 'line-width': common.strokeWidth }
      }
    ],
    line: [
      {
        id: ids.line,
        type: 'line',
        source: ids.source,
        layout,
        paint: { 'line-color': color, 'line-width': common.size, 'line-opacity': common.opacity }
      }
    ],
    point: [
      {
        id: ids.circle,
        type: 'circle',
        source: ids.source,
        layout,
        paint: {
          'circle-color': color,
          'circle-radius': radiusExpression(resolved),
          'circle-opacity': common.opacity,
          'circle-stroke-color': common.strokeColor,
          'circle-stroke-width': common.strokeWidth
        }
      }
    ]
  };
  return layer.label ? [...geometry[layer.geometryType], labelLayer(layer, layer.label)] : geometry[layer.geometryType];
}

/** The short account of a resolved style that the model is told: the breaks and colours, the categories, the range. */
export function summarizeResolved(resolved: ResolvedStyle): AppliedStyle {
  switch (resolved.type) {
    case 'single':
      return { type: 'single', color: resolved.color };
    case 'categorized':
      return {
        type: 'categorized',
        column: resolved.column,
        categories: resolved.items.map(({ value, color, count }) => ({ value, color, count })),
        categoryCount: resolved.items.length,
        other: resolved.other,
        nullCount: resolved.nullCount,
        warnings: resolved.warnings
      };
    case 'graduated':
      return {
        type: 'graduated',
        column: resolved.column,
        breaks: resolved.breaks,
        colors: resolved.colors,
        min: resolved.min,
        max: resolved.max,
        nullCount: resolved.nullCount
      };
    case 'proportional':
      return {
        type: 'proportional',
        column: resolved.column,
        color: resolved.color,
        min: resolved.min,
        max: resolved.max,
        minRadius: resolved.minRadius,
        maxRadius: resolved.maxRadius
      };
  }
}
