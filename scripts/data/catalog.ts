/**
 * Regenerates `shared/catalog.json` from the existing files in `data/dist/`: `npm run data:catalog` (run it from the
 * repository root, after editing the texts in `catalog.config.ts`). `npm run data:convert` ends with the same step.
 * Needs the spatial extension (DuckDB installs it on the first run); reads only `data/dist/`, writes only the catalog.
 */
import { writeCatalog } from './catalog-write.js';
import { openDatabase } from './convert-io.js';

try {
  await writeCatalog(await openDatabase());
} catch (error) {
  console.error(error instanceof Error ? `data:catalog failed: ${error.message}` : 'data:catalog failed.');
  process.exitCode = 1;
}
