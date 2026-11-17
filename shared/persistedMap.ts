import { z } from 'zod';
import { mapsConfig, queryConfig, styleConfig, toolConfig } from './config';
import { labelSpecSchema, layerIdPattern, mapContextSchema, styleSpecSchema } from './mapSpec';

/**
 * What a saved map keeps (Phase 2, design 4.1): the view and, per layer, what rebuilds it: the SQL, the style, the label and
 * the visibility. Never the features or anything resolved from them: a restore runs each layer's SQL again. The objects
 * are strict, so nothing else can be stored. `version` lets a later release migrate old records.
 */
export const persistedMapVersion = 1;
// A stored map is read back through these same schemas: making any limit or shape stricter later must come with a `version`
// increase and a migration of the old records on read, or the maps saved before it become unreadable.

const codePoints = (text: string): number => Array.from(text).length;

/** The same view as the map context the model gets: the centre `[lon, lat]` and the zoom. */
const viewSchema = z.strictObject({
  center: mapContextSchema.shape.view.shape.center,
  zoom: z.number().min(styleConfig.zoom.min).max(styleConfig.zoom.max)
});

export const persistedLayerSchema = z.strictObject({
  id: z.string().max(styleConfig.maxLayerIdChars).regex(layerIdPattern),
  name: z.string().min(1).max(toolConfig.maxLayerNameChars),
  sql: z.string().min(1).max(queryConfig.maxSqlChars),
  style: styleSpecSchema,
  label: labelSpecSchema.nullable(),
  visible: z.boolean()
});

export const persistedMapStateSchema = z.strictObject({
  version: z.literal(persistedMapVersion),
  view: viewSchema,
  layers: z
    .array(persistedLayerSchema)
    .max(mapsConfig.maxLayers)
    .refine((layers) => new Set(layers.map(({ id }) => id)).size === layers.length, { message: 'Layer ids must be unique.' }),
  /** The number the browser gives the next layer it adds ("L" and this number). */
  nextLayerSeq: z.number().int().nonnegative()
});

export type PersistedMapState = z.infer<typeof persistedMapStateSchema>;

/**
 * A map title: `mapsConfig.title` characters (code points), not blank. The first bound is on UTF-16 units (at most two
 * per code point), so that a huge string is refused before it is counted.
 */
export const mapTitleSchema = z
  .string()
  .max(mapsConfig.title.maxChars * 2)
  .refine((title) => codePoints(title) >= mapsConfig.title.minChars && codePoints(title) <= mapsConfig.title.maxChars)
  .refine((title) => title.trim() !== '');

/** A map id the server issues (a UUID, URL-safe). */
export const mapIdSchema = z.uuid();

/** What `getMap` answers. */
export const savedMapSchema = z.strictObject({
  mapId: mapIdSchema,
  title: mapTitleSchema,
  state: persistedMapStateSchema,
  conversationId: z.uuid().optional(),
  updatedAt: z.number().int().nonnegative()
});

export type SavedMap = z.infer<typeof savedMapSchema>;

/** One row of `listMaps`: no state. */
export type SavedMapSummary = Pick<SavedMap, 'mapId' | 'title' | 'updatedAt'>;
