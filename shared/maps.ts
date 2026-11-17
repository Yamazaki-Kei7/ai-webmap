/**
 * Error names and statuses of the saved-maps API (`saveMap`, `listMaps`, `getMap`, `deleteMap` of `api`). The frontend recognises these.
 * `saveMap` with a `conversationId` that is not the caller's, or that does not exist, also answers the conversation API's
 * `conversationErrors.NotFound` (404, `shared/conversation.ts`); a malformed one is `InvalidRequest` here.
 */

export const mapsErrors = {
  /** An argument is missing, malformed or over its limit. */
  InvalidRequest: 'InvalidMapRequestException',
  /** The map does not exist or belongs to another user: the two are not told apart. */
  NotFound: 'MapNotFoundException',
  /** The map was changed or deleted by another request between the read and the write of an update: reload it and save again. */
  Conflict: 'MapConflictException',
  /** A new map would exceed `mapsConfig.maxMapsPerUser`. */
  LimitReached: 'MapLimitReachedException',
  /** The stored record does not read back as a valid map. */
  Corrupt: 'MapCorruptException'
} as const;

export const mapsStatus = {
  badRequest: 400,
  notFound: 404,
  conflict: 409,
  serverError: 500
} as const;

/** Reveals nothing about other users' maps. */
export const mapNotFoundMessage = 'Map not found';
export const mapConflictMessage = 'The map was changed elsewhere';
export const mapLimitReachedMessage = 'Too many saved maps';
export const mapCorruptMessage = 'The saved map cannot be read';
