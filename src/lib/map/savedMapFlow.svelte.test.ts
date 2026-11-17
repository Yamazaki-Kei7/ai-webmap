import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mapConfig, mapsConfig } from '../../../shared/config';
import { conversationErrors } from '../../../shared/conversation';
import { mapsErrors } from '../../../shared/maps';
import { persistedMapVersion, type PersistedMapState, type SavedMap } from '../../../shared/persistedMap';
import type { ToolErrorCode } from '../../../shared/toolProtocol';
import type { ChatSession } from '../chat/chatSession.svelte';
import type { LayerQueryResult } from '../duckdb/queryTypes';
import { addLayer, layerIds, mapState, resetMapState, setView } from './mapState.svelte';
import { restoreMap } from './persist.svelte';
import { clearCurrentMap, createMapFlow, currentMap, type MapFlow, type MapFlowDeps, type MapsApi } from './savedMapFlow.svelte';

const mapId = '11111111-1111-4111-8111-111111111111';
const conversationId = '22222222-2222-4222-8222-222222222222';

const data: LayerQueryResult = {
  features: { type: 'FeatureCollection', features: [{ type: 'Feature', id: 0, geometry: { type: 'Point', coordinates: [139, 35] }, properties: { name: 'a' } }] },
  geometryType: 'point',
  columns: [{ name: 'name', type: 'string' }],
  featureCount: 1,
  bbox: [139, 35, 139, 35]
};

const placed = (name = '駅'): void => {
  const added = addLayer({ name, sql: 'SELECT 1' }, data);
  if (!added.ok) throw new Error(added.error.message);
};

const named = (name: string, message = 'x'): Error => Object.assign(new Error(message), { name });

function savedState(layers = 2): PersistedMapState {
  return {
    version: persistedMapVersion,
    view: { center: [138.5, 36.25], zoom: 7.5 },
    layers: Array.from({ length: layers }, (_, index) => ({
      id: `L${index + 1}`,
      name: `レイヤー${index + 1}`,
      sql: `SELECT ${index + 1}`,
      style: { type: 'single' as const, color: '#112233' },
      label: null,
      visible: true
    })),
    nextLayerSeq: layers + 1
  };
}

const savedMap = (state: PersistedMapState, withConversation = true): SavedMap => ({
  mapId,
  title: '保存した地図',
  state,
  ...(withConversation ? { conversationId } : {}),
  updatedAt: 1_000
});

type Setup = {
  flow: MapFlow;
  events: string[];
  api: { [K in keyof MapsApi]: ReturnType<typeof vi.fn<MapsApi[K]>> };
  chat: { conversationId: string | null; openConversation: ReturnType<typeof vi.fn<ChatSession['openConversation']>>; reset: ReturnType<typeof vi.fn<ChatSession['reset']>> };
  jumpTo: ReturnType<typeof vi.fn<MapFlowDeps['jumpTo']>>;
};

function setup(options: { failQuery?: string; conversation?: Awaited<ReturnType<ChatSession['openConversation']>>; cameraSettlesAt?: { lng: number; lat: number; zoom: number } } = {}): Setup {
  const events: string[] = [];
  let versions = 0;
  const api: Setup['api'] = {
    // Every save is a newer version: 1000, 2000, …
    saveMap: vi.fn<MapsApi['saveMap']>(async () => ({ mapId, updatedAt: 1_000 * ++versions })),
    listMaps: vi.fn<MapsApi['listMaps']>(async () => ({ maps: [] })),
    getMap: vi.fn<MapsApi['getMap']>(async () => savedMap(savedState())),
    deleteMap: vi.fn<MapsApi['deleteMap']>(async () => ({ success: true }))
  };
  const chat: Setup['chat'] = {
    conversationId: null,
    openConversation: vi.fn<ChatSession['openConversation']>(async (id) => {
      events.push(`openConversation ${id}`);
      return options.conversation ?? 'opened';
    }),
    reset: vi.fn<ChatSession['reset']>(() => {
      events.push('reset');
    })
  };
  const jumpTo = vi.fn<MapFlowDeps['jumpTo']>();
  // The camera may not reach the view it is sent to (the zoom limits of the map): it reports where it stopped.
  const settle = options.cameraSettlesAt;
  const camera: MapFlowDeps['jumpTo'] = (center, zoom) => {
    jumpTo(center, zoom);
    if (settle) setView({ lng: settle.lng, lat: settle.lat }, settle.zoom);
  };
  const flow = createMapFlow({
    api,
    chat: () => chat,
    jumpTo: camera,
    restore: (state) =>
      restoreMap(state, {
        queryLayer: async (sql) => {
          events.push(`query ${sql}`);
          const code: ToolErrorCode = 'SQL_ERROR';
          return sql === options.failQuery ? { ok: false, error: { code, message: 'boom' } } : { ok: true, data };
        },
        jumpTo: camera
      })
  });
  return { flow, events, api, chat, jumpTo };
}

