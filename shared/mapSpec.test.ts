import { describe, expect, it } from 'vitest';
import { dataConfig, queryConfig, styleConfig } from './config';
import { appliedStyleSchema, labelSpecSchema, mapContextSchema, styleSpecSchema, viewTargetSchema } from './mapSpec';

const { minClasses, maxClasses, maxCategories } = dataConfig.classification;

function messages(result: { success: boolean; error?: { issues: { message: string }[] } }): string[] {
  return result.error?.issues.map((issue) => issue.message) ?? [];
}

describe('styleSpecSchema', () => {
  it('accepts one valid example of each style type', () => {
    const styles = [
      { type: 'single', color: '#1f78b4' },
      { type: 'categorized', column: 'kind', palette: 'tableau10', overrides: { A: '#ff0000' } },
      { type: 'categorized', column: 'kind' },
      { type: 'graduated', column: 'price', method: 'quantile', classes: 5, palette: 'ylorrd', reverse: true },
      { type: 'graduated', column: 'price', method: 'equal' },
      { type: 'graduated', column: 'price', method: 'manual', breaks: [10, 20, 30] },
      { type: 'proportional', column: 'pop', color: '#E41A1C', minRadius: 2, maxRadius: 40 },
      { type: 'single', color: '#000000', opacity: 0, strokeColor: '#ffffff', strokeWidth: 2, size: 6 }
    ];
    for (const style of styles) expect(styleSpecSchema.safeParse(style).success, JSON.stringify(style)).toBe(true);
  });

  it('keeps the spec as written (no defaults filled in)', () => {
    const style = { type: 'graduated', column: 'price', method: 'quantile' };
    expect(styleSpecSchema.parse(style)).toEqual(style);
  });

  it.each(['#fff', 'red', '#12345g', '#1234567', '1f78b4'])('rejects the colour %s', (color) => {
    expect(styleSpecSchema.safeParse({ type: 'single', color }).success).toBe(false);
    expect(styleSpecSchema.safeParse({ type: 'single', color: '#000000', strokeColor: color }).success).toBe(false);
  });

  it('rejects classes out of range or not whole', () => {
    const graduated = { type: 'graduated', column: 'p', method: 'quantile' };
    for (const classes of [minClasses - 1, maxClasses + 1, 3.5]) {
      expect(styleSpecSchema.safeParse({ ...graduated, classes }).success, String(classes)).toBe(false);
    }
    for (const classes of [minClasses, maxClasses]) {
      expect(styleSpecSchema.safeParse({ ...graduated, classes }).success, String(classes)).toBe(true);
    }
  });

  it('requires breaks for manual and says so', () => {
    const result = styleSpecSchema.safeParse({ type: 'graduated', column: 'p', method: 'manual' });
    expect(result.success).toBe(false);
    expect(messages(result)).toEqual(['method "manual" requires breaks.']);
  });

  it('rejects classes with manual, and says what to do', () => {
    const result = styleSpecSchema.safeParse({ type: 'graduated', column: 'p', method: 'manual', breaks: [1], classes: 7 });
    expect(result.success).toBe(false);
    expect(messages(result)).toEqual(['With method manual, give breaks only; the number of classes is breaks.length + 1.']);
  });

  it.each(['quantile', 'equal'])('rejects breaks with %s', (method) => {
    const result = styleSpecSchema.safeParse({ type: 'graduated', column: 'p', method, breaks: [1, 2] });
    expect(result.success).toBe(false);
    expect(messages(result)[0]).toContain('only for method "manual"');
  });

  it('rejects manual breaks that do not ascend, repeat, are too many or too few', () => {
    const manual = { type: 'graduated', column: 'p', method: 'manual' };
    expect(styleSpecSchema.safeParse({ ...manual, breaks: [3, 2] }).success).toBe(false);
    expect(styleSpecSchema.safeParse({ ...manual, breaks: [2, 2] }).success).toBe(false);
    expect(styleSpecSchema.safeParse({ ...manual, breaks: [] }).success).toBe(false);
    const tooMany = Array.from({ length: maxClasses }, (_, i) => i);
    expect(styleSpecSchema.safeParse({ ...manual, breaks: tooMany }).success).toBe(false);
    expect(styleSpecSchema.safeParse({ ...manual, breaks: tooMany.slice(1) }).success).toBe(true);
    expect(styleSpecSchema.safeParse({ ...manual, breaks: [1, Number.NaN] }).success).toBe(false);
    expect(styleSpecSchema.safeParse({ ...manual, breaks: [1, Number.POSITIVE_INFINITY] }).success).toBe(false);
  });

  it('rejects an unknown key', () => {
    expect(styleSpecSchema.safeParse({ type: 'single', color: '#000000', colour: '#ffffff' }).success).toBe(false);
    expect(styleSpecSchema.safeParse({ type: 'graduated', column: 'p', method: 'equal', bins: 4 }).success).toBe(false);
  });

  it('rejects an unknown type and a key of another type', () => {
    expect(styleSpecSchema.safeParse({ type: 'heatmap', column: 'p' }).success).toBe(false);
    expect(styleSpecSchema.safeParse({ type: 'single', color: '#000000', column: 'p' }).success).toBe(false);
  });

  it('rejects common values out of range', () => {
    const single = { type: 'single', color: '#000000' };
    for (const patch of [
      { opacity: 1.5 },
      { opacity: -0.1 },
      { strokeWidth: 0 },
      { strokeWidth: styleConfig.maxStrokeWidth + 1 },
      { size: 0 },
      { size: styleConfig.maxSize + 1 }
    ]) {
      expect(styleSpecSchema.safeParse({ ...single, ...patch }).success, JSON.stringify(patch)).toBe(false);
    }
  });

  it('needs a non-empty column of bounded length', () => {
    const base = { type: 'categorized' };
    expect(styleSpecSchema.safeParse({ ...base, column: '' }).success).toBe(false);
    expect(styleSpecSchema.safeParse({ ...base, column: 'x'.repeat(styleConfig.maxColumnChars + 1) }).success).toBe(false);
    expect(styleSpecSchema.safeParse({ ...base, column: 'x'.repeat(styleConfig.maxColumnChars) }).success).toBe(true);
  });

  it('rejects an unknown palette, and a palette of the other kind', () => {
    expect(styleSpecSchema.safeParse({ type: 'categorized', column: 'k', palette: 'ylorrd' }).success).toBe(false);
    expect(styleSpecSchema.safeParse({ type: 'graduated', column: 'k', method: 'equal', palette: 'set2' }).success).toBe(false);
  });

  it('limits the overrides to the category maximum', () => {
    const overrides = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`v${i}`, '#ff0000']));
    expect(styleSpecSchema.safeParse({ type: 'categorized', column: 'k', overrides: overrides(maxCategories) }).success).toBe(true);
    expect(styleSpecSchema.safeParse({ type: 'categorized', column: 'k', overrides: overrides(maxCategories + 1) }).success).toBe(false);
    expect(styleSpecSchema.safeParse({ type: 'categorized', column: 'k', overrides: { A: 'red' } }).success).toBe(false);
  });

  it('needs minRadius below maxRadius, both within bounds', () => {
    const base = { type: 'proportional', column: 'p', color: '#000000' };
    expect(styleSpecSchema.safeParse({ ...base, minRadius: 5, maxRadius: 5 }).success).toBe(false);
    expect(styleSpecSchema.safeParse({ ...base, minRadius: 9, maxRadius: 5 }).success).toBe(false);
    expect(styleSpecSchema.safeParse({ ...base, minRadius: 0 }).success).toBe(false);
    expect(styleSpecSchema.safeParse({ ...base, maxRadius: styleConfig.maxRadius + 1 }).success).toBe(false);
    expect(styleSpecSchema.safeParse({ ...base, minRadius: 5 }).success).toBe(true);
  });
});

