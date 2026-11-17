import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mapConfig } from '../../../shared/config';
import { createMapView, mapNotReadyMessage, type CameraMap, type FitOptions } from './mapView';

const options: FitOptions = { padding: 10, maxZoom: 12, duration: 300 };

type FakeMap = CameraMap & {
  fitCalls: [[number, number], [number, number]][];
  jumps: { center: [number, number]; zoom: number }[];
  listeners: Set<() => void>;
  emitMoveEnd(): void;
  moving: boolean;
};

function fakeMap(moving: boolean, center = { lng: 140, lat: 36 }, zoom = 7): FakeMap {
  const map: FakeMap = {
    fitCalls: [],
    jumps: [],
    listeners: new Set(),
    moving,
    fitBounds(bounds) {
      map.fitCalls.push(bounds);
    },
    jumpTo(jump) {
      map.jumps.push(jump);
    },
    isMoving: () => map.moving,
    once: (_type, listener) => {
      map.listeners.add(listener);
    },
    off: (_type, listener) => {
      map.listeners.delete(listener);
    },
    getCenter: () => ({ wrap: () => center }),
    getZoom: () => zoom,
    emitMoveEnd() {
      for (const listener of [...map.listeners]) listener();
    }
  };
  return map;
}

describe('createMapView', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('moves the map to the box and settles at its moveend, without waiting out the bound', async () => {
    const map = fakeMap(true);
    const view = createMapView(() => map);
    let settled = false;
    const done = view.fitBounds([130, 30, 140, 40], options).then(() => {
      settled = true;
    });
    expect(map.fitCalls).toEqual([
      [
        [130, 30],
        [140, 40]
      ]
    ]);
    await vi.advanceTimersByTimeAsync(options.duration);
    expect(settled).toBe(false);
    map.emitMoveEnd();
    await done;
    expect(map.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not wait for a move that has ended already (no animation)', async () => {
    const map = fakeMap(false);
    await createMapView(() => map).fitBounds([130, 30, 140, 40], options);
    expect(map.listeners.size).toBe(0);
  });

  it('stops waiting after the bound when the map never reports the end, and leaves no listener', async () => {
    const map = fakeMap(true);
    let settled = false;
    const done = createMapView(() => map)
      .fitBounds([130, 30, 140, 40], options)
      .then(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(mapConfig.moveWaitMs - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(map.listeners.size).toBe(0);
  });

  it('jumps to a centre and zoom, and reads the view back with the centre wrapped', () => {
    const map = fakeMap(false, { lng: -170, lat: 10 }, 3.5);
    const view = createMapView(() => map);
    view.jumpTo([139.7, 35.7], 9);
    expect(map.jumps).toEqual([{ center: [139.7, 35.7], zoom: 9 }]);
    expect(view.getView()).toEqual({ center: [-170, 10], zoom: 3.5 });
  });

  it('throws while there is no map, so that the executor can answer it', async () => {
    const view = createMapView(() => undefined);
    await expect(async () => view.fitBounds([130, 30, 140, 40], options)).rejects.toThrow(mapNotReadyMessage);
    expect(() => view.jumpTo([139, 35], 5)).toThrow(mapNotReadyMessage);
    expect(() => view.getView()).toThrow(mapNotReadyMessage);
  });
});
