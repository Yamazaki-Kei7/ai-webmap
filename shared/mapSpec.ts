import { z } from 'zod';

/**
 * The kinds of geometry a dataset holds: a point (POINT), a line (LINESTRING or MULTILINESTRING) or a polygon (POLYGON
 * or MULTIPOLYGON). MULTIPOINT is not a catalog geometry.
 */
export const geometryFamilySchema = z.enum(['point', 'line', 'polygon']);

export type GeometryFamily = z.infer<typeof geometryFamilySchema>;
