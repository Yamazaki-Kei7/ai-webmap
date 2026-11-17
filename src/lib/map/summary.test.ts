import { describe, expect, it } from 'vitest';
import { mapConfig, resultConfig } from '../../../shared/config';
import { mapContextSchema, type MapContext, type MapContextLayer, type StyleSpec } from '../../../shared/mapSpec';
import type { GeoJsonFeatureCollection } from '../duckdb/queryTypes';
import type { LayerState } from './mapState.svelte';
import { resolveStyle } from './styleCompiler';
import { buildMapContext } from './summary';

const view = { center: [139.7, 35.7] as [number, number], zoom: 9 };
const bytesOf = (context: MapContext) => new TextEncoder().encode(JSON.stringify(context)).length;
const detailed = (context: MapContext): MapContextLayer[] =>
  context.layers.flatMap((layer) => ('columns' in layer ? [layer] : []));

/** A layer state as `addLayer` would make it, without the map state. */
function layer(
  n: number,
  rows: Record<string, string | number>[],
  style: StyleSpec,
  extra: Partial<LayerState> = {}
): LayerState {
  const features: GeoJsonFeatureCollection = {
    type: 'FeatureCollection',
    features: rows.map((properties, id) => ({ type: 'Feature', id, geometry: { type: 'Point', coordinates: [139, 35] }, properties }))
  };
  const resolved = resolveStyle(style, 'point', features);
  if (!resolved.ok) throw new Error(resolved.error.message);
  const names = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return {
    id: `L${n}`,
    name: `layer ${n}`,
    sql: 'SELECT * FROM t',
    datasetIds: [],
    geometryType: 'point',
    columns: names.map((name) => ({ name, type: typeof rows[0][name] === 'number' ? 'number' : 'string' })),
    featureCount: rows.length,
    bbox: [139, 35, 139, 35],
    visible: true,
    style,
    label: null,
    resolved: resolved.data,
    status: 'ready',
    ...extra
  };
}

const kindRows = (count: number, tag = 'kind') => Array.from({ length: count }, (_, i) => ({ name: `n${i}`, kind: `${tag}${i}` }));