beforeEach(() => {
  resetMapState();
  clearCurrentMap();
});

describe('save', () => {
  it('creates a map the first time, with the title, the state and the conversation, and then the map is not unsaved', async () => {
    const { flow, api, chat } = setup();
    placed();
    chat.conversationId = conversationId;
    expect(flow.unsaved).toBe(true);
    expect(await flow.save('東京の駅')).toEqual({ ok: true });
    const [input] = api.saveMap.mock.calls[0];
    expect(input).toMatchObject({ title: '東京の駅', conversationId });
    expect(input).not.toHaveProperty('mapId');
    expect(input.state.layers).toHaveLength(1);
    expect(flow.mapId).toBe(mapId);
    expect(flow.title).toBe('東京の駅');
    expect(flow.unsaved).toBe(false);
  });

  it('updates the same map the next time, naming the version the last save made (and the conversation of that moment), and a change is unsaved again', async () => {
    const { flow, api, chat } = setup();
    placed();
    await flow.save('一回目');
    chat.conversationId = conversationId;
    placed('二枚目');
    expect(flow.unsaved).toBe(true);
    await flow.save('二回目');
    expect(api.saveMap.mock.calls[1][0]).toMatchObject({ mapId, title: '二回目', conversationId, expectedUpdatedAt: 1_000 });
    expect(flow.unsaved).toBe(false);
    await flow.save('三回目');
    expect(api.saveMap.mock.calls[2][0]).toMatchObject({ mapId, expectedUpdatedAt: 2_000 });
  });

  it('names no version for a new map', async () => {
    const { flow, api } = setup();
    await flow.save('新規');
    expect(api.saveMap.mock.calls[0][0]).not.toHaveProperty('expectedUpdatedAt');
    expect(api.saveMap.mock.calls[0][0]).not.toHaveProperty('mapId');
  });

  it('names the version of the map it opened when the opened map is saved', async () => {
    const { flow, api } = setup();
    await flow.open(mapId);
    await flow.save('開いた地図');
    expect(api.saveMap.mock.calls[0][0]).toMatchObject({ mapId, expectedUpdatedAt: savedMap(savedState()).updatedAt });
  });

  it('sends no conversation when the chat has none', async () => {
    const { flow, api } = setup();
    await flow.save('空');
    expect(api.saveMap.mock.calls[0][0]).not.toHaveProperty('conversationId');
  });

  it('refuses a map of too many layers before any call, with the limit in the message', async () => {
    const { flow, api } = setup();
    for (let index = 0; index <= mapsConfig.maxLayers; index++) placed(`l${index}`);
    expect(await flow.save('多い')).toEqual({ ok: false, message: `レイヤーが多すぎるため保存できません（上限 ${mapsConfig.maxLayers} 枚）` });
    expect(api.saveMap).not.toHaveBeenCalled();
  });

  it('refuses a blank title before any call', async () => {
    const { flow, api } = setup();
    expect(await flow.save('   ')).toMatchObject({ ok: false, message: mapsConfig.text.saveDialog.titleRequired });
    expect(api.saveMap).not.toHaveBeenCalled();
  });

  it('says a conflict in Japanese, offers a new map, keeps the map unsaved and the version it had', async () => {
    const { flow, api } = setup();
    placed();
    await flow.save('最初');
    placed('二枚目');
    api.saveMap.mockRejectedValueOnce(named(mapsErrors.Conflict, 'The map was changed elsewhere'));
    expect(await flow.save('最初')).toEqual({ ok: false, message: '別の画面でこの地図が変更されました。開き直してから保存してください', offerNew: true });
    expect(flow.unsaved).toBe(true);
    expect(flow.mapId).toBe(mapId);
    expect(currentMap.stored).toEqual({ mapId, updatedAt: 1_000 });
  });

  it('saves the content as a new map after a conflict, without the old id or version, and then follows the new map', async () => {
    const { flow, api } = setup();
    placed();
    await flow.save('最初');
    api.saveMap.mockRejectedValueOnce(named(mapsErrors.Conflict));
    await flow.save('最初');
    api.saveMap.mockResolvedValueOnce({ mapId: '33333333-3333-4333-8333-333333333333', updatedAt: 7_000 });
    expect(await flow.save('最初 のコピー', { asNew: true })).toEqual({ ok: true });
    const input = api.saveMap.mock.calls[2][0];
    expect(input).not.toHaveProperty('mapId');
    expect(input).not.toHaveProperty('expectedUpdatedAt');
    await flow.save('次');
    expect(api.saveMap.mock.calls[3][0]).toMatchObject({ mapId: '33333333-3333-4333-8333-333333333333', expectedUpdatedAt: 7_000 });
  });

  it('refuses a second save while one runs, so that the map is not created twice', async () => {
    const { flow, api } = setup();
    placed();
    let release: () => void = () => undefined;
    api.saveMap.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return { mapId, updatedAt: 1_000 };
    });
    const first = flow.save('一つ目');
    expect(flow.saving).toBe(true);
    expect(await flow.save('二つ目')).toEqual({ ok: false, message: null });
    release();
    expect(await first).toEqual({ ok: true });
    expect(flow.saving).toBe(false);
    expect(api.saveMap).toHaveBeenCalledOnce();
    expect(flow.title).toBe('一つ目');
  });

  it('is not saving after a failed save either', async () => {
    const { flow, api } = setup();
    placed();
    api.saveMap.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await flow.save('x');
    expect(flow.saving).toBe(false);
  });

  it('offers to save a deleted map as a new one, and that creates it', async () => {
    const { flow, api } = setup();
    placed();
    await flow.save('最初');
    api.saveMap.mockRejectedValueOnce(named(mapsErrors.NotFound));
    expect(await flow.save('最初')).toEqual({ ok: false, message: 'この地図は削除されています。新しい地図として保存しますか', offerNew: true });
    api.saveMap.mockResolvedValueOnce({ mapId: '33333333-3333-4333-8333-333333333333', updatedAt: 2 });
    expect(await flow.save('最初', { asNew: true })).toEqual({ ok: true });
    expect(api.saveMap.mock.calls[2][0]).not.toHaveProperty('mapId');
    expect(flow.mapId).toBe('33333333-3333-4333-8333-333333333333');
  });

  it('says the other failures by name, and a lost connection generically', async () => {
    const { flow, api } = setup();
    placed();
    api.saveMap.mockRejectedValueOnce(named(mapsErrors.LimitReached));
    expect(await flow.save('a')).toMatchObject({ message: expect.stringContaining('上限') });
    api.saveMap.mockRejectedValueOnce(named(conversationErrors.NotFound));
    expect(await flow.save('a')).toMatchObject({ message: expect.stringContaining('会話') });
    api.saveMap.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await flow.save('a')).toEqual({ ok: false, message: mapsConfig.text.errors.save.generic });
    expect(flow.mapId).toBeNull();
  });

  it('tells nobody what a sign-out overtook, and changes nothing', async () => {
    const { flow, api } = setup();
    placed();
    api.saveMap.mockImplementationOnce(async () => {
      resetMapState();
      return { mapId, updatedAt: 1 };
    });
    expect(await flow.save('x')).toEqual({ ok: false, message: null });
    expect(flow.mapId).toBeNull();
  });
});

