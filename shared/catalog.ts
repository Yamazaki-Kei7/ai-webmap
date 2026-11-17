import catalogJson from './catalog.json';
import { parseCatalog } from './catalog-schema.js';

/**
 * The dataset catalog of the repository (`shared/catalog.json`), validated when the module loads: the source of the
 * dataset list at run time (the backend, the browser, the upload validation). The schemas are in `catalog-schema.ts`
 * and are re-exported here. Imports a generated file, so nothing the catalog generator loads may import this module.
 */
export * from './catalog-schema.js';

export const catalog = parseCatalog(catalogJson);
