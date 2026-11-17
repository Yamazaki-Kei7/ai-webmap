import { z } from 'zod';
import { mapsConfig } from '../shared/config.js';
import { datasetIds } from '../shared/datasets.js';
import { mapIdSchema, mapTitleSchema, persistedMapStateSchema, type PersistedMapState } from '../shared/persistedMap.js';
import { validateSql } from '../shared/sqlGuard.js';
import type { Checked } from './conversation-input.js';

/**
 * The checks of the saved-maps API's arguments (pure, so they are tested without a backend). A failure carries a short
 * message that never echoes the input; the API turns it into a 400.
 */

export const checkMapId = (value: string): Checked<string> => {
  const parsed = mapIdSchema.safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, message: 'Invalid map id' };
};

/** What `saveMap` takes. */
export type SaveMapInput = { mapId?: string; title: string; state: PersistedMapState; conversationId?: string };

/** A `saveMap` input that passed: the state is as stored (`stateJson` is its JSON, the string that is kept). */
export type CheckedSaveMap = {
  mapId?: string;
  title: string;
  state: PersistedMapState;
  stateJson: string;
  conversationId?: string;
};

// The state is checked as a whole (the bounds of the layers and the size are in the schema and below). The conversation id's
// format is checked first, as the conversation API does (a UUID); whose it is, is checked where its owner is (`requireOwnedConversation`).
const saveMapSchema = z.object({
  conversationId: z.uuid().optional(),
  mapId: mapIdSchema.optional(),
  title: mapTitleSchema,
  state: persistedMapStateSchema
});

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/** The message of the first problem, by the argument it is in. */
function messageOf(issue: z.core.$ZodIssue): string {
  const [argument, part] = issue.path;
  if (argument === 'mapId') return 'Invalid map id';
  if (argument === 'conversationId') return 'Invalid conversation id';
  if (argument === 'title') return `The title must be ${mapsConfig.title.minChars} to ${mapsConfig.title.maxChars} characters`;
  if (argument === 'state' && part === 'layers' && issue.path.length === 2 && issue.code === 'too_big') {
    return `A map has at most ${mapsConfig.maxLayers} layers`;
  }
  if (argument === 'state') return 'Invalid map state';
  return 'Invalid request';
}

export function checkSaveMap(value: SaveMapInput): Checked<CheckedSaveMap> {
  const parsed = saveMapSchema.safeParse(value);
  if (!parsed.success) return { ok: false, message: messageOf(parsed.error.issues[0]) };
  // The browser guards each SQL again when it restores the map; this is early feedback, and keeps what no restore could run out of the store.
  const rejected = parsed.data.state.layers.find(({ sql }) => !validateSql(sql, datasetIds).ok);
  if (rejected) return { ok: false, message: `The SQL of layer ${rejected.id} is not allowed` };
  const stateJson = JSON.stringify(parsed.data.state);
  if (utf8Bytes(stateJson) > mapsConfig.maxStateBytes) return { ok: false, message: 'The map is too large' };
  return { ok: true, value: { ...parsed.data, stateJson } };
}
