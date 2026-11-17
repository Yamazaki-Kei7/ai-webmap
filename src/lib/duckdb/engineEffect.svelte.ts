import type { EngineStatus } from './engineCore';

export type EngineStarter = (onStatus: (status: EngineStatus) => void) => Promise<void>;

export type EngineBindingDeps = {
  /** The signed-in user, or null when signed out. A new object for the same user (a re-notification) changes nothing. */
  getUser: () => { username: string } | null;
  initEngine: EngineStarter;
  disposeEngine: () => Promise<void>;
  setStatus: (status: EngineStatus) => void;
};

/** Starts the engine; the failure is already in the status. */
export function runEngine(start: EngineStarter, setStatus: (status: EngineStatus) => void): void {
  start(setStatus).catch(() => undefined);
}

/**
 * Ties the engine to the signed-in user (call during component initialisation): it starts for a user, and is
 * disposed and started again when the user changes — also from one user straight to another — and at sign-out.
 */
export function bindEngineToUser({ getUser, initEngine, disposeEngine, setStatus }: EngineBindingDeps): void {
  // The key is the user name (never shown or logged), so the effect runs again only when the user changes.
  const owner = $derived(getUser()?.username ?? null);
  $effect(() => {
    if (owner === null) return;
    runEngine(initEngine, setStatus);
    return () => {
      void disposeEngine();
      setStatus({ state: 'idle' });
    };
  });
}