describe('labelSpecSchema', () => {
  it('accepts a label with and without options', () => {
    expect(labelSpecSchema.safeParse({ column: 'name' }).success).toBe(true);
    expect(
      labelSpecSchema.safeParse({ column: 'name', size: 12, color: '#333333', haloColor: '#ffffff', haloWidth: 1.5, minZoom: 8 }).success
    ).toBe(true);
  });

  it('rejects a bad column, colour, size, halo, zoom or key', () => {
    for (const patch of [
      { column: '' },
      { color: 'black' },
      { haloColor: '#fff' },
      { size: 0 },
      { size: styleConfig.maxLabelSize + 1 },
      { haloWidth: styleConfig.maxHaloWidth + 1 },
      { minZoom: -1 },
      { minZoom: styleConfig.zoom.max + 1 },
      { text: 'x' }
    ]) {
      expect(labelSpecSchema.safeParse({ column: 'name', ...patch }).success, JSON.stringify(patch)).toBe(false);
    }
  });
});

describe('viewTargetSchema', () => {
  it('accepts each view target', () => {
    const targets = [
      { type: 'layer', layerId: 'L1' },
      { type: 'bbox', bbox: [139, 35, 140, 36] },
      { type: 'bbox', bbox: [139, 35, 139, 35] },
      { type: 'center', center: [139.7, 35.7], zoom: 10 },
      { type: 'query', sql: 'SELECT 1' }
    ];
    for (const target of targets) expect(viewTargetSchema.safeParse(target).success, JSON.stringify(target)).toBe(true);
  });

  it('rejects a bbox with min above max on an axis, or out of the world', () => {
    expect(viewTargetSchema.safeParse({ type: 'bbox', bbox: [140, 35, 139, 36] }).success).toBe(false);
    expect(viewTargetSchema.safeParse({ type: 'bbox', bbox: [139, 36, 140, 35] }).success).toBe(false);
    expect(viewTargetSchema.safeParse({ type: 'bbox', bbox: [-181, 35, 140, 36] }).success).toBe(false);
    expect(viewTargetSchema.safeParse({ type: 'bbox', bbox: [139, 35, 140, 91] }).success).toBe(false);
    expect(viewTargetSchema.safeParse({ type: 'bbox', bbox: [139, 35, 140] }).success).toBe(false);
  });

  it('rejects a centre or zoom out of range', () => {
    expect(viewTargetSchema.safeParse({ type: 'center', center: [181, 0], zoom: 5 }).success).toBe(false);
    expect(viewTargetSchema.safeParse({ type: 'center', center: [0, -91], zoom: 5 }).success).toBe(false);
    expect(viewTargetSchema.safeParse({ type: 'center', center: [0, 0], zoom: 23 }).success).toBe(false);
    expect(viewTargetSchema.safeParse({ type: 'center', center: [0, 0] }).success).toBe(false);
  });

  it('rejects an empty layer id, an empty or too long sql, and unknown keys', () => {
    expect(viewTargetSchema.safeParse({ type: 'layer', layerId: '' }).success).toBe(false);
    expect(viewTargetSchema.safeParse({ type: 'query', sql: '' }).success).toBe(false);
    expect(viewTargetSchema.safeParse({ type: 'query', sql: 'x'.repeat(queryConfig.maxSqlChars) }).success).toBe(true);
    expect(viewTargetSchema.safeParse({ type: 'query', sql: 'x'.repeat(queryConfig.maxSqlChars + 1) }).success).toBe(false);
    expect(viewTargetSchema.safeParse({ type: 'layer', layerId: 'L1', zoom: 3 }).success).toBe(false);
  });
});

