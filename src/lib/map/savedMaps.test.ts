import { describe, expect, it } from 'vitest';
import { mapsConfig } from '../../../shared/config';
import { conversationErrors } from '../../../shared/conversation';
import { layerIdOfSqlNotAllowed, mapsErrors, sqlNotAllowedMessage } from '../../../shared/maps';
import { persistedMapVersion, type PersistedMapState } from '../../../shared/persistedMap';
import type { PersistResult } from './persist.svelte';
import { fill, formatUpdatedAt, hasUnsavedChanges, newestFirst, openErrorText, persistFailureText, removeErrorText, restoreProgressText, restoreSummaryText, saveErrorText, viewChanged } from './savedMaps';

const named = (name: string, message = 'x'): Error => Object.assign(new Error(message), { name });

const state = (overrides: Partial<PersistedMapState> = {}): PersistedMapState => ({
  version: persistedMapVersion,
  view: { center: [138, 36], zoom: 7 },
  layers: [{ id: 'L1', name: '駅', sql: 'SELECT 1', style: { type: 'single', color: '#112233' }, label: null, visible: true }],
  nextLayerSeq: 2,
  ...overrides
});
const ok = (next: PersistedMapState): PersistResult => ({ ok: true, state: next });

describe('fill', () => {
  it('fills every occurrence of each name', () => {
    expect(fill('{a} と {a} と {b}', { a: 'x', b: 3 })).toBe('x と x と 3');
  });
});

describe('viewChanged', () => {
  const base = state().view;
  it('is not a change to pan or zoom a little', () => {
    expect(viewChanged({ center: [138.05, 36.05], zoom: 7.1 }, base)).toBe(false);
    expect(viewChanged(base, base)).toBe(false);
  });
  it('is a change to zoom by the threshold or more, either way', () => {
    expect(viewChanged({ ...base, zoom: base.zoom + mapsConfig.unsavedViewChange.zoomLevels }, base)).toBe(true);
    expect(viewChanged({ ...base, zoom: base.zoom - mapsConfig.unsavedViewChange.zoomLevels }, base)).toBe(true);
  });
  it('is a change to move the centre by a quarter tile or more, in either axis; a tile is smaller the closer the map is', () => {
    const { centerTiles } = mapsConfig.unsavedViewChange;
    expect(centerTiles).toBe(0.25);
    const quarter = (360 / 2 ** base.zoom) * centerTiles;
    expect(viewChanged({ ...base, center: [138 + quarter * 1.1, 36] }, base)).toBe(true);
    expect(viewChanged({ ...base, center: [138, 36 - quarter * 1.1] }, base)).toBe(true);
    expect(viewChanged({ ...base, center: [138 + quarter * 0.9, 36] }, base)).toBe(false);
    const near = { center: [138, 36] as [number, number], zoom: 14 };
    expect(viewChanged({ ...near, center: [138 + (360 / 2 ** 14) * centerTiles * 1.1, 36] }, near)).toBe(true);
  });
});

describe('hasUnsavedChanges', () => {
  it('is false for the state that was saved, and for the empty map of a new page', () => {
    expect(hasUnsavedChanges(ok(state()), state())).toBe(false);
    expect(hasUnsavedChanges(ok(state({ layers: [] })), null)).toBe(false);
  });
  it('is true for a map with layers that was never saved', () => {
    expect(hasUnsavedChanges(ok(state()), null)).toBe(true);
  });
  it('counts any change of a layer: added, removed, name, SQL, style, label, visibility, order', () => {
    const saved = state();
    const [layer] = saved.layers;
    const changes: PersistedMapState['layers'][] = [
      [layer, { ...layer, id: 'L2' }],
      [],
      [{ ...layer, name: '別名' }],
      [{ ...layer, sql: 'SELECT 2' }],
      [{ ...layer, style: { type: 'single', color: '#ffffff' } }],
      [{ ...layer, label: { column: 'name' } }],
      [{ ...layer, visible: false }]
    ];
    for (const layers of changes) expect(hasUnsavedChanges(ok(state({ layers })), saved), JSON.stringify(layers)).toBe(true);
    const two = state({ layers: [layer, { ...layer, id: 'L2' }] });
    expect(hasUnsavedChanges(ok(state({ layers: [two.layers[1], two.layers[0]] })), two)).toBe(true);
  });
  it('does not count the next layer number (a layer added and removed again moves it)', () => {
    expect(hasUnsavedChanges(ok(state({ nextLayerSeq: 9 })), state())).toBe(false);
  });
  it('counts the view only beyond the threshold', () => {
    expect(hasUnsavedChanges(ok(state({ view: { center: [138.02, 36.01], zoom: 7.2 } })), state())).toBe(false);
    expect(hasUnsavedChanges(ok(state({ view: { center: [138, 36], zoom: 9 } })), state())).toBe(true);
  });
  it('is true for a map that cannot be saved as it is', () => {
    expect(hasUnsavedChanges({ ok: false, reason: 'tooManyLayers', message: '' }, state())).toBe(true);
    expect(hasUnsavedChanges({ ok: false, reason: 'invalid', message: '' }, null)).toBe(true);
  });
});