describe('open', () => {
  it('opens the conversation first and rebuilds the layers after it', async () => {
    const { flow, events } = setup();
    expect(await flow.open(mapId)).toEqual({ ok: true, failedLayers: 0 });
    expect(events).toEqual([`openConversation ${conversationId}`, 'query SELECT 1', 'query SELECT 2']);
    expect(layerIds()).toEqual(['L1', 'L2']);
  });

  it('starts a new conversation for a map that has none', async () => {
    const { flow, api, events } = setup();
    api.getMap.mockResolvedValueOnce(savedMap(savedState(1), false));
    await flow.open(mapId);
    expect(events).toEqual(['reset', 'query SELECT 1']);
  });

  it('keeps the stored conversation through a save when it could not be loaded (not for good), and prefers the chat\'s own once it has one', async () => {
    const { flow, api, chat } = setup({ conversation: 'failed' });
    await flow.open(mapId);
    await flow.save('保存');
    expect(api.saveMap.mock.calls[0][0]).toMatchObject({ conversationId });
    chat.conversationId = '44444444-4444-4444-8444-444444444444';
    await flow.save('保存2');
    expect(api.saveMap.mock.calls[1][0]).toMatchObject({ conversationId: '44444444-4444-4444-8444-444444444444' });
  });

  it('lets go of the stored conversation when it is gone for good (the server would refuse the save)', async () => {
    const { flow, api } = setup({ conversation: 'notFound' });
    await flow.open(mapId);
    await flow.save('保存');
    expect(api.saveMap.mock.calls[0][0]).not.toHaveProperty('conversationId');
  });

  it('does not keep a conversation that was opened', async () => {
    const { flow, api } = setup();
    await flow.open(mapId);
    await flow.save('保存');
    expect(api.saveMap.mock.calls[0][0]).not.toHaveProperty('conversationId');
  });

  it('measures the unsaved changes from what the map came out as, not from what was stored (the camera may not reach the saved view)', async () => {
    const { flow } = setup({ cameraSettlesAt: { lng: 138.5, lat: 36.25, zoom: 6 } });
    await flow.open(mapId);
    expect(mapState.view.zoom).toBe(6);
    expect(flow.unsaved).toBe(false);
  });

  it('shows no unsaved changes while it opens', async () => {
    const { flow, api } = setup();
    placed();
    expect(flow.unsaved).toBe(true);
    let release: () => void = () => undefined;
    api.getMap.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return savedMap(savedState());
    });
    const opening = flow.open(mapId);
    expect(flow.unsaved).toBe(false);
    release();
    await opening;
  });

  it('makes it the map shown, not unsaved, with the view of the saved map', async () => {
    const { flow, jumpTo } = setup();
    placed('old');
    expect(await flow.open(mapId)).toMatchObject({ ok: true });
    expect(flow.mapId).toBe(mapId);
    expect(flow.title).toBe('保存した地図');
    expect(flow.unsaved).toBe(false);
    expect(mapState.view).toEqual({ center: [138.5, 36.25], zoom: 7.5 });
    expect(jumpTo).toHaveBeenCalledWith([138.5, 36.25], 7.5);
  });

  it('counts the layers that stayed behind, and the map is still the opened one', async () => {
    const { flow } = setup({ failQuery: 'SELECT 2' });
    expect(await flow.open(mapId)).toEqual({ ok: true, failedLayers: 1 });
    expect(flow.unsaved).toBe(false);
    expect(mapState.layers.map(({ id, status }) => `${id}:${status}`)).toEqual(['L1:ready', 'L2:error']);
  });

  it('is busy while it opens', async () => {
    const { flow, api } = setup();
    let release: () => void = () => undefined;
    api.getMap.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return savedMap(savedState());
    });
    const opening = flow.open(mapId);
    expect(flow.opening).toBe(true);
    release();
    await opening;
    expect(flow.opening).toBe(false);
  });

  it('says a missing, corrupt or unreachable map in Japanese and touches neither the chat nor the map', async () => {
    const { flow, api, chat } = setup();
    placed('mine');
    const mine = layerIds();
    for (const [failure, expected] of [
      [named(mapsErrors.NotFound), 'この地図は見つかりません。削除された可能性があります'],
      [named(mapsErrors.Corrupt), 'この地図は壊れていて開けません'],
      [new TypeError('Failed to fetch'), mapsConfig.text.errors.open.generic]
    ] as const) {
      api.getMap.mockRejectedValueOnce(failure);
      expect(await flow.open(mapId)).toEqual({ ok: false, message: expected });
    }
    expect(chat.openConversation).not.toHaveBeenCalled();
    expect(chat.reset).not.toHaveBeenCalled();
    expect(layerIds()).toEqual(mine);
  });

  it('refuses a state the browser cannot use before it touches the chat or the map', async () => {
    const { flow, api, chat } = setup();
    placed('mine');
    const mine = layerIds();
    // A state of another version: built from text, the way it would come from storage.
    const otherVersion: SavedMap['state'] = JSON.parse(JSON.stringify(savedState()).replace(`"version":${persistedMapVersion}`, '"version":9'));
    api.getMap.mockResolvedValueOnce({ ...savedMap(savedState()), state: otherVersion });
    expect(await flow.open(mapId)).toEqual({ ok: false, message: mapsConfig.text.errors.open.invalidState });
    expect(chat.openConversation).not.toHaveBeenCalled();
    expect(layerIds()).toEqual(mine);
    expect(flow.mapId).toBeNull();
  });

  it('does not bring a map back after the user started a new one meanwhile', async () => {
    const { flow, api } = setup();
    let release: () => void = () => undefined;
    api.getMap.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return savedMap(savedState());
    });
    const opening = flow.open(mapId);
    flow.startNew();
    release();
    expect(await opening).toEqual({ ok: false, message: null });
    expect(layerIds()).toEqual([]);
    expect(flow.opening).toBe(false);
  });
});

