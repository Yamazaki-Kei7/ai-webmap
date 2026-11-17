import { ApiError, DistributedTableErrors } from '@aws-blocks/blocks';
import { z } from 'zod';
import { mapsConfig } from '../shared/config.js';
import {
  mapConflictMessage,
  mapCorruptMessage,
  mapLimitReachedMessage,
  mapNotFoundMessage,
  mapsErrors,
  mapsStatus
} from '../shared/maps.js';
import { savedMapSchema, persistedMapStateSchema, type SavedMap, type SavedMapSummary } from '../shared/persistedMap.js';
import type { Checked } from './conversation-input.js';
import type { CheckedSaveMap } from './maps-input.js';

/**
 * One saved map as the `maps` table keeps it: the owner (partition key), the map id (sort key) and the state as the JSON
 * string `checkSaveMap` made. The owner is always the signed-in user's name, never anything the client sends.
 */
export const mapRecordSchema = z.object({
  userId: z.string(),
  mapId: z.string(),
  title: z.string(),
  state: z.string(),
  conversationId: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number()
});

export type MapRecord = z.infer<typeof mapRecordSchema>;

/** The part of the `maps` table the methods below use (a test passes a fake). Every call names the owner. */
export type MapsTable = {
  get(key: { userId: string; mapId: string }): Promise<MapRecord | null>;
  put(item: MapRecord, options?: { ifNotExists: true } | { ifFieldEquals: { updatedAt: number } }): Promise<void>;
  delete(key: { userId: string; mapId: string }, options?: { ifExists?: boolean }): Promise<void>;
  query(options: { where: { userId: { equals: string } } }): AsyncIterable<MapRecord>;
};

/** The value of a passed check; a failed one is the 400 of this API (the error name is the saved-maps one, not the conversation one). */
export function unwrapMapInput<T>(checked: Checked<T>): T {
  if (!checked.ok) throw new ApiError(checked.message, mapsStatus.badRequest, { name: mapsErrors.InvalidRequest });
  return checked.value;
}

/** Whether a write failed because its condition (`ifFieldEquals`, `ifExists`) did not hold. */
const isConditionFailure = (error: Error): boolean => error.name === DistributedTableErrors.ConditionalCheckFailed;

const notFound = (): ApiError => new ApiError(mapNotFoundMessage, mapsStatus.notFound, { name: mapsErrors.NotFound });

const ownedBy = (userId: string) => ({ where: { userId: { equals: userId } } });

/** The caller's records. The partition is one user's maps (at most `mapsConfig.maxMapsPerUser`), so reading it whole is bounded. */
async function recordsOf(table: MapsTable, userId: string): Promise<MapRecord[]> {
  return Array.fromAsync(table.query(ownedBy(userId)));
}

export type SaveMapDeps = {
  /** The current time (milliseconds). */
  now: () => number;
  /** A fresh, random, URL-safe map id. */
  newMapId: () => string;
};

/**
 * Creates a map (no `mapId`) or replaces one of the caller's (`mapId`; a map that is not the caller's, or does not exist,
 * is a 404). A new map is refused (409) when the caller already has `mapsConfig.maxMapsPerUser`: the count is read before the
 * write, so simultaneous creates may overshoot it by up to their number less one (it is a cost cap; no counter item is kept).
 * An update never counts against the limit. An update writes only if the record still has the `updatedAt` it was read with,
 * so it can neither bring back a map deleted meanwhile nor silently overwrite a newer save: either is a 409. The read itself
 * may be eventually consistent (on AWS the block offers no consistent read), so a map made a moment ago may answer 404 once.
 */
export async function saveMapRecord(
  table: MapsTable,
  userId: string,
  input: CheckedSaveMap,
  { now, newMapId }: SaveMapDeps
): Promise<{ mapId: string; updatedAt: number }> {
  const updatedAt = now();
  const conversation = input.conversationId === undefined ? {} : { conversationId: input.conversationId };
  if (input.mapId !== undefined) {
    const existing = await table.get({ userId, mapId: input.mapId });
    if (existing === null) throw notFound();
    const record: MapRecord = { userId, mapId: input.mapId, title: input.title, state: input.stateJson, ...conversation, createdAt: existing.createdAt, updatedAt };
    try {
      await table.put(record, { ifFieldEquals: { updatedAt: existing.updatedAt } });
    } catch (error) {
      if (error instanceof Error && isConditionFailure(error)) {
        throw new ApiError(mapConflictMessage, mapsStatus.conflict, { name: mapsErrors.Conflict });
      }
      throw error;
    }
    return { mapId: input.mapId, updatedAt };
  }
  if ((await recordsOf(table, userId)).length >= mapsConfig.maxMapsPerUser) {
    throw new ApiError(mapLimitReachedMessage, mapsStatus.conflict, { name: mapsErrors.LimitReached });
  }
  const mapId = newMapId();
  // A fresh id: an existing record (a clash, which a random id does not make) must never be overwritten.
  await table.put({ userId, mapId, title: input.title, state: input.stateJson, ...conversation, createdAt: updatedAt, updatedAt }, { ifNotExists: true });
  return { mapId, updatedAt };
}

/** The caller's maps, the most recently saved first, without their states. */
export async function listMapRecords(table: MapsTable, userId: string): Promise<{ maps: SavedMapSummary[] }> {
  const records = await recordsOf(table, userId);
  const maps = records.map(({ mapId, title, updatedAt }) => ({ mapId, title, updatedAt }));
  return { maps: maps.sort((a, b) => b.updatedAt - a.updatedAt) };
}

const corrupt = (): ApiError => new ApiError(mapCorruptMessage, mapsStatus.serverError, { name: mapsErrors.Corrupt });

/** The stored state, read back through the schema; a string that is not JSON or not a valid state is `undefined`. */
function parseState(stateJson: string): SavedMap['state'] | undefined {
  try {
    const parsed = persistedMapStateSchema.safeParse(JSON.parse(stateJson));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** One of the caller's maps (another user's, and a missing one, are a 404). A record that does not read back as a valid map is a 500 with a name. */
export async function getMapRecord(table: MapsTable, userId: string, mapId: string): Promise<SavedMap> {
  const record = await table.get({ userId, mapId });
  if (record === null) throw notFound();
  const state = parseState(record.state);
  const map = savedMapSchema.safeParse({
    mapId: record.mapId,
    title: record.title,
    state,
    ...(record.conversationId === undefined ? {} : { conversationId: record.conversationId }),
    updatedAt: record.updatedAt
  });
  if (!map.success) throw corrupt();
  return map.data;
}

/** Deletes one of the caller's maps (another user's, and a missing one, are a 404): one conditional delete, which needs no read first. */
export async function deleteMapRecord(table: MapsTable, userId: string, mapId: string): Promise<{ success: true }> {
  try {
    await table.delete({ userId, mapId }, { ifExists: true });
  } catch (error) {
    if (error instanceof Error && isConditionFailure(error)) throw notFound();
    throw error;
  }
  return { success: true };
}
