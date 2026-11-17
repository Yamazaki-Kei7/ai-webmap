import { ensureViews, queryScalar } from './engine';

/** Browser-check helpers; the page installs them only when `import.meta.env.DEV`. */
export type EngineDevHandle = {
  ensureViews: (ids: readonly string[]) => Promise<void>;
  /** `SELECT count(*)` of a view (registered first if needed). */
  count: (id: string) => Promise<number>;
  /** The first value of the first row of a query, as text (for the settings experiments). */
  scalar: (sql: string) => Promise<string>;
};

declare global {
  interface Window {
    __aiWebmapEngine?: EngineDevHandle;
  }
}

export function installDevHandle(): void {
  window.__aiWebmapEngine = {
    ensureViews,
    count: async (id) => {
      await ensureViews([id]);
      return Number(await queryScalar(`SELECT count(*) FROM "${id}"`));
    },
    scalar: queryScalar
  };
}