describe('startNew', () => {
  it('empties the map, starts a new conversation, forgets the map shown, and goes back to the first view', async () => {
    const { flow, chat, jumpTo } = setup();
    placed();
    setView({ lng: 140, lat: 40 }, 9);
    await flow.save('保存済み');
    flow.startNew();
    expect(layerIds()).toEqual([]);
    expect(chat.reset).toHaveBeenCalledOnce();
    expect(flow.mapId).toBeNull();
    expect(flow.title).toBeNull();
    expect(currentMap.stored).toBeNull();
    expect(flow.unsaved).toBe(false);
    const [lng, lat] = mapConfig.initialView.center;
    expect(jumpTo).toHaveBeenCalledWith([lng, lat], mapConfig.initialView.zoom);
    expect(currentMap.saved).toBeNull();
  });

  it('is cleared with the user: no map shown after clearCurrentMap', async () => {
    const { flow } = setup();
    placed();
    await flow.save('x');
    clearCurrentMap();
    expect(flow.mapId).toBeNull();
    expect(flow.title).toBeNull();
  });
});

describe('list and remove', () => {
  it('lists the maps newest first', async () => {
    const { flow, api } = setup();
    api.listMaps.mockResolvedValueOnce({
      maps: [
        { mapId: 'a', title: 'a', updatedAt: 1 },
        { mapId: 'b', title: 'b', updatedAt: 2 }
      ]
    });
    const listed = await flow.list();
    expect(listed.ok && listed.maps.map((entry) => entry.mapId)).toEqual(['b', 'a']);
  });

  it('says a failed list in Japanese', async () => {
    const { flow, api } = setup();
    api.listMaps.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await flow.list()).toEqual({ ok: false, message: mapsConfig.text.errors.list.generic });
  });

  it('deletes a map; the map shown stays on the screen but is not a saved one any more (the next save creates a new map)', async () => {
    const { flow, api } = setup();
    placed();
    await flow.save('x');
    expect(await flow.remove(mapId)).toEqual({ ok: true });
    expect(api.deleteMap).toHaveBeenCalledWith(mapId);
    expect(flow.mapId).toBeNull();
    expect(layerIds()).toHaveLength(1);
    expect(flow.unsaved).toBe(true);
  });

  it('keeps the map shown when another one is deleted, and counts a map that is gone already as deleted', async () => {
    const { flow, api } = setup();
    placed();
    await flow.save('x');
    api.deleteMap.mockRejectedValueOnce(named(mapsErrors.NotFound));
    expect(await flow.remove('44444444-4444-4444-8444-444444444444')).toEqual({ ok: true });
    expect(flow.mapId).toBe(mapId);
  });

  it('says a failed delete in Japanese and keeps everything', async () => {
    const { flow, api } = setup();
    placed();
    await flow.save('x');
    api.deleteMap.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await flow.remove(mapId)).toEqual({ ok: false, message: mapsConfig.text.errors.remove.generic });
    expect(flow.mapId).toBe(mapId);
  });
});