describe('mapContextSchema', () => {
  const layer = {
    id: 'L1',
    name: 'stations',
    geometryType: 'point',
    featureCount: 3,
    visible: true,
    sql: 'SELECT * FROM stations',
    columns: [{ name: 'passengers', type: 'number' }],
    columnCount: 1,
    style: { type: 'proportional', column: 'passengers', color: '#336699' },
    label: null,
    applied: { type: 'proportional', column: 'passengers', color: '#336699', min: 1, max: 9, minRadius: 3, maxRadius: 30 }
  };
  const context = { view: { center: [139.7, 35.7], zoom: 9 }, layers: [layer] };

  it('accepts a view with layers', () => {
    expect(mapContextSchema.safeParse(context).success).toBe(true);
    expect(mapContextSchema.safeParse({ ...context, layers: [] }).success).toBe(true);
  });

  it('accepts a layer reduced to an id and a name, and the truncated mark', () => {
    expect(mapContextSchema.safeParse({ ...context, layers: [{ id: 'L2', name: 'rails' }], truncated: true }).success).toBe(true);
    expect(mapContextSchema.safeParse({ ...context, truncated: false }).success).toBe(false);
  });

  it('refuses a layer that carries anything else, such as features', () => {
    expect(mapContextSchema.safeParse({ ...context, layers: [{ ...layer, features: [] }] }).success).toBe(false);
  });

  it('refuses a column type or geometry family that does not exist', () => {
    expect(mapContextSchema.safeParse({ ...context, layers: [{ ...layer, geometryType: 'volume' }] }).success).toBe(false);
    expect(mapContextSchema.safeParse({ ...context, layers: [{ ...layer, columns: [{ name: 'a', type: 'date' }] }] }).success).toBe(false);
  });

  it('describes each style type that was applied', () => {
    const applied = [
      { type: 'single', color: '#112233' },
      { type: 'categorized', column: 'k', categories: [{ value: 'a', color: '#112233', count: 2 }], categoryCount: 1, other: { color: '#9e9e9e', count: 1 }, nullCount: 0, warnings: [] },
      { type: 'graduated', column: 'n', breaks: [5], colors: ['#112233', '#445566'], min: 1, max: 9, nullCount: 0 }
    ];
    for (const item of applied) expect(appliedStyleSchema.safeParse(item).success).toBe(true);
    expect(appliedStyleSchema.safeParse({ type: 'graduated', column: 'n' }).success).toBe(false);
  });
});
