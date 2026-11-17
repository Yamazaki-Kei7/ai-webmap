import { mapConfig, mapsConfig } from '../../../shared/config';
import { mapsErrors } from '../../../shared/maps';
import { mapTitleSchema, persistedMapStateSchema, type PersistedMapState, type SavedMap, type SavedMapSummary } from '../../../shared/persistedMap';
import type { ChatSession } from '../chat/chatSession.svelte';
import { currentSession, resetMapState } from './mapState.svelte';
import { toPersisted, type RestoreReport } from './persist.svelte';
import { hasUnsavedChanges, listErrorText, newestFirst, openErrorText, persistFailureText, removeErrorText, saveErrorText } from './savedMaps';

/** The saved map the page is showing (Phase 2): which one it is, and the state it was last saved or opened in. One per signed-in user: it is cleared with the map. */
export const currentMap: {
  /**
   * The map the next save updates and the version of it this page saved or opened last (an update names the version, and is
   * refused when the stored map moved on); null for a map that was never saved. One field, so that an id without a version cannot exist.
   */
  stored: { mapId: string; updatedAt: number } | null;
  title: string | null;
  /** The state as it was last saved or opened (what unsaved changes are measured from); null for the empty map of a new page. */
  saved: PersistedMapState | null;
  /** The conversation the map was stored with, when it could not be opened (not for good): a save keeps it until the chat has a conversation of its own. */
  conversationId: string | null;
} = $state({ stored: null, title: null, saved: null, conversationId: null });

/** No saved map: sign-out, another user, or a new map. */
export function clearCurrentMap(): void {
  currentMap.stored = null;
  currentMap.title = null;
  currentMap.saved = null;
  currentMap.conversationId = null;
}

/** The saved-maps methods of the typed client, as the flow uses them (`mapsApi.ts` maps them onto it). */
export type MapsApi = {
  saveMap: (input: { mapId?: string; title: string; state: PersistedMapState; conversationId?: string; expectedUpdatedAt?: number }) => Promise<{ mapId: string; updatedAt: number }>;
  listMaps: () => Promise<{ maps: SavedMapSummary[] }>;
  getMap: (mapId: string) => Promise<SavedMap>;
  deleteMap: (mapId: string) => Promise<{ success: true }>;
};

export type MapFlowDeps = {
  api: MapsApi;
  /** The chat of the signed-in user (undefined before there is one). */
  chat: () => Pick<ChatSession, 'conversationId' | 'openConversation' | 'reset'> | undefined;
  /** Rebuilds a map (`restoreMap` on the engine and the camera). */
  restore: (state: PersistedMapState) => Promise<RestoreReport>;
  /** Moves the camera. */
  jumpTo: (center: [number, number], zoom: number) => void;
};

/**
 * `message` is null for an operation that was overtaken (a sign-out, or a newer open): nobody is told. `offerNew`: the map
 * cannot be updated (it is gone, or was changed elsewhere), but its content may be saved as a new map.
 */
export type Failure = { ok: false; message: string | null; offerNew?: true };
export type SaveOutcome = { ok: true } | Failure;
export type ListOutcome = { ok: true; maps: SavedMapSummary[] } | Failure;
export type OpenOutcome = { ok: true; failedLayers: number } | Failure;
export type RemoveOutcome = { ok: true } | Failure;

export type MapFlow = {
  /** The title of the map being shown, or null for a map that was never saved. */
  readonly title: string | null;
  readonly mapId: string | null;
  /** The map holds changes that are not saved (see `hasUnsavedChanges`). */
  readonly unsaved: boolean;
  /** An open (the map is fetched and rebuilt) is running: nothing else changes the map meanwhile. */
  readonly opening: boolean;
  /** A save is running: another is refused (a second one could create the map twice). */
  readonly saving: boolean;
  /** Saves the map under `title`: an update of the map shown, or (`asNew`, or none shown yet) a new map. */
  save(title: string, options?: { asNew?: boolean }): Promise<SaveOutcome>;
  list(): Promise<ListOutcome>;
  /** The conversation of the map is opened first, then its layers are rebuilt. The caller has asked about unsaved changes. */
  open(mapId: string): Promise<OpenOutcome>;
  remove(mapId: string): Promise<RemoveOutcome>;
  /** An empty map and a new conversation. The caller has asked about unsaved changes. */
  startNew(): void;
};

/** What a rejected call rejected with, when it is an `Error` (the typed client's are, and carry the server's error name). */
const asError = <T>(failure: T): Error | null => (failure instanceof Error ? failure : null);

const unusable = { ok: false, message: null } as const;

