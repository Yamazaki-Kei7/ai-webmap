import { describe, expect, it } from 'vitest';
import { mapsConfig, queryConfig, styleConfig } from './config';
import { mapTitleSchema, persistedMapStateSchema, savedMapSchema, type PersistedMapState } from './persistedMap';

const layer = (n: number): PersistedMapState['layers'][number] => ({
  id: `L${n}`,
  name: `Layer ${n}`,
  sql: 'SELECT * FROM schools',
  style: { type: 'single', color: '#1f78b4' },
  label: null,
  visible: true
});

const state: PersistedMapState = {
  version: 1,
  view: { center: [139.7, 35.7], zoom: 9 },
  layers: [layer(1), { ...layer(2), style: { type: 'graduated', column: 'price', method: 'quantile' }, label: { column: 'name', size: 12 }, visible: false }],
  nextLayerSeq: 3
};

describe('persistedMapStateSchema', () => {
  it('accepts a state and keeps it as it is (no defaults filled in)', () => {
    expect(persistedMapStateSchema.parse(state)).toEqual(state);
    expect(persistedMapStateSchema.safeParse({ ...state, layers: [] }).success).toBe(true);
  });

  it('refuses any other version', () => {
    expect(persistedMapStateSchema.safeParse({ ...state, version: 2 }).success).toBe(false);
  });

  it('refuses what is not a saved layer: features, resolved data, unknown keys', () => {
    expect(persistedMapStateSchema.safeParse({ ...state, features: [] }).success).toBe(false);
    expect(persistedMapStateSchema.safeParse({ ...state, layers: [{ ...layer(1), featureCount: 3 }] }).success).toBe(false);
    expect(persistedMapStateSchema.safeParse({ ...state, layers: [{ ...layer(1), label: undefined }] }).success).toBe(false);
  });

  it('bounds the layers: their number, the id, the SQL and the duplicates', () => {
    const many = Array.from({ length: mapsConfig.maxLayers + 1 }, (_, n) => layer(n));
    expect(persistedMapStateSchema.safeParse({ ...state, layers: many.slice(0, mapsConfig.maxLayers) }).success).toBe(true);
    expect(persistedMapStateSchema.safeParse({ ...state, layers: many }).success).toBe(false);
    for (const id of ['', 'l1', 'L', 'L1x', '1', `L${'1'.repeat(styleConfig.maxLayerIdChars)}`]) {
      expect(persistedMapStateSchema.safeParse({ ...state, layers: [{ ...layer(1), id }] }).success, id).toBe(false);
    }
    const sqlOf = (length: number) => ({ ...state, layers: [{ ...layer(1), sql: 'x'.repeat(length) }] });
    expect(persistedMapStateSchema.safeParse(sqlOf(queryConfig.maxSqlChars)).success).toBe(true);
    expect(persistedMapStateSchema.safeParse(sqlOf(queryConfig.maxSqlChars + 1)).success).toBe(false);
    expect(persistedMapStateSchema.safeParse(sqlOf(0)).success).toBe(false);
    expect(persistedMapStateSchema.safeParse({ ...state, layers: [layer(1), layer(1)] }).success).toBe(false);
  });

  it('bounds the view and the layer counter', () => {
    for (const view of [{ center: [181, 0], zoom: 5 }, { center: [0, 91], zoom: 5 }, { center: [0, 0], zoom: styleConfig.zoom.max + 1 }, { center: [0, 0] }]) {
      expect(persistedMapStateSchema.safeParse({ ...state, view }).success, JSON.stringify(view)).toBe(false);
    }
    for (const nextLayerSeq of [-1, 1.5, '3']) {
      expect(persistedMapStateSchema.safeParse({ ...state, nextLayerSeq }).success, String(nextLayerSeq)).toBe(false);
    }
  });
});

describe('mapTitleSchema', () => {
  it('takes 1 to 80 characters (code points), not blank', () => {
    expect(mapTitleSchema.safeParse('a').success).toBe(true);
    expect(mapTitleSchema.safeParse('あ'.repeat(mapsConfig.title.maxChars)).success).toBe(true);
    expect(mapTitleSchema.safeParse('😀'.repeat(mapsConfig.title.maxChars)).success).toBe(true);
    expect(mapTitleSchema.safeParse('a'.repeat(mapsConfig.title.maxChars + 1)).success).toBe(false);
    expect(mapTitleSchema.safeParse('😀'.repeat(mapsConfig.title.maxChars + 1)).success).toBe(false);
    for (const title of ['', '  ', '\n']) expect(mapTitleSchema.safeParse(title).success, JSON.stringify(title)).toBe(false);
  });
});

describe('savedMapSchema', () => {
  const saved = { mapId: '3f2b8c1e-5d4a-4b7e-9c1d-2a6f8e0b1c3d', title: 'T', state, updatedAt: 1 };

  it('accepts a map with or without a conversation id', () => {
    expect(savedMapSchema.safeParse(saved).success).toBe(true);
    expect(savedMapSchema.safeParse({ ...saved, conversationId: '9a7c1d2e-8b3f-4c6a-a1e5-0d4b7f2c9e18' }).success).toBe(true);
  });

  it('refuses a map without a valid state', () => {
    expect(savedMapSchema.safeParse({ ...saved, state: undefined }).success).toBe(false);
    expect(savedMapSchema.safeParse({ ...saved, state: { ...state, version: 0 } }).success).toBe(false);
  });
});
