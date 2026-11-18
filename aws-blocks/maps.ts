import { randomUUID } from 'node:crypto';
import type { BlocksContext } from '@aws-blocks/blocks';
import type { SavedMap, SavedMapSummary } from '../shared/persistedMap.js';
import { requireAllowedUser } from './access.js';
import { requireOwnedConversation } from './conversation-access.js';
import { conversationOwners } from './conversation-owners.js';
import { deleteMapRecord, getMapRecord, listMapRecords, saveMapRecord, unwrapMapInput } from './maps-access.js';
import { checkMapId, checkSaveMap, type SaveMapInput } from './maps-input.js';
import { maps } from './maps-table.js';

/**
 * The saved-maps API (the map methods of `api`). Each method: sign-in and the allow-list first, then the arguments, then the
 * records of the signed-in user only: the owner is the user name the sign-in returns, never an argument.
 */
export function mapsMethods(context: BlocksContext) {
  return {
    async saveMap(input: SaveMapInput): Promise<{ mapId: string; updatedAt: number }> {
      const { username } = await requireAllowedUser(context);
      const checked = unwrapMapInput(checkSaveMap(input));
      // A conversation is stored only as the caller's own (a foreign or unknown id is a 404, as in the conversation API).
      if (checked.conversationId !== undefined) await requireOwnedConversation(conversationOwners, username, checked.conversationId);
      return saveMapRecord(maps, username, checked, { now: Date.now, newMapId: randomUUID });
    },

    async listMaps(): Promise<{ maps: SavedMapSummary[] }> {
      const { username } = await requireAllowedUser(context);
      return listMapRecords(maps, username);
    },

    async getMap(mapId: string): Promise<SavedMap> {
      const { username } = await requireAllowedUser(context);
      return getMapRecord(maps, username, unwrapMapInput(checkMapId(mapId)));
    },

    async deleteMap(mapId: string): Promise<{ success: true }> {
      const { username } = await requireAllowedUser(context);
      return deleteMapRecord(maps, username, unwrapMapInput(checkMapId(mapId)));
    }
  };
}
