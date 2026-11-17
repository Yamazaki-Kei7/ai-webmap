import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mapsConfig } from '../../../shared/config';
import { mapsErrors } from '../../../shared/maps';
import { persistedMapVersion, type PersistedMapState, type SavedMap, type SavedMapSummary } from '../../../shared/persistedMap';
import type { LayerQueryResult } from '$lib/duckdb/queryTypes';
import { addLayer, resetMapState } from '$lib/map/mapState.svelte';
import { restoreMap, restoreProgress } from '$lib/map/persist.svelte';
import { clearCurrentMap, createMapFlow, type MapFlow, type MapsApi } from '$lib/map/savedMapFlow.svelte';
import { installDialogStub } from '$lib/test-support/dialog';
import MapBar from './MapBar.svelte';

// The bar and its dialogs are mounted for real (jsdom, with the modal behaviour stubbed); the flow behind them runs on the real
// map state and `restoreMap`, over a fake maps API and a fake chat, so that the wiring (what is asked, in which order, what is shown) is read from the DOM.

const mapId = '11111111-1111-4111-8111-111111111111';
const conversationId = '22222222-2222-4222-8222-222222222222';

const data: LayerQueryResult = {
  features: { type: 'FeatureCollection', features: [{ type: 'Feature', id: 0, geometry: { type: 'Point', coordinates: [139, 35] }, properties: { name: 'a' } }] },
  geometryType: 'point',
  columns: [{ name: 'name', type: 'string' }],
  featureCount: 1,
  bbox: [139, 35, 139, 35]
};

const state: PersistedMapState = {
  version: persistedMapVersion,
  view: { center: [138.5, 36.25], zoom: 7.5 },
  layers: [{ id: 'L1', name: '駅', sql: 'SELECT 1', style: { type: 'single', color: '#112233' }, label: null, visible: true }],
  nextLayerSeq: 2
};

const summaries: SavedMapSummary[] = [
  { mapId, title: '東京の駅', updatedAt: Date.UTC(2026, 10, 18, 3, 0) },
  { mapId: '33333333-3333-4333-8333-333333333333', title: '古い地図', updatedAt: Date.UTC(2026, 10, 1, 3, 0) }
];
const saved: SavedMap = { mapId, title: '東京の駅', state, conversationId, updatedAt: summaries[0].updatedAt };

const events: string[] = [];
const named = (name: string): Error => Object.assign(new Error('x'), { name });

const api = {
  saveMap: vi.fn<MapsApi['saveMap']>(),
  listMaps: vi.fn<MapsApi['listMaps']>(),
  getMap: vi.fn<MapsApi['getMap']>(),
  deleteMap: vi.fn<MapsApi['deleteMap']>()
};
const chat = {
  conversationId: null as string | null,
  openConversation: vi.fn(async (id: string) => {
    events.push(`openConversation ${id}`);
    return 'opened' as const;
  }),
  reset: vi.fn()
};

let release: () => void = () => undefined;

function makeFlow(): MapFlow {
  return createMapFlow({
    api,
    chat: () => chat,
    jumpTo: () => undefined,
    restore: (given) =>
      restoreMap(given, {
        queryLayer: async (sql) => {
          events.push(`query ${sql}`);
          // Held, so that the state while it is rebuilt can be read.
          await new Promise<void>((resolve) => (release = resolve));
          return { ok: true, data };
        },
        jumpTo: () => undefined
      })
  });
}

const mounted: ReturnType<typeof mount>[] = [];

