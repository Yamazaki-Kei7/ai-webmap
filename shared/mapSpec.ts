import { z } from 'zod';
import { dataConfig, queryConfig, styleConfig } from './config';

/**
 * The kinds of geometry a dataset holds: a point (POINT), a line (LINESTRING or MULTILINESTRING) or a polygon (POLYGON
 * or MULTIPOLYGON). MULTIPOINT is not a catalog geometry.
 */
export const geometryFamilySchema = z.enum(['point', 'line', 'polygon']);

export type GeometryFamily = z.infer<typeof geometryFamilySchema>;

/*
 * Layer styles, labels and view targets the model sets (Phase 3). The model names a style at a semantic level
 * ("graduated by `price`, 5 quantile classes, palette `ylorrd`"); the browser resolves it against the loaded features
 * (`src/lib/map/styleCompiler.ts`). The objects are strict: an unknown key is an error the model can read. Defaults are
 * not filled in here, so a stored spec stays as the model wrote it.
 */

export const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a 6-digit hex colour such as "#1f78b4".');

export type HexColor = z.infer<typeof hexColorSchema>;

/** Palette names only; the colours are in `src/lib/map/palettes.ts` (the backend cannot import `src/lib`). */
export const sequentialPaletteSchema = z.enum(['blues', 'greens', 'reds', 'oranges', 'purples', 'ylorrd', 'viridis']);
export type SequentialPalette = z.infer<typeof sequentialPaletteSchema>;

export const qualitativePaletteSchema = z.enum(['set2', 'tableau10', 'paired']);
export type QualitativePalette = z.infer<typeof qualitativePaletteSchema>;

const { classification } = dataConfig;

const columnSchema = z.string().min(1, 'Name a column.').max(styleConfig.maxColumnChars);

const styleCommonShape = {
  opacity: z.number().min(styleConfig.opacity.min).max(styleConfig.opacity.max).optional(),
  strokeColor: hexColorSchema.optional(),
  strokeWidth: z.number().positive().max(styleConfig.maxStrokeWidth).optional(),
  /** Point radius and line width in pixels (a polygon's outline is `strokeWidth`). */
  size: z.number().positive().max(styleConfig.maxSize).optional()
};

const singleStyleSchema = z.strictObject({
  ...styleCommonShape,
  type: z.literal('single'),
  color: hexColorSchema
});

const categorizedStyleSchema = z.strictObject({
  ...styleCommonShape,
  type: z.literal('categorized'),
  column: columnSchema,
  palette: qualitativePaletteSchema.optional(),
  /** Colours of named values; the key is the value as text. */
  overrides: z
    .record(z.string().max(styleConfig.maxCategoryValueChars), hexColorSchema)
    .refine((overrides) => Object.keys(overrides).length <= classification.maxCategories, {
      message: `Give at most ${classification.maxCategories} overrides.`
    })
    .optional()
});

const gradedStyleSchema = z
  .strictObject({
    ...styleCommonShape,
    type: z.literal('graduated'),
    column: columnSchema,
    method: z.enum(['quantile', 'equal', 'manual']),
    classes: z.number().int().min(classification.minClasses).max(classification.maxClasses).optional(),
    /** Only for `method: "manual"`: the internal class boundaries, ascending. */
    breaks: z.array(z.number()).min(1).max(classification.maxClasses - 1).optional(),
    palette: sequentialPaletteSchema.optional(),
    reverse: z.boolean().optional()
  })
  .superRefine((style, ctx) => {
    if (style.method === 'manual') {
      if (style.classes !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['classes'],
          message: 'With method manual, give breaks only; the number of classes is breaks.length + 1.'
        });
      }
      if (style.breaks === undefined) {
        ctx.addIssue({ code: 'custom', path: ['breaks'], message: 'method "manual" requires breaks.' });
        return;
      }
      const { breaks } = style;
      if (!breaks.every((value, i) => i === 0 || value > breaks[i - 1])) {
        ctx.addIssue({ code: 'custom', path: ['breaks'], message: 'breaks must be strictly ascending.' });
      }
    } else if (style.breaks !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['breaks'],
        message: 'breaks are only for method "manual"; use classes with "quantile" or "equal".'
      });
    }
  });

const proportionalStyleSchema = z
  .strictObject({
    ...styleCommonShape,
    type: z.literal('proportional'),
    column: columnSchema,
    color: hexColorSchema,
    /** Radii in pixels of the smallest and the largest symbol. */
    minRadius: z.number().positive().max(styleConfig.maxRadius).optional(),
    maxRadius: z.number().positive().max(styleConfig.maxRadius).optional()
  })
  .refine(({ minRadius, maxRadius }) => minRadius === undefined || maxRadius === undefined || minRadius < maxRadius, {
    path: ['minRadius'],
    message: 'minRadius must be smaller than maxRadius.'
  });

export const styleSpecSchema = z.discriminatedUnion('type', [
  singleStyleSchema,
  categorizedStyleSchema,
  gradedStyleSchema,
  proportionalStyleSchema
]);

export type StyleSpec = z.infer<typeof styleSpecSchema>;

export const labelSpecSchema = z.strictObject({
  column: columnSchema,
  size: z.number().positive().max(styleConfig.maxLabelSize).optional(),
  color: hexColorSchema.optional(),
  haloColor: hexColorSchema.optional(),
  haloWidth: z.number().positive().max(styleConfig.maxHaloWidth).optional(),
  /** The labels show from this zoom level up. */
  minZoom: z.number().min(styleConfig.zoom.min).max(styleConfig.zoom.max).optional()
});

export type LabelSpec = z.infer<typeof labelSpecSchema>;

const longitudeSchema = z.number().min(-180).max(180);
const latitudeSchema = z.number().min(-90).max(90);

export const viewTargetSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('layer'), layerId: z.string().min(1).max(styleConfig.maxLayerIdChars) }),
  z
    .strictObject({
      type: z.literal('bbox'),
      /** [minLon, minLat, maxLon, maxLat] */
      bbox: z.tuple([longitudeSchema, latitudeSchema, longitudeSchema, latitudeSchema])
    })
    .refine(({ bbox: [west, south, east, north] }) => west <= east && south <= north, {
      path: ['bbox'],
      message: 'bbox must be [minLon, minLat, maxLon, maxLat] with min <= max.'
    }),
  z.strictObject({
    type: z.literal('center'),
    /** [lon, lat] */
    center: z.tuple([longitudeSchema, latitudeSchema]),
    zoom: z.number().min(styleConfig.zoom.min).max(styleConfig.zoom.max)
  }),
  z.strictObject({ type: z.literal('query'), sql: z.string().min(1).max(queryConfig.maxSqlChars) })
]);

export type ViewTarget = z.infer<typeof viewTargetSchema>;
