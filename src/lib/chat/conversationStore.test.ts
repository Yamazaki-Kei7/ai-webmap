import { describe, expect, it } from 'vitest';
import { chatConfig } from '../../../shared/config';
import { createConversationStore } from './conversationStore';

function fakeStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key)
  };
}

const failing = () => {
  throw new Error('blocked');
};

describe('createConversationStore', () => {
  it('writes, reads and clears the entry under the configured key', () => {
    const storage = fakeStorage();
    const store = createConversationStore(() => storage);
    expect(store.read()).toBeNull();
    store.write({ owner: 'a', conversationId: 'c1' });
    expect(storage.items.has(chatConfig.storageKey)).toBe(true);
    expect(store.read()).toEqual({ owner: 'a', conversationId: 'c1' });
    store.clear();
    expect(store.read()).toBeNull();
  });

  it('reads nothing from an entry that is not valid', () => {
    for (const raw of ['not json', '{"owner":"a"}', '{"owner":"a","conversationId":"c","extra":1}', '[]', 'null']) {
      expect(createConversationStore(() => fakeStorage({ [chatConfig.storageKey]: raw })).read(), raw).toBeNull();
    }
  });

  it('swallows every failure of the storage, even reaching it', () => {
    const throwing = { getItem: failing, setItem: failing, removeItem: failing };
    for (const getStorage of [() => throwing, failing]) {
      const store = createConversationStore(getStorage);
      expect(store.read()).toBeNull();
      expect(() => store.write({ owner: 'a', conversationId: 'c' })).not.toThrow();
      expect(() => store.clear()).not.toThrow();
    }
  });
});