function render(flow: MapFlow, engineReady = true): HTMLElement {
  const target = document.createElement('div');
  document.body.append(target);
  mounted.push(mount(MapBar, { target, props: { flow, engineReady } }));
  flushSync();
  return target;
}

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.querySelector<T>(`[data-testid=${id}]`);
  if (!element) throw new Error(`no ${id}`);
  return element;
};
const maybe = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-testid=${id}]`);
const isOpen = (id: string): boolean => byId<HTMLDialogElement>(id).open;

async function click(id: string): Promise<void> {
  byId(id).click();
  flushSync();
  await tick();
}

function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

const settle = async (): Promise<void> => {
  for (let index = 0; index < 5; index++) await Promise.resolve();
  flushSync();
  await tick();
};

const placed = (name = '駅'): void => {
  const added = addLayer({ name, sql: 'SELECT 1' }, data);
  if (!added.ok) throw new Error(added.error.message);
};

beforeAll(installDialogStub);

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  api.saveMap.mockResolvedValue({ mapId, updatedAt: 1 });
  api.listMaps.mockResolvedValue({ maps: summaries });
  api.getMap.mockResolvedValue(saved);
  api.deleteMap.mockResolvedValue({ success: true });
  chat.openConversation.mockClear();
  chat.reset.mockClear();
});

afterEach(() => {
  for (const component of mounted.splice(0)) void unmount(component);
  document.body.replaceChildren();
  resetMapState();
  clearCurrentMap();
  restoreProgress.current = null;
  events.length = 0;
  chat.conversationId = null;
});

describe('the bar', () => {
  it('shows the three buttons and the title (untitled until saved), with the unsaved mark once the map has layers', async () => {
    render(makeFlow());
    expect(byId('map-save').textContent?.trim()).toBe('保存');
    expect(byId('map-open').textContent?.trim()).toBe('開く');
    expect(byId('map-new').textContent?.trim()).toBe('新規作成');
    expect(byId('map-title').textContent?.trim()).toBe('無題の地図');
    expect(maybe('map-unsaved')).toBeNull();
    placed();
    await settle();
    expect(byId('map-title').textContent).toContain('●');
    expect(byId('map-title').textContent).toContain('保存されていない変更があります');
  });

  it('cannot open a map before the data engine is ready', () => {
    render(makeFlow(), false);
    expect(byId<HTMLButtonElement>('map-open').disabled).toBe(true);
    expect(byId('map-open').getAttribute('title')).toBe(mapsConfig.text.openNeedsEngine);
  });

  it('asks the browser to confirm leaving only while there are unsaved changes', async () => {
    render(makeFlow());
    const leave = (): boolean => !window.dispatchEvent(new Event('beforeunload', { cancelable: true }));
    expect(leave()).toBe(false);
    placed();
    await settle();
    expect(leave()).toBe(true);
    await click('map-save');
    type(byId<HTMLInputElement>('save-title'), '東京の駅');
    await click('save-submit');
    await settle();
    expect(leave()).toBe(false);
  });
});

describe('save dialog', () => {
  it('is disabled, with the reason, when the map has too many layers, and calls nothing', async () => {
    for (let index = 0; index <= mapsConfig.maxLayers; index++) placed(`l${index}`);
    render(makeFlow());
    await click('map-save');
    expect(isOpen('save-dialog')).toBe(true);
    type(byId<HTMLInputElement>('save-title'), '多い');
    expect(byId<HTMLButtonElement>('save-submit').disabled).toBe(true);
    expect(byId('save-blocked').textContent).toBe(`レイヤーが多すぎるため保存できません（上限 ${mapsConfig.maxLayers} 枚）`);
    byId<HTMLFormElement>('save-title').form?.requestSubmit();
    await settle();
    expect(api.saveMap).not.toHaveBeenCalled();
  });

  it('saves under the typed title, closes, says it was saved, and clears the unsaved mark', async () => {
    placed();
    chat.conversationId = conversationId;
    render(makeFlow());
    await click('map-save');
    expect(byId<HTMLInputElement>('save-title').value).toBe('');
    expect(byId<HTMLButtonElement>('save-submit').disabled).toBe(true);
    type(byId<HTMLInputElement>('save-title'), ' 東京の駅 ');
    await click('save-submit');
    await settle();
    expect(api.saveMap.mock.calls[0][0]).toMatchObject({ title: '東京の駅', conversationId });
    expect(isOpen('save-dialog')).toBe(false);
    expect(byId('map-notice').textContent).toBe('保存しました');
    expect(byId('map-title').textContent?.trim()).toBe('東京の駅');
    expect(maybe('map-unsaved')).toBeNull();
  });

  it('prefills the title of the map shown', async () => {
    placed();
    render(makeFlow());
    await click('map-save');
    type(byId<HTMLInputElement>('save-title'), '最初');
    await click('save-submit');
    await settle();
    await click('map-save');
    expect(byId<HTMLInputElement>('save-title').value).toBe('最初');
  });

  it('shows the conflict message and keeps the dialog open', async () => {
    placed();
    render(makeFlow());
    api.saveMap.mockRejectedValueOnce(named(mapsErrors.Conflict));
    await click('map-save');
    type(byId<HTMLInputElement>('save-title'), '東京の駅');
    await click('save-submit');
    await settle();
    expect(byId('save-error').textContent).toBe('別の画面でこの地図が変更されました。開き直してから保存してください');
    expect(isOpen('save-dialog')).toBe(true);
    expect(byId<HTMLButtonElement>('save-submit').disabled).toBe(false);
    expect(maybe('map-notice')?.textContent).toBe('');
  });

  it('offers to save a deleted map as a new one', async () => {
    placed();
    render(makeFlow());
    await click('map-save');
    type(byId<HTMLInputElement>('save-title'), '東京の駅');
    await click('save-submit');
    await settle();
    api.saveMap.mockRejectedValueOnce(named(mapsErrors.NotFound));
    await click('map-save');
    await click('save-submit');
    await settle();
    expect(byId('save-error').textContent).toBe('この地図は削除されています。新しい地図として保存しますか');
    await click('save-as-new');
    await settle();
    expect(api.saveMap.mock.calls[2][0]).not.toHaveProperty('mapId');
    expect(isOpen('save-dialog')).toBe(false);
  });

  it('offers a new map after a conflict, and that saves the content as one', async () => {
    placed();
    render(makeFlow());
    await click('map-save');
    type(byId<HTMLInputElement>('save-title'), '東京の駅');
    await click('save-submit');
    await settle();
    api.saveMap.mockRejectedValueOnce(named(mapsErrors.Conflict));
    await click('map-save');
    await click('save-submit');
    await settle();
    expect(byId('save-error').textContent).toBe('別の画面でこの地図が変更されました。開き直してから保存してください');
    await click('save-as-new');
    await settle();
    expect(api.saveMap.mock.calls[2][0]).not.toHaveProperty('mapId');
    expect(api.saveMap.mock.calls[2][0]).not.toHaveProperty('expectedUpdatedAt');
    expect(isOpen('save-dialog')).toBe(false);
  });

  describe('while a save runs', () => {
    /** A first save of a map that is held until `release`. */
    async function startSave(): Promise<() => void> {
      placed();
      let done: () => void = () => undefined;
      api.saveMap.mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => (done = resolve));
        return { mapId, updatedAt: 1 };
      });
      render(makeFlow());
      await click('map-save');
      type(byId<HTMLInputElement>('save-title'), '東京の駅');
      await click('save-submit');
      return () => done();
    }

    it('refuses Esc and キャンセル, and the buttons are off, so the dialog cannot be left and the map saved twice', async () => {
      const finish = await startSave();
      const escape = new Event('cancel', { cancelable: true });
      byId('save-dialog').dispatchEvent(escape);
      expect(escape.defaultPrevented).toBe(true);
      expect(byId<HTMLButtonElement>('save-cancel').disabled).toBe(true);
      expect(byId<HTMLButtonElement>('save-submit').disabled).toBe(true);
      expect(byId<HTMLButtonElement>('map-save').disabled).toBe(true);
      expect(byId<HTMLButtonElement>('map-open').disabled).toBe(true);
      expect(byId<HTMLButtonElement>('map-new').disabled).toBe(true);
      expect(byId('save-saving').textContent).toBe('保存しています…');
      byId<HTMLFormElement>('save-title').form?.requestSubmit();
      await settle();
      expect(api.saveMap).toHaveBeenCalledOnce();
      finish();
      await settle();
      expect(isOpen('save-dialog')).toBe(false);
      expect(byId<HTMLButtonElement>('map-save').disabled).toBe(false);
    });

    it('shows a failure in the dialog that is still open', async () => {
      placed();
      let fail: (error: Error) => void = () => undefined;
      api.saveMap.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)));
      render(makeFlow());
      await click('map-save');
      type(byId<HTMLInputElement>('save-title'), '東京の駅');
      await click('save-submit');
      fail(named(mapsErrors.Conflict));
      await settle();
      expect(isOpen('save-dialog')).toBe(true);
      expect(byId('save-error').textContent).toContain('別の画面');
      expect(byId<HTMLButtonElement>('save-cancel').disabled).toBe(false);
    });

    it('shows a failure in the bar when the dialog was closed meanwhile (a second Esc closes it in a browser), until the next save is started', async () => {
      placed();
      let fail: (error: Error) => void = () => undefined;
      api.saveMap.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)));
      render(makeFlow());
      await click('map-save');
      type(byId<HTMLInputElement>('save-title'), '東京の駅');
      await click('save-submit');
      // The browser closed it anyway.
      byId<HTMLDialogElement>('save-dialog').close();
      flushSync();
      expect(isOpen('save-dialog')).toBe(false);
      fail(named(mapsErrors.Conflict));
      await settle();
      const shown = byId('map-save-error');
      expect(shown.getAttribute('role')).toBe('alert');
      expect(shown.textContent).toContain('別の画面');
      await click('map-save');
      expect(maybe('map-save-error')).toBeNull();
    });

    it('does not show it in the bar while the dialog is open (it is in the dialog)', async () => {
      placed();
      api.saveMap.mockRejectedValueOnce(named(mapsErrors.Conflict));
      render(makeFlow());
      await click('map-save');
      type(byId<HTMLInputElement>('save-title'), '東京の駅');
      await click('save-submit');
      await settle();
      expect(byId('save-error').textContent).toContain('別の画面');
      expect(maybe('map-save-error')).toBeNull();
    });

    it('lets Esc close the dialog when nothing is saving', () => {
      placed();
      render(makeFlow());
      byId('map-save').click();
      flushSync();
      const escape = new Event('cancel', { cancelable: true });
      byId('save-dialog').dispatchEvent(escape);
      expect(escape.defaultPrevented).toBe(false);
    });
  });

  it('can be opened again after the browser closed it (Esc): the bar learns of the close', async () => {
    render(makeFlow());
    await click('map-save');
    expect(isOpen('save-dialog')).toBe(true);
    // What Esc does in a browser: the dialog closes by itself and says so.
    byId<HTMLDialogElement>('save-dialog').close();
    flushSync();
    await click('map-save');
    expect(isOpen('save-dialog')).toBe(true);
  });

  it('closes without saving on キャンセル', async () => {
    placed();
    render(makeFlow());
    await click('map-save');
    await click('save-cancel');
    expect(isOpen('save-dialog')).toBe(false);
    expect(api.saveMap).not.toHaveBeenCalled();
  });
});

describe('the title while a map opens', () => {
  it('says it is loading, with no unsaved mark, until the map is there', async () => {
    placed();
    render(makeFlow());
    expect(maybe('map-unsaved')).not.toBeNull();
    await click('map-open');
    await settle();
    // The map has unsaved changes: the discard is confirmed first.
    await click('open-item-open');
    await settle();
    await click('discard-open-dialog-confirm');
    await settle();
    expect(byId('map-title').textContent?.trim()).toBe('読み込み中');
    expect(maybe('map-unsaved')).toBeNull();
    release();
    await settle();
    expect(byId('map-title').textContent?.trim()).toBe('東京の駅');
  });
});

describe('open dialog', () => {
  it('lists the maps with their time in the Japanese format, newest first', async () => {
    render(makeFlow());
    await click('map-open');
    await settle();
    const rows = [...document.querySelectorAll('[data-testid=open-item]')];
    expect(rows.map((row) => row.querySelector('[data-testid=open-item-title]')?.textContent)).toEqual(['東京の駅', '古い地図']);
    expect(rows[0].querySelector('[data-testid=open-item-time]')?.textContent).toMatch(/^2026\/11\/\d+ \d+:\d{2}$/);
    expect(rows[0].querySelector('[data-testid=open-item-open]')?.getAttribute('aria-label')).toBe('「東京の駅」を開く');
  });

  it('says so when there are no maps, and when the list cannot be read', async () => {
    api.listMaps.mockResolvedValueOnce({ maps: [] });
    render(makeFlow());
    await click('map-open');
    await settle();
    expect(byId('open-empty').textContent).toBe('保存された地図はありません。');
    await click('open-close');
    api.listMaps.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await click('map-open');
    await settle();
    expect(byId('open-error').textContent).toBe(mapsConfig.text.errors.list.generic);
  });

  it('asks before it throws away unsaved changes, and opens nothing when the answer is no', async () => {
    placed();
    render(makeFlow());
    await click('map-open');
    await settle();
    await click('open-item-open');
    await settle();
    expect(isOpen('discard-open-dialog')).toBe(true);
    expect(byId('discard-open-dialog-message').textContent).toBe('保存されていない変更があります。破棄して開きますか');
    expect(byId('discard-open-dialog-confirm').textContent?.trim()).toBe('破棄して開く');
    expect(api.getMap).not.toHaveBeenCalled();
    await click('discard-open-dialog-cancel');
    expect(isOpen('discard-open-dialog')).toBe(false);
    expect(api.getMap).not.toHaveBeenCalled();
    expect(isOpen('open-dialog')).toBe(true);
  });

  it('does not ask when nothing is unsaved: it opens the conversation first, then rebuilds the layers, with the chat held back meanwhile', async () => {
    render(makeFlow());
    await click('map-open');
    await settle();
    await click('open-item-open');
    await settle();
    expect(isOpen('discard-open-dialog')).toBe(false);
    expect(api.getMap).toHaveBeenCalledWith(mapId);
    expect(events).toEqual([`openConversation ${conversationId}`, 'query SELECT 1']);
    // Rebuilding: the buttons that change the map are off, and the dialog says it is opening.
    expect(restoreProgress.current).toEqual({ done: 0, total: 1 });
    expect(byId<HTMLButtonElement>('map-save').disabled).toBe(true);
    expect(byId<HTMLButtonElement>('map-new').disabled).toBe(true);
    expect(byId('open-opening').textContent).toBe('開いています…');
    release();
    await settle();
    expect(isOpen('open-dialog')).toBe(false);
    expect(byId('map-title').textContent?.trim()).toBe('東京の駅');
    expect(byId<HTMLButtonElement>('map-save').disabled).toBe(false);
  });

  it('opens after a yes to the question about unsaved changes', async () => {
    placed();
    render(makeFlow());
    await click('map-open');
    await settle();
    await click('open-item-open');
    await settle();
    await click('discard-open-dialog-confirm');
    await settle();
    expect(api.getMap).toHaveBeenCalledWith(mapId);
    release();
    await settle();
    expect(isOpen('open-dialog')).toBe(false);
  });

  it('says a map that is gone, and stays open', async () => {
    api.getMap.mockRejectedValueOnce(named(mapsErrors.NotFound));
    render(makeFlow());
    await click('map-open');
    await settle();
    await click('open-item-open');
    await settle();
    expect(byId('open-error').textContent).toBe('この地図は見つかりません。削除された可能性があります');
    expect(isOpen('open-dialog')).toBe(true);
  });

  it('asks before it deletes a map, deletes nothing on キャンセル, and drops the row on 削除する', async () => {
    render(makeFlow());
    await click('map-open');
    await settle();
    await click('open-item-remove');
    expect(isOpen('remove-dialog')).toBe(true);
    expect(byId('remove-dialog-message').textContent).toBe('「東京の駅」を削除しますか。元に戻せません。');
    expect(api.deleteMap).not.toHaveBeenCalled();
    await click('remove-dialog-cancel');
    expect(api.deleteMap).not.toHaveBeenCalled();
    expect(document.querySelectorAll('[data-testid=open-item]')).toHaveLength(2);

    await click('open-item-remove');
    await click('remove-dialog-confirm');
    await settle();
    expect(api.deleteMap).toHaveBeenCalledExactlyOnceWith(mapId);
    expect([...document.querySelectorAll('[data-testid=open-item-title]')].map((title) => title.textContent)).toEqual(['古い地図']);
    expect(byId('open-notice').textContent).toBe('削除しました');
  });
});

describe('new', () => {
  it('starts at once when nothing is unsaved', async () => {
    render(makeFlow());
    await click('map-new');
    expect(isOpen('discard-new-dialog')).toBe(false);
    expect(chat.reset).toHaveBeenCalledOnce();
  });

  it('asks first when there are unsaved changes: no on キャンセル, yes empties the map and starts a new conversation', async () => {
    placed();
    render(makeFlow());
    await click('map-new');
    expect(isOpen('discard-new-dialog')).toBe(true);
    expect(chat.reset).not.toHaveBeenCalled();
    await click('discard-new-dialog-cancel');
    expect(chat.reset).not.toHaveBeenCalled();
    expect(maybe('map-unsaved')).not.toBeNull();

    await click('map-new');
    await click('discard-new-dialog-confirm');
    await settle();
    expect(chat.reset).toHaveBeenCalledOnce();
    expect(byId('map-title').textContent?.trim()).toBe('無題の地図');
    expect(maybe('map-unsaved')).toBeNull();
  });
});
