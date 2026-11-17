import { describe, expect, it } from 'vitest';
import { dataConfig, styleConfig } from '../../../shared/config';
import type { GeometryFamily, StyleSpec } from '../../../shared/mapSpec';
import type { GeoJsonFeatureCollection, GeoJsonGeometry, JsonRow } from '../duckdb/queryTypes';
import { qualitativeColors, sequentialColors } from './palettes';
import { resolveStyle, type ResolvedStyle } from './styleCompiler';

const { maxCategories } = dataConfig.classification;

const geometry: Record<GeometryFamily, GeoJsonGeometry> = {
  point: { type: 'Point', coordinates: [139, 35] },
  line: { type: 'LineString', coordinates: [[139, 35], [140, 36]] },
  polygon: { type: 'Polygon', coordinates: [[[139, 35], [140, 35], [140, 36], [139, 35]]] }
};

function collection(rows: JsonRow[], family: GeometryFamily = 'point'): GeoJsonFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: rows.map((properties, id) => ({ type: 'Feature', id, geometry: geometry[family], properties }))
  };
}

function resolved(style: StyleSpec, rows: JsonRow[], family: GeometryFamily = 'point'): ResolvedStyle {
  const result = resolveStyle(style, family, collection(rows, family));
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}

function failed(style: StyleSpec, rows: JsonRow[], family: GeometryFamily = 'point') {
  const result = resolveStyle(style, family, collection(rows, family));
  if (result.ok) throw new Error('expected an error');
  return result.error;
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const prices = Array.from({ length: 10 }, (_, i) => ({ price: (i + 1) * 10, name: `n${i}` }));
const defaultCommon = {
  opacity: styleConfig.defaults.opacity,
  strokeColor: styleConfig.defaults.strokeColor,
  strokeWidth: styleConfig.defaults.strokeWidth,
  size: styleConfig.defaults.size.point
};

describe('resolveStyle: single', () => {
  it.each(['point', 'polygon'] as const)('resolves on %s with the defaults', (family) => {
    expect(resolved({ type: 'single', color: '#112233' }, [{ a: 1 }], family)).toEqual({
      type: 'single',
      color: '#112233',
      common: defaultCommon
    });
  });

  it('defaults size to the point radius for points and the line width for lines', () => {
    const style: StyleSpec = { type: 'single', color: '#112233' };
    expect(resolved(style, [{ a: 1 }], 'point')).toMatchObject({ common: { size: styleConfig.defaults.size.point } });
    expect(resolved(style, [{ a: 1 }], 'line')).toMatchObject({ common: { size: styleConfig.defaults.size.line } });
    expect(styleConfig.defaults.size.line).not.toBe(styleConfig.defaults.size.point);
  });

  it('takes the size of the style over the default for each family', () => {
    for (const family of ['point', 'line', 'polygon'] as const) {
      expect(resolved({ type: 'single', color: '#112233', size: 9 }, [], family)).toMatchObject({ common: { size: 9 } });
    }
  });

  it('takes what the style gives over the defaults', () => {
    const data = resolved({ type: 'single', color: '#112233', opacity: 0.2, strokeColor: '#000000', strokeWidth: 3, size: 9 }, []);
    expect(data).toMatchObject({ common: { opacity: 0.2, strokeColor: '#000000', strokeWidth: 3, size: 9 } });
  });

  it('resolves for a layer with no features', () => {
    expect(resolved({ type: 'single', color: '#112233' }, []).type).toBe('single');
  });
});

describe('resolveStyle: categorized', () => {
  const kinds = [{ kind: 'b' }, { kind: 'a' }, { kind: 'b' }, { kind: 'c' }, { kind: 'a' }, { kind: 'b' }, { kind: null }];

  it.each(['point', 'line', 'polygon'] as const)('counts and colours the categories on %s', (family) => {
    const data = resolved({ type: 'categorized', column: 'kind' }, kinds, family);
    const [c0, c1, c2] = qualitativeColors(styleConfig.defaults.categorizedPalette);
    expect(data).toEqual({
      type: 'categorized',
      column: 'kind',
      items: [
        { value: 'b', color: c0, count: 3 },
        { value: 'a', color: c1, count: 2 },
        { value: 'c', color: c2, count: 1 }
      ],
      other: null,
      nullCount: 1,
      nullColor: styleConfig.noDataColor,
      warnings: [],
      common: { ...defaultCommon, size: family === 'line' ? styleConfig.defaults.size.line : defaultCommon.size }
    });
  });

  it('breaks ties by value and compares numbers and booleans as text', () => {
    const data = resolved({ type: 'categorized', column: 'v' }, [{ v: 2 }, { v: true }, { v: 'x' }, { v: 1 }]);
    expect(data).toMatchObject({ items: [{ value: '1' }, { value: '2' }, { value: 'true' }, { value: 'x' }] });
  });

  it('folds the categories beyond the palette into other', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ k: `v${String(i).padStart(2, '0')}` }));
    rows.push({ k: 'v11' }, { k: 'v11' });
    const data = resolved({ type: 'categorized', column: 'k', palette: 'set2' }, rows);
    if (data.type !== 'categorized') throw new Error('type');
    expect(data.items).toHaveLength(8);
    expect(data.items[0]).toMatchObject({ value: 'v11', count: 3 });
    expect(data.other).toEqual({ color: styleConfig.otherColor, count: 4 });
  });

  it('never colours more than maxCategories, even with a larger palette', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ k: `v${i}` }));
    const data = resolved({ type: 'categorized', column: 'k', palette: 'paired' }, rows);
    if (data.type !== 'categorized') throw new Error('type');
    expect(data.items).toHaveLength(Math.min(maxCategories, qualitativeColors('paired').length));
    expect(data.other?.count).toBe(30 - data.items.length);
  });

  it('replaces colours with overrides and warns about a value that does not occur', () => {
    const data = resolved({ type: 'categorized', column: 'kind', overrides: { a: '#ff0000', zzz: '#00ff00' } }, kinds);
    if (data.type !== 'categorized') throw new Error('type');
    expect(data.items.find((item) => item.value === 'a')?.color).toBe('#ff0000');
    expect(data.items.find((item) => item.value === 'b')?.color).toBe(qualitativeColors('set2')[0]);
    expect(data.items.some((item) => item.value === 'zzz')).toBe(false);
    expect(data.warnings).toEqual(['Override for "zzz" ignored: no feature has that value in "kind".']);
  });

  it('keeps an overridden rare value among the coloured ones', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ k: `v${i}` }));
    const data = resolved({ type: 'categorized', column: 'k', palette: 'set2', overrides: { v9: '#ff0000' } }, rows);
    if (data.type !== 'categorized') throw new Error('type');
    expect(data.items).toHaveLength(9);
    expect(data.items.find((item) => item.value === 'v9')?.color).toBe('#ff0000');
    expect(data.items.filter((item) => item.value !== 'v9').map((item) => item.color)).toEqual(qualitativeColors('set2'));
    expect(data.other).toEqual({ color: styleConfig.otherColor, count: 1 });
    expect(data.warnings).toEqual([]);
  });

  it('keeps ten overridden values coloured on set2, which has eight colours', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ k: `v${i}` }));
    const overrides = Object.fromEntries(rows.map(({ k }) => [k, '#ff0000']));
    const data = resolved({ type: 'categorized', column: 'k', palette: 'set2', overrides }, rows);
    if (data.type !== 'categorized') throw new Error('type');
    expect(data.items).toHaveLength(10);
    expect(data.other).toBeNull();
    expect(data.warnings).toEqual([]);
  });

  it('warns about a frequent value that the overrides pushed into other', () => {
    const rows = [
      ...['f0', 'f1', 'f2', 'f3'].flatMap((k) => Array.from({ length: 5 }, () => ({ k }))),
      ...Array.from({ length: 12 }, (_, i) => ({ k: `r${String(i).padStart(2, '0')}` }))
    ];
    const overrides = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`r${String(i).padStart(2, '0')}`, '#ff0000']));
    const data = resolved({ type: 'categorized', column: 'k', palette: 'set2', overrides }, rows);
    if (data.type !== 'categorized') throw new Error('type');
    expect(data.items).toHaveLength(maxCategories);
    expect(data.other).toEqual({ color: styleConfig.otherColor, count: 20 });
    expect(data.warnings).toEqual(['f0', 'f1', 'f2', 'f3'].map((k) => `"${k}" is shown as "other": the overrides took its colour.`));
  });

  it('treats a value named like an object property as a plain value', () => {
    const data = resolved({ type: 'categorized', column: 'k' }, [{ k: 'constructor' }, { k: '__proto__' }]);
    if (data.type !== 'categorized') throw new Error('type');
    for (const item of data.items) expect(item.color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('gives the features without a value their own colour, apart from other', () => {
    const data = resolved({ type: 'categorized', column: 'kind' }, kinds);
    if (data.type !== 'categorized') throw new Error('type');
    expect(data.nullColor).toBe(styleConfig.noDataColor);
    expect(data.nullColor).not.toBe(styleConfig.otherColor);
  });

  it('gives all null features as nullCount and no category', () => {
    const data = resolved({ type: 'categorized', column: 'k' }, [{ k: null }, { k: null }]);
    expect(data).toMatchObject({ items: [], other: null, nullCount: 2 });
  });
});

describe('resolveStyle: graduated', () => {
  it.each(['point', 'line', 'polygon'] as const)('computes breaks and colours on %s', (family) => {
    const data = resolved({ type: 'graduated', column: 'price', method: 'quantile', classes: 5 }, prices, family);
    expect(data).toEqual({
      type: 'graduated',
      column: 'price',
      breaks: [30, 50, 70, 90],
      colors: sequentialColors(styleConfig.defaults.graduatedPalette, 5),
      min: 10,
      max: 100,
      nullCount: 0,
      nullColor: styleConfig.noDataColor,
      common: { ...defaultCommon, size: family === 'line' ? styleConfig.defaults.size.line : defaultCommon.size }
    });
  });

  it('uses the default class count and palette when the style names none', () => {
    const data = resolved({ type: 'graduated', column: 'price', method: 'equal' }, prices);
    if (data.type !== 'graduated') throw new Error('type');
    expect(data.breaks).toHaveLength(dataConfig.classification.defaultClasses - 1);
    expect(data.colors).toEqual(sequentialColors(styleConfig.defaults.graduatedPalette, dataConfig.classification.defaultClasses));
  });

  it('has one more colour than breaks', () => {
    for (const method of ['quantile', 'equal'] as const) {
      const data = resolved({ type: 'graduated', column: 'price', method, classes: 7 }, prices);
      if (data.type !== 'graduated') throw new Error('type');
      expect(data.colors).toHaveLength(data.breaks.length + 1);
    }
  });

  it('picks the palette and flips it with reverse', () => {
    const plain = resolved({ type: 'graduated', column: 'price', method: 'equal', classes: 4, palette: 'blues' }, prices);
    const flipped = resolved({ type: 'graduated', column: 'price', method: 'equal', classes: 4, palette: 'blues', reverse: true }, prices);
    if (plain.type !== 'graduated' || flipped.type !== 'graduated') throw new Error('type');
    expect(plain.colors).toEqual(sequentialColors('blues', 4));
    expect(flipped.colors).toEqual([...plain.colors].reverse());
    expect(flipped.breaks).toEqual(plain.breaks);
  });

  it('keeps manual breaks as given, also outside the data range', () => {
    const data = resolved({ type: 'graduated', column: 'price', method: 'manual', breaks: [-5, 50, 1000] }, prices);
    if (data.type !== 'graduated') throw new Error('type');
    expect(data.breaks).toEqual([-5, 50, 1000]);
    expect(data.colors).toHaveLength(4);
  });

  it('gives fewer classes for one distinct value, and one colour', () => {
    const data = resolved({ type: 'graduated', column: 'price', method: 'quantile', classes: 5 }, [{ price: 7 }, { price: 7 }]);
    expect(data).toMatchObject({ breaks: [], min: 7, max: 7 });
    if (data.type !== 'graduated') throw new Error('type');
    expect(data.colors).toHaveLength(1);
  });

  it('gives fewer classes for fewer features than classes', () => {
    const data = resolved({ type: 'graduated', column: 'price', method: 'quantile', classes: 9 }, [{ price: 1 }, { price: 2 }, { price: 3 }]);
    if (data.type !== 'graduated') throw new Error('type');
    expect(data.breaks).toEqual([2, 3]);
    expect(data.colors).toHaveLength(3);
  });

  it('keeps quantile classes for skewed data', () => {
    const rows = [...Array.from({ length: 90 }, () => ({ n: 0 })), ...range(1, 10).map((n) => ({ n }))];
    const data = resolved({ type: 'graduated', column: 'n', method: 'quantile', classes: 5 }, rows);
    if (data.type !== 'graduated') throw new Error('type');
    expect(data.breaks).toEqual([1, 2, 3, 4]);
    expect(data.colors).toHaveLength(5);
  });

  it('gives the features without a number the null colour', () => {
    const data = resolved({ type: 'graduated', column: 'price', method: 'equal' }, [{ price: 1 }, { price: null }, { price: 4 }]);
    if (data.type !== 'graduated') throw new Error('type');
    expect(data.nullColor).toBe(styleConfig.noDataColor);
    expect(data.nullCount).toBe(1);
  });

  it('counts NULLs and non-numbers as nullCount, and leaves them out of the breaks', () => {
    const rows = [{ price: 1 }, { price: null }, { price: 'n/a' }, { price: 3 }, { price: 2 }];
    const data = resolved({ type: 'graduated', column: 'price', method: 'equal', classes: 2 }, rows);
    expect(data).toMatchObject({ breaks: [2], min: 1, max: 3, nullCount: 2 });
  });
});

describe('resolveStyle: proportional', () => {
  const style: StyleSpec = { type: 'proportional', column: 'price', color: '#ff0000' };

  it('resolves on points with the default radii', () => {
    expect(resolved(style, prices)).toEqual({
      type: 'proportional',
      column: 'price',
      color: '#ff0000',
      min: 10,
      max: 100,
      minRadius: styleConfig.defaults.minRadius,
      maxRadius: styleConfig.defaults.maxRadius,
      common: defaultCommon
    });
  });

  it('takes the radii of the style', () => {
    expect(resolved({ ...style, minRadius: 2, maxRadius: 8 }, prices)).toMatchObject({ minRadius: 2, maxRadius: 8 });
  });

  it.each(['line', 'polygon'] as const)('is refused on %s', (family) => {
    expect(failed(style, prices, family)).toEqual({
      code: 'INVALID_STYLE',
      message: 'Proportional symbols are for point layers; use graduated colours for lines and polygons.'
    });
  });

  it('refuses a minRadius that is not below the maxRadius left to the default', () => {
    const error = failed({ ...style, minRadius: styleConfig.defaults.maxRadius }, prices);
    expect(error.code).toBe('INVALID_STYLE');
    expect(error.message).toContain('minRadius');
  });
});

describe('resolveStyle: errors', () => {
  const styles: Exclude<StyleSpec, { type: 'single' }>[] = [
    { type: 'categorized', column: 'nope' },
    { type: 'graduated', column: 'nope', method: 'equal' },
    { type: 'proportional', column: 'nope', color: '#000000' }
  ];

  it.each(styles)('names the available columns for an unknown column ($type)', (style) => {
    const error = failed(style, prices);
    expect(error.code).toBe('UNKNOWN_COLUMN');
    expect(error.hint).toBe('Columns: price, name.');
  });

  it('lists at most the hint maximum of columns', () => {
    const wide = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`c${i}`, i]));
    const hint = failed({ type: 'categorized', column: 'nope' }, [wide]).hint ?? '';
    expect(hint.split(', ')).toHaveLength(styleConfig.maxHintColumns);
  });

  it('lists the columns of all features in the hint, not only the first one\'s', () => {
    const error = failed({ type: 'categorized', column: 'nope' }, [{}, { a: 1 }, { b: 2, a: 3 }]);
    expect(error.hint).toBe('Columns: a, b.');
  });

  it('accepts a column that only some features have', () => {
    expect(resolved({ type: 'categorized', column: 'late' }, [{ a: 1 }, { a: 2, late: 'x' }])).toMatchObject({
      items: [{ value: 'x', count: 1 }],
      nullCount: 1
    });
  });

  it.each(styles.slice(1))('refuses a column without numbers ($type)', (style) => {
    const error = failed({ ...style, column: 'name' }, prices);
    expect(error.code).toBe('INVALID_STYLE');
    expect(error.message).toContain('"name"');
    expect(failed({ ...style, column: 'x' }, [{ x: null }, { x: 'a' }, { x: Number.NaN }]).code).toBe('INVALID_STYLE');
  });

  it.each(styles)('refuses a layer with no features ($type)', (style) => {
    expect(failed(style, [])).toEqual({ code: 'INVALID_STYLE', message: 'The layer has no features.' });
  });
});
