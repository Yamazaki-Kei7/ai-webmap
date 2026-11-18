import { describe, expect, it } from 'vitest';
import { legendConfig, styleConfig } from '../../../shared/config';
import type { GeometryFamily, StyleSpec } from '../../../shared/mapSpec';
import type { GeoJsonFeatureCollection, JsonRow } from '../duckdb/queryTypes';
import { formatLegendNumber, intervalLabel, intervalPosition, scaleNote, symbolScale, toLegend } from './legend';
import { resolveStyle, type ResolvedCommon, type ResolvedStyle } from './styleCompiler';

const common: ResolvedCommon = { opacity: 0.5, strokeColor: '#ffffff', strokeWidth: 1, size: 5 };
const families: GeometryFamily[] = ['point', 'line', 'polygon'];
const { text } = legendConfig;

function resolvedFor(style: StyleSpec, rows: JsonRow[], family: GeometryFamily): ResolvedStyle {
  const features: GeoJsonFeatureCollection = {
    type: 'FeatureCollection',
    features: rows.map((properties, id) => ({ type: 'Feature', id, geometry: { type: 'Point', coordinates: [139, 35] }, properties }))
  };
  const result = resolveStyle(style, family, features);
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

describe('toLegend: single', () => {
  it.each(families)('is one swatch on %s', (geometryType) => {
    expect(toLegend({ geometryType, resolved: { type: 'single', color: '#112233', common } })).toEqual({
      type: 'single',
      color: '#112233',
      geometryType
    });
  });
});

describe('toLegend: categorized', () => {
  const base = {
    type: 'categorized',
    column: 'kind',
    items: [
      { value: 'a', color: '#111111', count: 5 },
      { value: '', color: '#222222', count: 2 }
    ],
    other: null,
    nullCount: 0,
    nullColor: '#d9d9d9',
    warnings: [],
    common
  } as const satisfies ResolvedStyle;

  it.each(families)('lists the items in resolved order on %s, an empty value as 「（空）」', (geometryType) => {
    expect(toLegend({ geometryType, resolved: base })).toEqual({
      type: 'categorized',
      column: 'kind',
      geometryType,
      items: [
        { label: 'a', color: '#111111', count: 5 },
        { label: text.emptyValue, color: '#222222', count: 2 }
      ]
    });
  });

  it('adds the other row, then the no-value row', () => {
    const legend = toLegend({
      geometryType: 'point',
      resolved: { ...base, other: { color: '#9e9e9e', count: 7 }, nullCount: 3 }
    });
    expect(legend).toMatchObject({
      items: [
        { label: 'a', count: 5 },
        { label: text.emptyValue, count: 2 },
        { label: text.other, color: '#9e9e9e', count: 7 },
        { label: text.noData, color: '#d9d9d9', count: 3 }
      ]
    });
  });

  it('adds the no-value row alone when there is no other', () => {
    const legend = toLegend({ geometryType: 'point', resolved: { ...base, nullCount: 1 } });
    expect(legend.type === 'categorized' && legend.items.map((item) => item.label)).toEqual(['a', text.emptyValue, text.noData]);
  });

  it('comes out of a style resolved from features', () => {
    const rows = [{ k: 'x' }, { k: 'x' }, { k: 'y' }, { k: null }];
    const legend = toLegend({ geometryType: 'line', resolved: resolvedFor({ type: 'categorized', column: 'k' }, rows, 'line') });
    expect(legend).toMatchObject({
      type: 'categorized',
      geometryType: 'line',
      items: [
        { label: 'x', count: 2 },
        { label: 'y', count: 1 },
        { label: text.noData, count: 1 }
      ]
    });
  });
});

describe('toLegend: graduated', () => {
  const base = {
    type: 'graduated',
    column: 'n',
    breaks: [10, 20],
    colors: ['#aaaaaa', '#bbbbbb', '#cccccc'],
    min: 0,
    max: 30,
    nullCount: 0,
    nullColor: '#d9d9d9',
    common
  } as const satisfies ResolvedStyle;

  it.each(families)('gives one item per class with the data min and max at the ends on %s', (geometryType) => {
    expect(toLegend({ geometryType, resolved: base })).toEqual({
      type: 'graduated',
      column: 'n',
      geometryType,
      items: [
        { min: 0, max: 10, color: '#aaaaaa', empty: false },
        { min: 10, max: 20, color: '#bbbbbb', empty: false },
        { min: 20, max: 30, color: '#cccccc', empty: false }
      ],
      noData: null
    });
  });

  it('reports the features without a number', () => {
    expect(toLegend({ geometryType: 'polygon', resolved: { ...base, nullCount: 4 } })).toMatchObject({
      noData: { color: '#d9d9d9', count: 4 }
    });
  });

  describe('manual breaks outside the data (data 0 to 30)', () => {
    const ranges = (breaks: number[]) => {
      const legend = toLegend({
        geometryType: 'polygon',
        resolved: { ...base, breaks, colors: [...breaks.map(() => '#000000' as const), '#111111'] }
      });
      if (legend.type !== 'graduated') throw new Error('not graduated');
      return legend.items.map(({ min, max, empty }) => [min, max, empty]);
    };

    it('reaches a break below the data and marks the classes the data does not reach', () => {
      expect(ranges([-20, -10])).toEqual([
        [-20, -20, true],
        [-20, -10, true],
        [-10, 30, false]
      ]);
    });

    it('reaches a break above the data', () => {
      expect(ranges([100, 200])).toEqual([
        [0, 100, false],
        [100, 200, true],
        [200, 200, true]
      ]);
    });

    it('spans the data with breaks on both sides', () => {
      expect(ranges([-5, 15, 50])).toEqual([
        [-5, -5, true],
        [-5, 15, false],
        [15, 50, false],
        [50, 50, true]
      ]);
    });

    it('never gives an interval that runs backwards', () => {
      for (const breaks of [[-20, -10], [100, 200], [-5, 15, 50], [10, 20]]) {
        for (const [min, max] of ranges(breaks)) expect(min as number).toBeLessThanOrEqual(max as number);
      }
    });
  });

  it('is one class when the values do not differ', () => {
    const resolved = resolvedFor({ type: 'graduated', column: 'n', method: 'quantile', classes: 3 }, [{ n: 7 }, { n: 7 }], 'polygon');
    const legend = toLegend({ geometryType: 'polygon', resolved });
    expect(legend).toMatchObject({ items: [{ min: 7, max: 7, empty: false }] });
  });
});

describe('toLegend: proportional', () => {
  const base = {
    type: 'proportional',
    column: 'n',
    color: '#ff0000',
    min: 100,
    max: 400,
    minRadius: 3,
    maxRadius: 30,
    nullCount: 0,
    common
  } as const satisfies ResolvedStyle;

  it('gives the min, the middle and the max with the radii of the square-root rule', () => {
    const legend = toLegend({ geometryType: 'point', resolved: base });
    expect(legend.type).toBe('proportional');
    if (legend.type !== 'proportional') return;
    expect(legend.items.map((item) => item.value)).toEqual([100, 250, 400]);
    expect(legend.items[0].radius).toBeCloseTo(3);
    expect(legend.items[2].radius).toBeCloseTo(30);
    // sqrt(250) lies between sqrt(100) = 10 and sqrt(400) = 20.
    expect(legend.items[1].radius).toBeCloseTo(3 + ((Math.sqrt(250) - 10) / 10) * 27);
  });

  it('is one circle of the mid radius when min equals max (as on the map)', () => {
    expect(toLegend({ geometryType: 'point', resolved: { ...base, min: 5, max: 5 } })).toEqual({
      type: 'proportional',
      column: 'n',
      color: '#ff0000',
      items: [{ value: 5, radius: 16.5 }],
      scale: 1,
      noData: null
    });
  });

  it('adds a no-data circle with the map radius and colour when features have no number', () => {
    const legend = toLegend({ geometryType: 'point', resolved: { ...base, nullCount: 6 } });
    expect(legend).toMatchObject({ noData: { color: styleConfig.noDataColor, count: 6, radius: styleConfig.noDataRadius } });
  });

  it('scales every circle by one factor when the largest is over the cap, keeping the ratios', () => {
    const legend = toLegend({ geometryType: 'point', resolved: { ...base, minRadius: 10, maxRadius: 100 } });
    if (legend.type !== 'proportional') throw new Error('not proportional');
    expect(legend.scale).toBeCloseTo(legendConfig.maxSymbolRadiusPx / 100);
    expect(legend.items[2].radius * legend.scale).toBeCloseTo(legendConfig.maxSymbolRadiusPx);
    expect(legend.items[0].radius).toBeCloseTo(10);
  });
});

describe('intervalLabel', () => {
  it('says b 未満 for the first class, a 以上 for the last and a 以上 b 未満 between', () => {
    expect(intervalLabel({ min: 0, max: 5, empty: false }, 'first')).toBe('5 未満');
    expect(intervalLabel({ min: 5, max: 11, empty: false }, 'middle')).toBe('5 以上 11 未満');
    expect(intervalLabel({ min: 46, max: 287, empty: false }, 'last')).toBe('46 以上');
  });

  it('marks a class no data falls in, below and above the data', () => {
    expect(intervalLabel({ min: -20, max: -20, empty: true }, 'first')).toBe('-20 未満 （該当なし）');
    expect(intervalLabel({ min: 1000, max: 2000, empty: true }, 'middle')).toBe('1,000 以上 2,000 未満 （該当なし）');
    expect(intervalLabel({ min: 2000, max: 2000, empty: true }, 'last')).toBe('2,000 以上 （該当なし）');
  });

  it('labels a legend with breaks below and above the data from its classes', () => {
    const labels = (breaks: number[]) => {
      const legend = toLegend({
        geometryType: 'polygon',
        resolved: { type: 'graduated', column: 'n', breaks, colors: [...breaks.map(() => '#000000' as const), '#111111'], min: 0, max: 30, nullCount: 0, nullColor: '#d9d9d9', common }
      });
      if (legend.type !== 'graduated') throw new Error('not graduated');
      return legend.items.map((item, k) => intervalLabel(item, intervalPosition(k, legend.items.length)));
    };
    expect(labels([-20, -10])).toEqual(['-20 未満 （該当なし）', '-20 以上 -10 未満 （該当なし）', '-10 以上']);
    expect(labels([100, 200])).toEqual(['100 未満', '100 以上 200 未満 （該当なし）', '200 以上 （該当なし）']);
  });
});

describe('intervalPosition', () => {
  it('is last for the only class, and first, middle, last otherwise', () => {
    expect(intervalPosition(0, 1)).toBe('last');
    expect([0, 1, 2].map((k) => intervalPosition(k, 3))).toEqual(['first', 'middle', 'last']);
  });
});

describe('symbolScale and scaleNote', () => {
  it('is 1 while the largest radius fits, and the ratio of the cap to it beyond', () => {
    expect(symbolScale([3, 10, 30], 36)).toBe(1);
    expect(symbolScale([3, 50, 100], 40)).toBe(0.4);
    expect(symbolScale([], 40)).toBe(1);
  });

  it('notes a scale below 1 as 1/x of the map, and nothing at 1', () => {
    expect(scaleNote(1)).toBeNull();
    expect(scaleNote(0.4)).toBe('縮尺：地図の 1/2.5');
  });
});

describe('formatLegendNumber', () => {
  it.each([
    [0, '0'],
    [12, '12'],
    [1234567, '1,234,567'],
    [-1234, '-1,234'],
    [1.5, '1.5'],
    [3.14159, '3.14'],
    [2.999, '3'],
    [-0.001, '-0.001'],
    [0.004, '0.004'],
    [0.0123, '0.012'],
    [-0, '0'],
    [123456789012, '123,456,789,012']
  ])('formats %d as %s', (value, expected) => {
    expect(formatLegendNumber(value)).toBe(expected);
  });

  it('does not use more decimals than the config allows', () => {
    expect(formatLegendNumber(0.123456).split('.')[1]).toHaveLength(legendConfig.maxFractionDigits);
  });
});
