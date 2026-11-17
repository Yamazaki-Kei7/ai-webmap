import { describe, expect, it } from 'vitest';
import { pickFitBounds } from './fit';

const layer = (id: string, featureCount: number) => ({ id, featureCount, bbox: [1, 2, 3, 4] as [number, number, number, number] });

describe('pickFitBounds', () => {
  it('fits to the box of the latest new layer, and not again for it', () => {
    const fitted = new Set<string>();
    expect(pickFitBounds([layer('L1', 5)], fitted)).toEqual([[1, 2], [3, 4]]);
    expect(pickFitBounds([layer('L1', 5)], fitted)).toBeUndefined();
  });

  it('takes the last of several new layers', () => {
    const fitted = new Set(['L1']);
    const bounds = pickFitBounds([layer('L1', 5), { ...layer('L2', 5), bbox: [10, 20, 30, 40] }, layer('L3', 5)], fitted);
    expect(bounds).toEqual([[1, 2], [3, 4]]);
    expect([...fitted]).toEqual(['L1', 'L2', 'L3']);
  });

  it('does not move the map for a layer with no feature, but counts it as handled', () => {
    const fitted = new Set<string>();
    expect(pickFitBounds([layer('L1', 0)], fitted)).toBeUndefined();
    expect(fitted.has('L1')).toBe(true);
  });

  it('does nothing when a layer is removed', () => {
    const fitted = new Set(['L1', 'L2']);
    expect(pickFitBounds([layer('L2', 5)], fitted)).toBeUndefined();
  });
});
