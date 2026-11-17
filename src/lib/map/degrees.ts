import { bboxSchema } from '../../../shared/catalog-schema';
import { toolError, type ClientToolResult } from '../../../shared/toolProtocol';
import type { LayerQueryResult } from '../duckdb/queryTypes';

/**
 * A layer whose geometries leave longitude/latitude cannot be answered (the answer would fail the backend's schema) or
 * drawn: it is refused before it is added. Undefined when the layer is fine (or has no feature). Adding and restoring share it.
 */
export function outsideDegrees(data: LayerQueryResult): ClientToolResult<never> | undefined {
  if (data.featureCount === 0 || bboxSchema.safeParse(data.bbox).success) return undefined;
  return toolError(
    'SQL_ERROR',
    'The geometries are outside longitude/latitude degrees.',
    'Distances and buffers on this data are in degrees: use the _spheroid functions for metres, or ST_DWithin in degrees, as the prompt says.'
  );
}