describe('error texts', () => {
  it('names the save failures in Japanese, by error name', () => {
    expect(saveErrorText(named(mapsErrors.Conflict))).toBe('別の画面でこの地図が変更されました。開き直してから保存してください');
    expect(saveErrorText(named(mapsErrors.LimitReached))).toBe(`保存できる地図の数（上限 ${mapsConfig.maxMapsPerUser} 件）に達しました。不要な地図を削除してください`);
    expect(saveErrorText(named(mapsErrors.NotFound))).toBe('この地図は削除されています。新しい地図として保存しますか');
    expect(saveErrorText(named(conversationErrors.NotFound))).toContain('会話が見つかりません');
  });
  it('adds the layer a 400 names', () => {
    // The message is the one the backend writes (`sqlNotAllowedMessage`), read back by the same module.
    expect(saveErrorText(named(mapsErrors.InvalidRequest, sqlNotAllowedMessage('L3')))).toBe('保存できない内容が含まれています（レイヤー L3）');
    expect(saveErrorText(named(mapsErrors.InvalidRequest, 'Invalid map state'))).toBe('保存できない内容が含まれています');
    expect(saveErrorText(named(mapsErrors.Conflict, sqlNotAllowedMessage('L3')))).not.toContain('L3');
    expect(layerIdOfSqlNotAllowed(sqlNotAllowedMessage('L12'))).toBe('L12');
    expect(layerIdOfSqlNotAllowed('A map has at most 20 layers')).toBeUndefined();
    expect(layerIdOfSqlNotAllowed(`${sqlNotAllowedMessage('L1')} and more`)).toBeUndefined();
  });
  it('shows a generic message for a network or unknown failure, never its own text', () => {
    for (const failure of [named('TypeError', 'Failed to fetch https://x/y?sig=secret'), named('Whatever'), null]) {
      const message = saveErrorText(failure);
      expect(message).toBe(mapsConfig.text.errors.save.generic);
      expect(message).not.toMatch(/secret|fetch/);
    }
  });
  it('names the open and delete failures', () => {
    expect(openErrorText(named(mapsErrors.NotFound))).toContain('見つかりません');
    expect(openErrorText(named(mapsErrors.Corrupt))).toContain('壊れて');
    expect(openErrorText(named('TypeError'))).toBe(mapsConfig.text.errors.open.generic);
    expect(removeErrorText(named(mapsErrors.NotFound))).toContain('すでに削除');
    expect(removeErrorText(null)).toBe(mapsConfig.text.errors.remove.generic);
  });
  it('says why a state cannot be saved, without the schema error', () => {
    expect(persistFailureText('tooManyLayers')).toBe(`レイヤーが多すぎるため保存できません（上限 ${mapsConfig.maxLayers} 枚）`);
    expect(persistFailureText('invalid')).toBe(mapsConfig.text.saveDialog.invalid);
  });
});

describe('list and progress texts', () => {
  it('sorts the maps newest first', () => {
    const maps = [
      { mapId: 'a', title: 'a', updatedAt: 1 },
      { mapId: 'b', title: 'b', updatedAt: 3 },
      { mapId: 'c', title: 'c', updatedAt: 2 }
    ];
    expect(newestFirst(maps).map(({ mapId }) => mapId)).toEqual(['b', 'c', 'a']);
    expect(maps[0].mapId).toBe('a');
  });
  it('formats a time in the Japanese format', () => {
    expect(formatUpdatedAt(Date.UTC(2026, 10, 18, 3, 4))).toMatch(/^2026\/11\/(18|19) \d{1,2}:\d{2}$/);
  });
  it('says the progress and the layers that stayed behind', () => {
    expect(restoreProgressText({ done: 2, total: 5 })).toBe('地図を復元しています（2/5）');
    expect(restoreSummaryText(0)).toBeNull();
    expect(restoreSummaryText(3)).toBe('3 枚のレイヤーを復元できませんでした');
  });
});
