import { KVStore } from '@aws-blocks/blocks';
import { scope } from './scope.js';

/**
 * Who owns which conversation: conversation id to the user name, written when the id is issued. The Agent block cannot
 * answer this with one lookup (it lists a user's conversations), so ownership is checked here with a single `get`.
 */
export const conversationOwners = new KVStore<string>(scope, 'conversationOwners');
