import type { ChatSession } from './chatSession.svelte';

export type ChatBindingDeps = {
  /** The signed-in user's name, or null when signed out. A new object for the same user changes nothing (the name is the key). */
  getOwner: () => string | null;
  createSession: (owner: string) => ChatSession;
};

/**
 * Ties the chat session to the signed-in user (call during component initialisation), as the engine and the map are: a
 * session is made for a user, and disposed when the user changes — also from one user straight to another — and at sign-out,
 * so that no conversation, message or pending tool call of one user reaches another.
 */
export function bindChatToUser({ getOwner, createSession }: ChatBindingDeps): { readonly session: ChatSession | undefined } {
  const owner = $derived(getOwner());
  let session = $state.raw<ChatSession>();
  $effect(() => {
    if (owner === null) return;
    const created = createSession(owner);
    session = created;
    return () => {
      created.dispose();
      session = undefined;
    };
  });
  return {
    get session() {
      return session;
    }
  };
}
