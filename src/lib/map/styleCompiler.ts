import { dataConfig, styleConfig } from '../../../shared/config';
import type { GeometryFamily, HexColor, StyleSpec } from '../../../shared/mapSpec';
import { toolError, type ClientToolResult } from '../../../shared/toolProtocol';
import type { GeoJsonFeature, GeoJsonFeatureCollection } from '../duckdb/queryTypes';
import { computeBreaks } from './classify';
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
    opacity: style.opacity ?? defaults.opacity,
    strokeColor: style.strokeColor ?? defaults.strokeColor,
    strokeWidth: style.strokeWidth ?? defaults.strokeWidth,
    size: style.size ?? (geometryType === 'line' ? defaults.size.line : defaults.size.point)
  };
}

const noFeatures = () => toolError('INVALID_STYLE', 'The layer has no features.');

function unknownColumn(column: string, features: readonly GeoJsonFeature[]): ClientToolResult<never> {
  const available = new Set(features.flatMap(({ properties }) => Object.keys(properties)));
  const listed = [...available].slice(0, styleConfig.maxHintColumns);
  return toolError('UNKNOWN_COLUMN', `The layer has no column "${column}".`, `Columns: ${listed.join(', ')}.`);
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
  if (!list.some(({ properties }) => Object.hasOwn(properties, style.column))) return unknownColumn(style.column, list);

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
