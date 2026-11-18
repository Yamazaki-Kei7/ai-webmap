import { DistributedTable } from '@aws-blocks/blocks';
import { mapRecordSchema } from './maps-access.js';
import { scope } from './scope.js';

/**
 * The saved maps: one record per map, partitioned by the owner's user name (the one `requireAllowedUser` returns; the same
 * identity as the conversation owner records), sorted by the map id. A user's maps are therefore one partition: every read
 * and write names the owner, so no method can reach another user's map. The table is created by the first deploy.
 */
export const maps = new DistributedTable(scope, 'maps', {
  schema: mapRecordSchema,
  key: { partitionKey: 'userId', sortKey: 'mapId' }
});