export function createMapFlow(deps: MapFlowDeps): MapFlow {
  let opening = $state(false);
  let saving = $state(false);
  // Counts the opens: one that finds a later one has started has been overtaken.
  let openings = 0;

  return {
    get title() {
      return currentMap.title;
    },
    get mapId() {
      return currentMap.stored?.mapId ?? null;
    },
    get unsaved() {
      // While a map is being opened the page holds no map of its own to lose (and what it shows is not the one it is measured against).
      return !opening && hasUnsavedChanges(toPersisted(), currentMap.saved);
    },
    get saving() {
      return saving;
    },
    get opening() {
      return opening;
    },

    async save(title, options = {}) {
      if (saving) return unusable;
      const persisted = toPersisted();
      if (!persisted.ok) return { ok: false, message: persistFailureText(persisted.reason) };
      if (!mapTitleSchema.safeParse(title).success) return { ok: false, message: mapsConfig.text.saveDialog.titleRequired };
      const session = currentSession();
      // An update names the version it saw; a new map (the first save, or `asNew`) names none.
      const target = !options.asNew && currentMap.stored !== null ? { mapId: currentMap.stored.mapId, expectedUpdatedAt: currentMap.stored.updatedAt } : {};
      // The conversation of the chat; or, when the stored one could not be opened, the stored one (a save must not drop it).
      const conversationId = deps.chat()?.conversationId ?? currentMap.conversationId ?? undefined;
      saving = true;
      try {
        const saved = await deps.api.saveMap({
          ...target,
          title,
          state: persisted.state,
          ...(conversationId === undefined ? {} : { conversationId })
        });
        // A sign-out (or another user) while it saved: the result belongs to nobody on this page.
        if (session !== currentSession()) return unusable;
        currentMap.stored = { mapId: saved.mapId, updatedAt: saved.updatedAt };
        currentMap.title = title;
        currentMap.saved = persisted.state;
        return { ok: true };
      } catch (failure) {
        if (session !== currentSession()) return unusable;
        const error = asError(failure);
        const offerNew = error?.name === mapsErrors.NotFound || error?.name === mapsErrors.Conflict;
        return { ok: false, message: saveErrorText(error), ...(offerNew ? { offerNew: true as const } : {}) };
      } finally {
        saving = false;
      }
    },

    async list() {
      const session = currentSession();
      try {
        const { maps } = await deps.api.listMaps();
        return session === currentSession() ? { ok: true, maps: newestFirst(maps) } : unusable;
      } catch {
        return session === currentSession() ? { ok: false, message: listErrorText() } : unusable;
      }
    },

    async open(mapId) {
      const chat = deps.chat();
      if (chat === undefined) return { ok: false, message: openErrorText(null) };
      const mine = ++openings;
      const session = currentSession();
      const overtaken = (): boolean => mine !== openings || session !== currentSession();
      opening = true;
      try {
        let map: SavedMap;
        try {
          map = await deps.api.getMap(mapId);
        } catch (failure) {
          return overtaken() ? unusable : { ok: false, message: openErrorText(asError(failure)) };
        }
        if (overtaken()) return unusable;
        // The state is untrusted input from storage: a bad one is refused before the chat or the map is touched.
        const state = persistedMapStateSchema.safeParse(map.state);
        if (!state.success) return { ok: false, message: mapsConfig.text.errors.open.invalidState };

        // The conversation first, then the map: the chat shows what was said about the map that is about to come back.
        // Only a conversation that is gone for good is let go of: when it merely could not be loaded, a save keeps it.
        let keptConversationId: string | null = null;
        if (map.conversationId === undefined) chat.reset();
        else if ((await chat.openConversation(map.conversationId)) === 'failed') keptConversationId = map.conversationId;
        if (overtaken()) return unusable;

        const report = await deps.restore(state.data);
        // The restore clears the map itself (a new session number), and says by itself when a sign-out or a later restore took over.
        if (report.cancelled || mine !== openings) return unusable;
        if (report.invalid !== undefined) return { ok: false, message: mapsConfig.text.errors.open.invalidState };

        // Measured from what the map came out as (the view may have been clamped), not from what was stored.
        const rebuilt = toPersisted();
        currentMap.stored = { mapId: map.mapId, updatedAt: map.updatedAt };
        currentMap.title = map.title;
        currentMap.saved = rebuilt.ok ? rebuilt.state : state.data;
        currentMap.conversationId = keptConversationId;
        return { ok: true, failedLayers: report.failed.length };
      } finally {
        if (mine === openings) opening = false;
      }
    },

    async remove(mapId) {
      const session = currentSession();
      try {
        await deps.api.deleteMap(mapId);
      } catch (failure) {
        const error = asError(failure);
        // Gone already: the list is right to drop it.
        if (error?.name !== mapsErrors.NotFound) return session === currentSession() ? { ok: false, message: removeErrorText(error) } : unusable;
      }
      if (session !== currentSession()) return unusable;
      // The map on the screen is not a saved one any more: the next save makes a new map.
      if (currentMap.stored?.mapId === mapId) {
        currentMap.stored = null;
        currentMap.title = null;
        currentMap.saved = null;
      }
      return { ok: true };
    },

    startNew() {
      // An open that is still running must not bring its map back.
      openings++;
      opening = false;
      resetMapState();
      clearCurrentMap();
      deps.chat()?.reset();
      const [lng, lat] = mapConfig.initialView.center;
      deps.jumpTo([lng, lat], mapConfig.initialView.zoom);
    }
  };
}
