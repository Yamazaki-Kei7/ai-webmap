import { legendConfig, styleConfig } from '../../../shared/config';
import type { GeometryFamily, HexColor } from '../../../shared/mapSpec';
import type { LayerState } from './mapState.svelte';

export type LegendModel =
  | { type: 'single'; color: HexColor; geometryType: GeometryFamily }
  | {
      type: 'categorized';
      column: string;
      geometryType: GeometryFamily;
      items: { label: string; color: HexColor; count: number }[];
    }
  | {
      type: 'graduated';
      column: string;
      geometryType: GeometryFamily;
      /** Class k covers `[min, max)` (the last one `[min, ∞)`); `empty` when the data does not reach it (manual breaks outside the data). */
      items: { min: number; max: number; color: HexColor; empty: boolean }[];
      /** The features without a number in the column (drawn in `color`); null when there are none. */
      noData: { color: HexColor; count: number } | null;
    }
  | {
      type: 'proportional';
      column: string;
      color: HexColor;
      /** The smallest, the middle and the largest value, with the radius (pixels) the map draws for each. */
      items: { value: number; radius: number }[];
      /** The factor (at most 1) that brings the largest radius within `legendConfig.maxSymbolRadiusPx`; every circle is drawn at `radius * scale`. */
      scale: number;
      /** The features without a number: drawn in `color` with `radius` on the map. */
      noData: { color: HexColor; count: number; radius: number } | null;
    };

const numberFormat = new Intl.NumberFormat(legendConfig.numberLocale, {
  maximumFractionDigits: legendConfig.maxFractionDigits,
  maximumSignificantDigits: legendConfig.maxSignificantDigits,
  roundingPriority: 'morePrecision'
});

/** A number as the legend shows it: digits grouped, with `maxFractionDigits` decimals or `maxSignificantDigits` significant digits, whichever is more precise. */
export function formatLegendNumber(value: number): string {
  const text = numberFormat.format(value);
  return text === '-0' ? '0' : text;
}

/** Where a class lies among the classes of a graduated legend: the map's first class is below the first break, the last one above the last. */
export type IntervalPosition = 'first' | 'middle' | 'last';

export function intervalPosition(index: number, count: number): IntervalPosition {
  if (index === count - 1) return 'last';
  return index === 0 ? 'first' : 'middle';
}

/**
 * The label of a class (half-open, as the map's `step`): the first "b 未満", the last "a 以上", the others "a 以上 b 未満".
 * A class the data does not reach says so.
 */
export function intervalLabel({ min, max, empty }: { min: number; max: number; empty: boolean }, position: IntervalPosition): string {
  const { text } = legendConfig;
  const [from, to] = [formatLegendNumber(min), formatLegendNumber(max)];
  const range = {
    first: `${to} ${text.lessThan}`,
    middle: `${from} ${text.atLeast} ${to} ${text.lessThan}`,
    last: `${from} ${text.atLeast}`
  }[position];
  return empty ? `${range} ${text.noMatch}` : range;
}

/** The factor that brings the largest of `radii` within `maxPx`: 1 when it fits already, one factor for all so that their ratios hold. */
export function symbolScale(radii: readonly number[], maxPx: number): number {
  const largest = Math.max(0, ...radii);
  return largest > maxPx ? maxPx / largest : 1;
}

/** The note of a scale below 1 (「縮尺：地図の 1/x」); null at 1. */
export function scaleNote(scale: number): string | null {
  if (scale >= 1) return null;
  return legendConfig.text.scaleNote.replace('{n}', (1 / scale).toFixed(legendConfig.scaleNoteDecimals));
}

/** The radius the map draws for `value`: the area follows the value, so the radius follows its square root (as in `styleCompiler.ts`). */
function symbolRadius(value: number, { min, max, minRadius, maxRadius }: { min: number; max: number; minRadius: number; maxRadius: number }): number {
  const root = (n: number) => Math.sqrt(Math.max(n, 0));
  if (root(min) === root(max)) return (minRadius + maxRadius) / 2;
  const t = (root(value) - root(min)) / (root(max) - root(min));
  return minRadius + t * (maxRadius - minRadius);
}

/** The legend of a layer, from its resolved style only (the data the map draws from), so the two cannot disagree. */
export function toLegend({ resolved, geometryType }: Pick<LayerState, 'resolved' | 'geometryType'>): LegendModel {
  const { text } = legendConfig;
  switch (resolved.type) {
    case 'single':
      return { type: 'single', color: resolved.color, geometryType };
    case 'categorized':
      return {
        type: 'categorized',
        column: resolved.column,
        geometryType,
        items: [
          ...resolved.items.map(({ value, color, count }) => ({ label: value === '' ? text.emptyValue : value, color, count })),
          ...(resolved.other ? [{ label: text.other, ...resolved.other }] : []),
          ...(resolved.nullCount > 0 ? [{ label: text.noData, color: resolved.nullColor, count: resolved.nullCount }] : [])
        ]
      };
    case 'graduated': {
      // Manual breaks can lie outside the data: the ends then reach the breaks, so no interval is reversed.
      const edges = [Math.min(resolved.min, ...resolved.breaks), ...resolved.breaks, Math.max(resolved.max, ...resolved.breaks)];
      return {
        type: 'graduated',
        column: resolved.column,
        geometryType,
        items: resolved.colors.map((color, k) => {
          const [min, max] = [edges[k], edges[k + 1]];
          const isTop = k === resolved.colors.length - 1;
          // The class holds [min, max), the top one [min, ∞): it is empty when the data lies wholly outside it.
          return { min, max, color, empty: min > resolved.max || (!isTop && max <= resolved.min) };
        }),
        noData: resolved.nullCount > 0 ? { color: resolved.nullColor, count: resolved.nullCount } : null
      };
    }
    case 'proportional': {
      const values = resolved.min === resolved.max ? [resolved.min] : [resolved.min, (resolved.min + resolved.max) / 2, resolved.max];
      const items = values.map((value) => ({ value, radius: symbolRadius(value, resolved) }));
      return {
        type: 'proportional',
        column: resolved.column,
        color: resolved.color,
        items,
        scale: symbolScale(items.map((item) => item.radius), legendConfig.maxSymbolRadiusPx),
        noData:
          resolved.nullCount > 0 ? { color: styleConfig.noDataColor, count: resolved.nullCount, radius: styleConfig.noDataRadius } : null
      };
    }
  }
}