describe('buildMapContext', () => {
  it('cuts the layer name, SQL, warnings and category values, and validates against the schema', () => {
    const long = 'あ'.repeat(mapConfig.summaryMaxStringChars * 3);
    const state = layer(1, [{ k: long }], { type: 'categorized', column: 'k', overrides: { missing: '#ff0000', [long]: '#00ff00' } }, {
      name: long,
      sql: `SELECT ${'x'.repeat(mapConfig.summarySqlChars * 2)}`
    });
    const context = buildMapContext(view, [state]);
    expect(mapContextSchema.safeParse(context).success).toBe(true);
    const [first] = detailed(context);
    expect(first.name).toHaveLength(mapConfig.summaryMaxStringChars);
    expect(first.name.endsWith('…')).toBe(true);
    expect(first.sql).toHaveLength(mapConfig.summarySqlChars);
    expect(first.applied.type === 'categorized' && first.applied.categories[0].value.endsWith('…')).toBe(true);
    expect(first.style.type === 'categorized' && Object.keys(first.style.overrides ?? {}).some((key) => key.endsWith('…'))).toBe(true);
  });

  it('lists a layer that failed to load by id, name and a short error note, and validates against the schema', () => {
    const failed = layer(2, [{ a: 1 }], { type: 'single', color: '#112233' }, {
      status: 'error',
      errorMessage: 'x'.repeat(mapConfig.summaryErrorChars * 2)
    });
    const context = buildMapContext(view, [layer(1, [{ a: 1 }], { type: 'single', color: '#112233' }), failed]);
    expect(mapContextSchema.safeParse(context).success).toBe(true);
    const listed = context.layers[1];
    expect(Object.keys(listed).sort()).toEqual(['error', 'id', 'name', 'sql']);
    expect('error' in listed && listed.error).toHaveLength(mapConfig.summaryErrorChars);
    expect('sql' in listed && listed.sql).toBe('SELECT * FROM t');
    expect(detailed(context).map(({ id }) => id)).toEqual(['L1']);
  });

  it('keeps overrides and categories with a shared long prefix distinct', () => {
    const prefix = 'あ'.repeat(mapConfig.summaryMaxStringChars + 5);
    const values = Array.from({ length: 12 }, (_, i) => `${prefix}${i}`);
    const overrides = Object.fromEntries(values.map((value) => [value, '#ff0000']));
    const state = layer(1, values.map((kind) => ({ kind })), { type: 'categorized', column: 'kind', overrides });
    const [first] = detailed(buildMapContext(view, [state]));
    expect(Object.keys(first.style.type === 'categorized' ? (first.style.overrides ?? {}) : {})).toHaveLength(12);
    expect(new Set(first.applied.type === 'categorized' ? first.applied.categories.map(({ value }) => value) : []).size).toBe(12);
  });

  it('shows one long value as the same text in the overrides and in the categories (one numbering)', () => {
    const prefix = 'あ'.repeat(mapConfig.summaryMaxStringChars + 5);
    const [a, b, c] = ['a', 'b', 'c'].map((tail) => `${prefix}${tail}`);
    // The overrides name b and c, the data has a and b (b twice, so it is the first category): the override key of b and the category value of b are the same clipped string.
    const state = layer(1, [a, b, b].map((kind) => ({ kind })), { type: 'categorized', column: 'kind', overrides: { [b]: '#ff0000', [c]: '#00ff00' } });
    const [first] = detailed(buildMapContext(view, [state]));
    const overrideKeys = Object.keys(first.style.type === 'categorized' ? (first.style.overrides ?? {}) : {});
    const categoryValues = first.applied.type === 'categorized' ? first.applied.categories.map(({ value }) => value) : [];
    const [bShown, cShown] = overrideKeys;
    const [bCategory, aCategory] = categoryValues;
    expect(bShown).toBe(bCategory);
    expect(new Set([bShown, cShown, aCategory]).size).toBe(3);
    for (const text of [bShown, cShown, aCategory]) expect(text.endsWith('…') || /…#\d+$/.test(text)).toBe(true);
  });

  it('lists at most the configured columns, counts them all, and leaves out (never cuts) a column with a long name', () => {
    const longName = 'c'.repeat(mapConfig.summaryMaxColumnNameChars + 1);
    const row = Object.fromEntries([...Array.from({ length: 30 }, (_, i) => [`col${i}`, i]), [longName, 1]]);
    const [first] = detailed(buildMapContext(view, [layer(1, [row], { type: 'single', color: '#112233' })]));
    expect(first.columns).toHaveLength(mapConfig.summaryMaxColumns);
    expect(first.columnCount).toBe(31);
    expect(first.columns.some(({ name }) => name.startsWith('cccc'))).toBe(false);
    const onlyLong = detailed(buildMapContext(view, [layer(2, [{ [longName]: 1, a: 1 }], { type: 'single', color: '#112233' })]))[0];
    expect(onlyLong.columns).toEqual([{ name: 'a', type: 'number' }]);
    expect(onlyLong.columnCount).toBe(2);
  });

  it('keeps at most the configured number of warnings', () => {
    const overrides = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`absent${i}`, '#ff0000']));
    const [first] = detailed(buildMapContext(view, [layer(1, [{ k: 'a' }], { type: 'categorized', column: 'k', overrides })]));
    expect(first.applied.type === 'categorized' && first.applied.warnings).toHaveLength(mapConfig.summaryMaxWarnings);
  });

  it('lists layers beyond the maximum by id and name only', () => {
    const layers = Array.from({ length: mapConfig.summaryMaxLayers + 3 }, (_, i) => layer(i + 1, kindRows(3), { type: 'single', color: '#112233' }));
    const context = buildMapContext(view, layers);
    expect(detailed(context)).toHaveLength(mapConfig.summaryMaxLayers);
    expect(context.layers.slice(mapConfig.summaryMaxLayers)).toEqual(layers.slice(mapConfig.summaryMaxLayers).map(({ id, name }) => ({ id, name })));
    expect(mapContextSchema.safeParse(context).success).toBe(true);
  });

  it('stays small for a realistic map of three layers', () => {
    const stations = layer(1, Array.from({ length: 40 }, (_, i) => ({ station_name: `駅${i}`, operator: i % 3 ? 'JR東日本' : '東京メトロ', line_name: `線${i % 5}`, passengers_per_day: i * 100, muni_code: '13101', city_name: '千代田区', pref_name: '東京都' })), { type: 'categorized', column: 'operator' }, {
      sql: "SELECT * FROM stations WHERE pref_name = '東京都'",
      label: { column: 'station_name' }
    });
    const prefs = layer(2, Array.from({ length: 47 }, (_, i) => ({ pref_code: i, pref_name: `県${i}` })), { type: 'graduated', column: 'pref_code', method: 'quantile', classes: 5 });
    const rails = layer(3, Array.from({ length: 30 }, (_, i) => ({ line_name: `線${i}`, operator: `社${i % 4}`, operator_type: i % 2 ? '民営鉄道' : 'JR在来線', railway_type: '普通鉄道' })), { type: 'categorized', column: 'operator_type' });
    const bytes = bytesOf(buildMapContext(view, [stations, prefs, rails]));
    expect(bytes).toBeLessThan(3 * 1024);
  });

  describe('against a worst case', () => {
    const long = (tag: string, n: number) => `${n}${tag}${'漢'.repeat(200)}`;
    const wideRow = (i: number) => ({
      ...Object.fromEntries(Array.from({ length: 60 }, (_, c) => [`attr${c}`, i])),
      kind: long('値', i)
    });
    const rows = Array.from({ length: 20 }, (_, i) => wideRow(i));
    const overrides = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [long('無', i), '#ff0000']));
    const worst = (count: number, visibleFrom = 0): LayerState[] =>
      Array.from({ length: count }, (_, i) =>
        layer(i + 1, rows, { type: 'categorized', column: 'kind', overrides }, { name: long('レイヤー', i), sql: '漢'.repeat(500), visible: i >= visibleFrom, label: { column: 'kind' } })
      );

    it('stays within the limit for many layers, in valid form', () => {
      const context = buildMapContext(view, worst(30));
      expect(bytesOf(context)).toBeLessThanOrEqual(mapConfig.summaryMaxBytes);
      expect(mapConfig.summaryMaxBytes).toBeLessThanOrEqual(resultConfig.maxToolResultBytes);
      expect(mapContextSchema.safeParse(context).success).toBe(true);
    });

    // Each step is tried only when the previous one was not enough: the limit is set just under the size before the step.
    it('shrinks in order: hidden columns, all columns, categories, then layers (marked truncated)', () => {
      const layers = worst(4, 2);
      const full = buildMapContext(view, layers, Infinity);
      expect(full.truncated).toBeUndefined();
      expect(detailed(full).every(({ columns }) => columns.length === mapConfig.summaryMaxColumns)).toBe(true);

      const step1 = buildMapContext(view, layers, bytesOf(full) - 1);
      expect(detailed(step1).map(({ visible, columns }) => [visible, columns.length > 0])).toEqual([[false, false], [false, false], [true, true], [true, true]]);

      const step2 = buildMapContext(view, layers, bytesOf(step1) - 1);
      expect(detailed(step2).every(({ columns }) => columns.length === 0)).toBe(true);
      expect(detailed(step2).every(({ applied }) => applied.type === 'categorized' && applied.categories.length === applied.categoryCount)).toBe(true);

      const step3 = buildMapContext(view, layers, bytesOf(step2) - 1);
      expect(detailed(step3).every(({ applied }) => applied.type === 'categorized' && applied.categories.length === mapConfig.summaryShrunkCategories && applied.categoryCount > mapConfig.summaryShrunkCategories)).toBe(true);
      expect(step3.truncated).toBeUndefined();

      const step4 = buildMapContext(view, layers, bytesOf(step3) - 1);
      expect(step4.truncated).toBe(true);
      expect(bytesOf(step4)).toBeLessThanOrEqual(bytesOf(step3) - 1);
      expect(step4.layers.some((l) => !('columns' in l))).toBe(true);
      expect(mapContextSchema.safeParse(step4).success).toBe(true);
    });
  });
});
