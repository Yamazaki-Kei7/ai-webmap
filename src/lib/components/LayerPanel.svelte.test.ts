import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { persistedMapVersion, type PersistedMapState } from '../../../shared/persistedMap';
import type { LayerQueryResult } from '$lib/duckdb/queryTypes';
import { layerIds, resetMapState } from '$lib/map/mapState.svelte';
import { restoreMap, restoreProgress } from '$lib/map/persist.svelte';

vi.mock('./narrowViewport', () => ({ narrowViewport: { current: false } }));

const { default: LayerPanel } = await import('./LayerPanel.svelte');

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
  layers: [1, 2, 3].map((n) => ({ id: `L${n}`, name: `レイヤー${n}`, sql: `SELECT ${n}`, style: { type: 'single' as const, color: '#112233' }, label: null, visible: true })),
  nextLayerSeq: 4
};

const mounted: ReturnType<typeof mount>[] = [];

function render(): HTMLElement {
  const target = document.createElement('div');
  document.body.append(target);
  mounted.push(mount(LayerPanel, { target }));
  flushSync();
  return target;
}

const line = (root: HTMLElement, id: string): string | null => root.querySelector(`[data-testid=${id}]`)?.textContent ?? null;

afterEach(() => {
  for (const component of mounted.splice(0)) void unmount(component);
  document.body.replaceChildren();
  resetMapState();
  restoreProgress.current = null;
});

describe('LayerPanel while a saved map comes back', () => {
  it('shows how far the restore is, and no summary until it is over', async () => {
    const root = render();
    expect(line(root, 'restore-progress')).toBeNull();
    // Each query waits for its gate, so that the state between two layers can be read.
    const gates: (() => void)[] = [];
    const restoring = restoreMap(state, {
      queryLayer: async () => {
        await new Promise<void>((resolve) => gates.push(resolve));
        return { ok: true, data };
      },
      jumpTo: () => undefined
    });
    flushSync();
    expect(line(root, 'restore-progress')).toBe('地図を復元しています（0/3）');
    expect(line(root, 'restore-summary')).toBeNull();
    for (const [index, expected] of ['1/3', '2/3'].entries()) {
      await vi.waitFor(() => expect(gates).toHaveLength(index + 1));
      gates[index]();
      await vi.waitFor(() => {
        flushSync();
        expect(line(root, 'restore-progress')).toBe(`地図を復元しています（${expected}）`);
      });
    }
    await vi.waitFor(() => expect(gates).toHaveLength(3));
    gates[2]();
    await restoring;
    flushSync();
    expect(line(root, 'restore-progress')).toBeNull();
  });

  it('says how many layers could not be restored, until they are removed', async () => {
    const root = render();
    await restoreMap(state, {
      queryLayer: async (sql) => (sql === 'SELECT 1' || sql === 'SELECT 3' ? { ok: false, error: { code: 'SQL_ERROR', message: 'boom' } } : { ok: true, data }),
      jumpTo: () => undefined
    });
    flushSync();
    expect(layerIds()).toEqual(['L1', 'L2', 'L3']);
    expect(line(root, 'restore-summary')).toBe('2 枚のレイヤーを復元できませんでした');
    root.querySelector<HTMLElement>('[data-layer-id=L1] [data-testid=layer-remove]')?.click();
    flushSync();
    expect(line(root, 'restore-summary')).toBe('1 枚のレイヤーを復元できませんでした');
    root.querySelector<HTMLElement>('[data-layer-id=L3] [data-testid=layer-remove]')?.click();
    flushSync();
    expect(line(root, 'restore-summary')).toBeNull();
  });
});
