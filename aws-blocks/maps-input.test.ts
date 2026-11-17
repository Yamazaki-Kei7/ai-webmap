import { describe, expect, it } from 'vitest';
import { mapsConfig, queryConfig } from '../shared/config';
import type { PersistedMapState } from '../shared/persistedMap';
import { layerIdOfSqlNotAllowed } from '../shared/maps';
import { checkMapId, checkSaveMap, type SaveMapInput } from './maps-input';

const layer = (n: number, sql = 'SELECT 1'): PersistedMapState['layers'][number] => ({
  id: `L${n}`,
  name: `Layer ${n}`,
  sql,
  style: { type: 'single', color: '#1f78b4' },
  label: null,
  visible: true
});

/** A SQL the guard accepts, `length` characters long (a string literal of `fill`). */
const sqlOfLength = (length: number, fill = 'x'): string => `SELECT '${fill.repeat(length - 'SELECT '.length - 2)}'`;

const state: PersistedMapState = { version: 1, view: { center: [139.7, 35.7], zoom: 9 }, layers: [layer(1)], nextLayerSeq: 2 };
const input: SaveMapInput = { title: 'My map', state };
const mapId = '3f2b8c1e-5d4a-4b7e-9c1d-2a6f8e0b1c3d';
const conversationId = '9a7c1d2e-8b3f-4c6a-a1e5-0d4b7f2c9e18';

function failure(value: SaveMapInput): string {
  const checked = checkSaveMap(value);
  if (checked.ok) throw new Error('expected a failed check');
  return checked.message;
}

describe('checkSaveMap', () => {
  it('passes a valid input, with the state as the JSON that is stored', () => {
    const checked = checkSaveMap({ ...input, mapId, conversationId, expectedUpdatedAt: 1_700 });
    expect(checked).toEqual({ ok: true, value: { mapId, title: 'My map', state, stateJson: JSON.stringify(state), conversationId, expectedUpdatedAt: 1_700 } });
  });

  it('needs the version for an update, and refuses one for a new map', () => {
    expect(failure({ ...input, mapId })).toBe('An update needs expectedUpdatedAt');
    expect(failure({ ...input, expectedUpdatedAt: 5 })).toBe('A new map has no expectedUpdatedAt');
  });

  it('refuses a version that is not a non-negative integer', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(failure({ ...input, mapId, expectedUpdatedAt: bad }), String(bad)).toBe('Invalid expectedUpdatedAt');
    // @ts-expect-error — deliberately outside the type
    expect(failure({ ...input, mapId, expectedUpdatedAt: '5' })).toBe('Invalid expectedUpdatedAt');
  });

  it('leaves out the map id and the conversation id that were not given', () => {
    const checked = checkSaveMap(input);
    expect(checked.ok && Object.keys(checked.value).sort()).toEqual(['state', 'stateJson', 'title']);
  });

  it('refuses a malformed map id, naming it', () => {
    for (const id of ['', 'L1', '../x', `${mapId}x`]) expect(failure({ ...input, mapId: id }), id).toBe('Invalid map id');
  });

  it('refuses a conversation id that is not a UUID, before anything else, naming it', () => {
    for (const id of ['', 'c', '../x', `${conversationId}x`]) {
      expect(failure({ ...input, conversationId: id, title: '' }), id).toBe('Invalid conversation id');
    }
  });

  it('refuses a layer whose SQL the guard rejects, naming the layer and not echoing the SQL', () => {
    const bad = 'DROP TABLE schools';
    const message = failure({ ...input, state: { ...state, layers: [layer(1), layer(7, bad)] } });
    expect(message).toBe('The SQL of layer L7 is not allowed');
    expect(layerIdOfSqlNotAllowed(message)).toBe('L7');
    expect(message).not.toContain(bad);
  });

  it('refuses a bad title, with the bounds in the message and no echo', () => {
    for (const title of ['', '   ', 'a'.repeat(mapsConfig.title.maxChars + 1)]) {
      const message = failure({ ...input, title });
      expect(message).toBe(`The title must be ${mapsConfig.title.minChars} to ${mapsConfig.title.maxChars} characters`);
    }
  });

  it('refuses more layers than the limit, and the layer of a bad id or SQL length as an invalid state', () => {
    const many = Array.from({ length: mapsConfig.maxLayers + 1 }, (_, n) => layer(n));
    expect(failure({ ...input, state: { ...state, layers: many } })).toBe(`A map has at most ${mapsConfig.maxLayers} layers`);
    expect(failure({ ...input, state: { ...state, layers: [{ ...layer(1), id: 'x' }] } })).toBe('Invalid map state');
    expect(failure({ ...input, state: { ...state, layers: [layer(1, 'x'.repeat(queryConfig.maxSqlChars + 1))] } })).toBe('Invalid map state');
  });

  it('refuses a state over the byte limit, and accepts one at it', () => {
    // Each layer is within its bounds; together they are over `maxStateBytes`.
    const layers = Array.from({ length: mapsConfig.maxLayers }, (_, n) => layer(n, sqlOfLength(queryConfig.maxSqlChars)));
    expect(JSON.stringify({ ...state, layers }).length).toBeGreaterThan(mapsConfig.maxStateBytes);
    expect(failure({ ...input, state: { ...state, layers } })).toBe('The map is too large');
    const fits = Array.from({ length: 6 }, (_, n) => layer(n, sqlOfLength(queryConfig.maxSqlChars)));
    expect(JSON.stringify({ ...state, layers: fits }).length).toBeLessThanOrEqual(mapsConfig.maxStateBytes);
    expect(checkSaveMap({ ...input, state: { ...state, layers: fits } }).ok).toBe(true);
  });

  it('counts the bytes, not the characters', () => {
    // 3 bytes per character: under the limit in characters, over it in bytes.
    const layers = Array.from({ length: 4 }, (_, n) => layer(n, sqlOfLength(queryConfig.maxSqlChars, 'あ')));
    expect(JSON.stringify({ ...state, layers }).length).toBeLessThan(mapsConfig.maxStateBytes);
    expect(failure({ ...input, state: { ...state, layers } })).toBe('The map is too large');
  });

  it('refuses input that is not an object, or has no state', () => {
    // @ts-expect-error — deliberately outside the type
    expect(failure(null)).toBe('Invalid request');
    // @ts-expect-error — deliberately outside the type
    expect(failure({ title: 'x' })).toBe('Invalid map state');
  });

  it('does not keep a key the schema does not know at the top level', () => {
    // @ts-expect-error — deliberately outside the type
    const checked = checkSaveMap({ ...input, userId: 'someone-else' });
    expect(checked.ok && 'userId' in checked.value).toBe(false);
  });
});

describe('checkMapId', () => {
  it('passes a UUID and refuses anything else', () => {
    expect(checkMapId(mapId)).toEqual({ ok: true, value: mapId });
    for (const id of ['', 'L1', 'a'.repeat(10_000)]) expect(checkMapId(id).ok).toBe(false);
  });
});
