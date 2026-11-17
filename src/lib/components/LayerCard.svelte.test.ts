import { mount, tick, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import type { LayerQueryResult } from '../duckdb/queryTypes';
import { addErrorLayer, addLayer, resetMapState, type LayerState } from '$lib/map/mapState.svelte';
import LayerCard from './LayerCard.svelte';

const data: LayerQueryResult = {
  features: { type: 'FeatureCollection', features: [{ type: 'Feature', id: 0, geometry: { type: 'Point', coordinates: [139, 35] }, properties: { a: 1 } }] },
  geometryType: 'point',
  columns: [{ name: 'a', type: 'number' }],
  featureCount: 1,
  bbox: [139, 35, 139, 35]
};

let mounted: ReturnType<typeof mount> | undefined;

async function show(layer: LayerState): Promise<HTMLElement> {
  const target = document.createElement('ul');
  document.body.append(target);
  mounted = mount(LayerCard, { target, props: { layer } });
  await tick();
  return target;
}

afterEach(() => {
  if (mounted) void unmount(mounted);
  mounted = undefined;
  document.body.replaceChildren();
  resetMapState();
});

describe('LayerCard', () => {
  it('shows the error of a layer that failed to load, and no legend (it has nothing to describe)', async () => {
    const failed = addErrorLayer({ id: 'L1', name: '壊れた', sql: 'SELECT 1', style: { type: 'single', color: '#000000' }, label: null, visible: true }, 'Binder Error');
    const card = await show(failed);
    expect(card.querySelector('[data-testid=layer-status]')?.textContent).toBe('Binder Error');
    expect(card.querySelector('[data-testid=legend]')).toBeNull();
  });

  it('shows the legend of a layer that is ready', async () => {
    const added = addLayer({ name: '駅', sql: 'SELECT 1' }, data);
    if (!added.ok) throw new Error(added.error.message);
    const card = await show(added.data);
    expect(card.querySelector('[data-testid=legend]')).not.toBeNull();
    expect(card.querySelector('[data-testid=layer-status]')).toBeNull();
  });
});
