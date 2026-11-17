import { z } from 'zod';
import { chatConfig } from '../../../shared/config';

/** The conversation a tab is in, and whose it is: a reload answers what the conversation left pending, and never one of another user. */
const storedSchema = z.strictObject({ owner: z.string(), conversationId: z.string() });

export type StoredConversation = z.infer<typeof storedSchema>;

export type ConversationStore = {
  read: () => StoredConversation | null;
  write: (entry: StoredConversation) => void;
  clear: () => void;
};

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * Over a `sessionStorage`-like store, given as a function because even reaching `sessionStorage` can throw (blocked site
 * data). Every failure is swallowed: the chat works without the memory, it only cannot answer the pending after a reload.
 */
export function createConversationStore(getStorage: () => StorageLike): ConversationStore {
  const key = chatConfig.storageKey;
  return {
    read() {
      try {
        const raw = getStorage().getItem(key);
        if (raw === null) return null;
        const parsed = storedSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
    write(entry) {
      try {
        getStorage().setItem(key, JSON.stringify(entry));
      } catch {
        // No memory: nothing to answer after a reload.
      }
    },
    clear() {
      try {
        getStorage().removeItem(key);
      } catch {
        // As above.
      }
    }
  };
}
