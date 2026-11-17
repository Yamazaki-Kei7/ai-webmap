import { mapsConfig } from '../../../shared/config';
import { layerIdOfSqlNotAllowed, mapsErrors } from '../../../shared/maps';
import type { PersistedMapState, SavedMapSummary } from '../../../shared/persistedMap';
import type { PersistResult } from './persist.svelte';

const { text, unsavedViewChange } = mapsConfig;

/** The text with its `{name}` parts filled in. */
export function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  return Object.entries(values).reduce((filled, [key, value]) => filled.replaceAll(`{${key}}`, String(value)), template);
}

const lengthOfTile = (zoom: number): number => 360 / 2 ** zoom;

/**
 * Whether the camera moved enough to count as a change of the map: the zoom differs by `unsavedViewChange.zoomLevels`,
 * or the centre is `unsavedViewChange.centerTiles` map tiles away (at the saved zoom). Panning a little is not one.
 */
export function viewChanged(current: PersistedMapState['view'], saved: PersistedMapState['view']): boolean {
  if (Math.abs(current.zoom - saved.zoom) >= unsavedViewChange.zoomLevels) return true;
  const limit = unsavedViewChange.centerTiles * lengthOfTile(saved.zoom);
  return Math.abs(current.center[0] - saved.center[0]) >= limit || Math.abs(current.center[1] - saved.center[1]) >= limit;
}

/**
 * Whether the map holds changes that are not saved. `saved` is the state as it was last saved or opened, or null for the
 * empty map of a new page. Any change to the layers (added, removed, reordered, renamed, restyled, relabelled, shown or hidden)
 * counts; the next layer number does not (it changes with a layer that was added and removed again), and the view only beyond
 * `mapsConfig.unsavedViewChange`. A map that cannot be saved as it is (too many layers) differs from any saved one.
 */
export function hasUnsavedChanges(current: PersistResult, saved: PersistedMapState | null): boolean {
  if (!current.ok) return true;
  if (saved === null) return current.state.layers.length > 0;
  return JSON.stringify(current.state.layers) !== JSON.stringify(saved.layers) || viewChanged(current.state.view, saved.view);
}

/** The error name of a failure (the typed client rejects with `Error`s that carry the server's name); '' for a failure that is not an `Error`. */
const nameOf = (failure: Error | null): string => failure?.name ?? '';

/** The message of a failed save, by its error name; the layer a 400 names is added. */
export function saveErrorText(failure: Error | null): string {
  const name = nameOf(failure);
  const known = text.errors.save[name] ?? text.errors.save.generic;
  const base = fill(known, { n: mapsConfig.maxMapsPerUser });
  const layerId = name === mapsErrors.InvalidRequest && failure ? layerIdOfSqlNotAllowed(failure.message) : undefined;
  return layerId === undefined ? base : base + fill(text.errors.invalidLayer, { id: layerId });
}

/** Why a map that cannot be kept as it is cannot be saved: too many layers (with the limit), or any other state the schema refuses (no detail). */
export const persistFailureText = (reason: Extract<PersistResult, { ok: false }>['reason']): string =>
  reason === 'tooManyLayers' ? fill(text.saveDialog.tooManyLayers, { n: mapsConfig.maxLayers }) : text.saveDialog.invalid;

export const listErrorText = (): string => text.errors.list.generic;

/** The message of a map that could not be opened, by its error name. */
export const openErrorText = (failure: Error | null): string => text.errors.open[nameOf(failure)] ?? text.errors.open.generic;

/** The message of a map that could not be deleted, by its error name. */
export const removeErrorText = (failure: Error | null): string => text.errors.remove[nameOf(failure)] ?? text.errors.remove.generic;

/** The maps, the most recently saved first (the server sorts them; the list does not rely on it). */
export const newestFirst = (maps: readonly SavedMapSummary[]): SavedMapSummary[] => [...maps].sort((a, b) => b.updatedAt - a.updatedAt);

const dateFormat = new Intl.DateTimeFormat(mapsConfig.dateLocale, { dateStyle: 'medium', timeStyle: 'short' });

/** A saved time, as the list shows it (Japanese format). */
export const formatUpdatedAt = (updatedAt: number): string => dateFormat.format(new Date(updatedAt));

/** The line over the layer panel while a restore runs. */
export const restoreProgressText = (progress: { done: number; total: number }): string => fill(text.restoreProgress, progress);

/** The line after a restore that left layers behind, or null when all came back. */
export const restoreSummaryText = (failedLayers: number): string | null => (failedLayers === 0 ? null : fill(text.restoreFailedLayers, { n: failedLayers }));
