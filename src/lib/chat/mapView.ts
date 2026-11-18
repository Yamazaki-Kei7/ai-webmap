import { mapConfig } from '../../../shared/config';
import type { Bbox } from '../duckdb/queryTypes';

/** How a tool moves the map to a box: the padding and the zoom limit of a fit, and how long the move takes. */
export type FitOptions = { padding: number; maxZoom: number; duration: number };

/** What the tool executor needs of the map's camera; the real MapLibre map is one. */
export type MapView = {
  /** Moves the map to the box and settles when the move has ended (or after `mapConfig.moveWaitMs` at most). */
  fitBounds(bbox: Bbox, options: FitOptions): Promise<void>;
  jumpTo(center: [number, number], zoom: number): void;
  /** Where the map is now: the centre wrapped into -180..180, and the zoom. */
  getView(): { center: [number, number]; zoom: number };
};

/** The part of a MapLibre map the adapter uses (small, so that a test can stand in for the map). */
export type CameraMap = {
  fitBounds(bounds: [[number, number], [number, number]], options: FitOptions): void;
  jumpTo(options: { center: [number, number]; zoom: number }): void;
  isMoving(): boolean;
  once(type: 'moveend', listener: () => void): void;
  off(type: 'moveend', listener: () => void): void;
  getCenter(): { wrap(): { lng: number; lat: number } };
  getZoom(): number;
};

export const mapNotReadyMessage = 'The map is not ready.';

/**
 * The camera of the map as the tools use it. The map is looked up at every call (it exists only after the page has
 * mounted); a missing map throws, which the executor answers as `ENGINE_UNAVAILABLE`.
 */
export function createMapView(getMap: () => CameraMap | undefined): MapView {
  const current = (): CameraMap => {
    const map = getMap();
    if (map === undefined) throw new Error(mapNotReadyMessage);
    return map;
  };

  return {
    fitBounds(bbox, options) {
      const map = current();
      const [west, south, east, north] = bbox;
      map.fitBounds(
        [
          [west, south],
          [east, north]
        ],
        options
      );
      // A move with no animation (or none needed) has ended already: its `moveend` came before this line.
      if (!map.isMoving()) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const finish = (): void => {
          clearTimeout(timer);
          map.off('moveend', finish);
          resolve();
        };
        const timer = setTimeout(finish, mapConfig.moveWaitMs);
        map.once('moveend', finish);
      });
    },
    jumpTo(center, zoom) {
      current().jumpTo({ center, zoom });
    },
    getView() {
      const map = current();
      const { lng, lat } = map.getCenter().wrap();
      return { center: [lng, lat], zoom: map.getZoom() };
    }
  };
}
