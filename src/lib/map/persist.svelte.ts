import { mapsConfig, queryConfig } from '../../../shared/config';
import { persistedMapStateSchema, persistedMapVersion, type PersistedMapState } from '../../../shared/persistedMap';
import { toolError, type ClientToolResult, type ToolErrorCode } from '../../../shared/toolProtocol';
import { firstLineWithoutUrls } from '../duckdb/errors';
import type { LayerQueryResult } from '../duckdb/queryTypes';
import { outsideDegrees } from './degrees';
import { fittedLayerIds } from './fit';
import { clampZoom } from './zoom';
import { addErrorLayer, currentSession, mapState, resetMapState, restoreLayer, setNextLayerSeq, setView } from './mapState.svelte';

/** What a restore did: the ids of the layers that came back, and those that stayed on the map as error layers (with why). */
export type RestoreReport = {
  restored: string[];
  failed: { id: string; code: ToolErrorCode; message: string }[];
  /** A later restore (or a sign-out) took over before this one was done: what it lists is only what it got to. */
  cancelled?: true;
  /** The state was not a valid saved map (this says why): nothing was done, and the map is as it was. */
  invalid?: string;
};

export type RestoreDeps = {
  /** The engine's `queryLayer`: it runs the SQL guard, which the saved SQL (untrusted input from storage) goes through. */
  queryLayer: (sql: string) => Promise<ClientToolResult<LayerQueryResult>>;
  /** Moves the map's camera (the map may not exist yet: the view is kept in the state either way). */
  jumpTo: (center: [number, number], zoom: number) => void;
};

/** How far a restore is, for the UI: null when none runs. Read it, do not assign it. */
export const restoreProgress: { current: { done: number; total: number } | null } = $state({ current: null });

/** The map as it is kept, or why it cannot be (6.3 tells the user): more layers than a saved map holds, or a state the schema refuses. */
export type PersistResult = { ok: true; state: PersistedMapState } | { ok: false; reason: 'tooManyLayers' | 'invalid'; message: string };

/** The map as it is kept (Phase 2): the view and, per layer, what rebuilds it. Never the features. Never throws. */
export function toPersisted(): PersistResult {
  const { view, layers, nextLayerSeq } = $state.snapshot(mapState);
  if (layers.length > mapsConfig.maxLayers) return { ok: false, reason: 'tooManyLayers', message: `A saved map holds at most ${mapsConfig.maxLayers} layers.` };
  const parsed = persistedMapStateSchema.safeParse({
    version: persistedMapVersion,
    // The map can be zoomed out further than a saved view may be (a short map): the saved zoom is the nearest allowed one.
    view: { center: [view.center[0], view.center[1]], zoom: clampZoom(view.zoom) },
    layers: layers.map(({ id, name, sql, style, label, visible }) => ({ id, name, sql, style, label, visible })),
    nextLayerSeq
  });
  return parsed.success ? { ok: true, state: parsed.data } : { ok: false, reason: 'invalid', message: parsed.error.message };
}

// Counts the restores: one that finds a later one has started stops.
let generation = 0;

const unknownErrorMessage = 'unknown error';

/** The failure of a query that threw: its first line, without URLs and stack. */
const thrown = (error: Error | string): ClientToolResult<LayerQueryResult> =>
  toolError('ENGINE_UNAVAILABLE', firstLineWithoutUrls(typeof error === 'string' ? error : error.message, queryConfig.maxErrorChars) ?? unknownErrorMessage);

/**
 * Rebuilds a saved map: clears the map, then runs each layer's SQL again, in the saved order and one at a time, and puts
 * the layers back with their saved ids, names, styles, labels and visibility. A layer whose query or style fails stays on the
 * map as an error layer (the others are restored). The view is set after the layers; no layer is fitted. The next layer
 * number is the saved one, and never lower than the restored ids need.
 */
export async function restoreMap(given: PersistedMapState, deps: RestoreDeps): Promise<RestoreReport> {
  // The state is untrusted input from storage: a bad one is refused before the map in use is cleared.
  const checked = persistedMapStateSchema.safeParse(given);
  if (!checked.success) return { restored: [], failed: [], invalid: checked.error.message };
  const state = checked.data;
  const mine = ++generation;
  resetMapState();
  // Reserved at once: a layer added meanwhile (a tool that was already running) must not take an id of the saved map.
  setNextLayerSeq(state.nextLayerSeq, state.layers.map(({ id }) => id));
  const session = currentSession();
  // The map view fits a layer that is new to it: these are not new, and ids of an earlier map must not hide one of the next.
  fittedLayerIds.clear();
  const report: RestoreReport = { restored: [], failed: [] };
  const total = state.layers.length;
  restoreProgress.current = { done: 0, total };

  const superseded = (): boolean => mine !== generation || session !== currentSession();
  const cancel = (): RestoreReport => {
    // A later restore owns the progress; after a sign-out nobody does.
    if (mine === generation) restoreProgress.current = null;
    return { ...report, cancelled: true };
  };

  for (const [index, saved] of state.layers.entries()) {
    let queried: ClientToolResult<LayerQueryResult>;
    try {
      queried = await deps.queryLayer(saved.sql);
    } catch (error) {
      queried = thrown(error instanceof Error ? error : String(error));
    }
    if (superseded()) return cancel();

    const placed = queried.ok ? (outsideDegrees(queried.data) ?? restoreLayer(saved, queried.data)) : queried;
    fittedLayerIds.add(saved.id);
    if (placed.ok) report.restored.push(saved.id);
    else {
      addErrorLayer(saved, placed.error.message);
      report.failed.push({ id: saved.id, code: placed.error.code, message: placed.error.message });
    }
    restoreProgress.current = { done: index + 1, total };
  }

  setNextLayerSeq(state.nextLayerSeq);
  const [lng, lat] = state.view.center;
  setView({ lng, lat }, state.view.zoom);
  deps.jumpTo(state.view.center, state.view.zoom);
  restoreProgress.current = null;
  return report;
}
