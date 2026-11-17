import { z } from 'zod';
import { dataConfig } from './config.js';
import { geometryFamilySchema } from './mapSpec.js';

/**
 * The schemas of the dataset catalog and the function that validates a value into one. The catalog is data about the
 * dataset files (`shared/catalog.json`, written by `npm run data:catalog`) and goes into the model's prompt.
 * No Node-only import: the module runs in the browser too. It does not import the catalog file itself (the generator
 * validates what it is about to write with these schemas, and must run when the file is absent): `shared/catalog.ts` loads the file.
 */

/** What a JSON file can hold; the input type of `parseCatalog`. A key that is `undefined` counts as absent (the type TypeScript infers for a JSON module's optional keys). */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue | undefined };

export const columnTypeSchema = z.enum(['string', 'number', 'boolean']);

const topValueSchema = z.strictObject({ value: z.string(), count: z.number().int().positive() });

const statsSchema = z.strictObject({ min: z.number(), max: z.number() });

/** The most values a `topValues` list may hold: a complete list of a categorical column, or the top of a name column. */
export const maxListedValues = Math.max(dataConfig.catalog.topValuesLimit, dataConfig.catalog.allValuesLimit);

export const catalogColumnSchema = z
  .strictObject({
    name: z.string().min(1),
    type: columnTypeSchema,
    description: z.string().min(1),
    unit: z.string().min(1).optional(),
    /** Minimum and maximum of the non-NULL values of a numeric column. */
    stats: statsSchema.optional(),
    /**
     * The values (NULL excluded) of a string column that is flagged for it, by count descending, then value ascending:
     * all of them for a categorical column, the most frequent ones for a name column. The list is complete exactly when
     * its length equals `distinctCount`.
     */
    topValues: z.array(topValueSchema).max(maxListedValues).optional(),
    /** The number of distinct non-NULL values: present exactly when `topValues` is, so that "all values" can be told from "the top N of M". */
    distinctCount: z.number().int().nonnegative().optional()
  })
  .superRefine((column, ctx) => {
    if (column.stats !== undefined) {
      if (column.type !== 'number') ctx.addIssue({ code: 'custom', path: ['stats'], message: 'stats belong to a number column' });
      if (column.stats.min > column.stats.max) ctx.addIssue({ code: 'custom', path: ['stats'], message: 'stats.min is greater than stats.max' });
    }
    if ((column.topValues === undefined) !== (column.distinctCount === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['topValues'], message: 'topValues and distinctCount come together' });
    }
    if (column.topValues !== undefined) {
      if (column.type !== 'string') ctx.addIssue({ code: 'custom', path: ['topValues'], message: 'topValues belong to a string column' });
      if (column.distinctCount !== undefined && column.distinctCount < column.topValues.length) {
        ctx.addIssue({ code: 'custom', path: ['distinctCount'], message: 'distinctCount is less than the number of topValues' });
      }
      const values = column.topValues.map((entry) => entry.value);
      if (new Set(values).size !== values.length) ctx.addIssue({ code: 'custom', path: ['topValues'], message: 'a value is listed twice in topValues' });
    }
  });

const maxLongitude = 180;
const maxLatitude = 90;

/** minLon, minLat, maxLon, maxLat: ordered, and inside the longitude and latitude ranges. */
export const bboxSchema = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .superRefine(([minLon, minLat, maxLon, maxLat], ctx) => {
    if (minLon > maxLon || minLat > maxLat) ctx.addIssue({ code: 'custom', message: 'bbox is not ordered (minLon, minLat, maxLon, maxLat)' });
    if (Math.abs(minLon) > maxLongitude || Math.abs(maxLon) > maxLongitude) ctx.addIssue({ code: 'custom', message: 'bbox longitude is outside -180..180' });
    if (Math.abs(minLat) > maxLatitude || Math.abs(maxLat) > maxLatitude) ctx.addIssue({ code: 'custom', message: 'bbox latitude is outside -90..90' });
  });

/** A plain lower-case SQL identifier: the id is the name of the DuckDB view. */
const datasetIdPattern = /^[a-z][a-z0-9_]*$/;

export const catalogDatasetSchema = z
  .strictObject({
    id: z.string().regex(datasetIdPattern, 'a dataset id is a lower-case SQL identifier'),
    title: z.string().min(1),
    /** What one row is. */
    description: z.string().min(1),
    file: z.string().min(1),
    geometryType: geometryFamilySchema,
    featureCount: z.number().int().positive(),
    bbox: bboxSchema,
    source: z.strictObject({
      name: z.string().min(1),
      url: z.url({ protocol: /^https?$/ }),
      year: z.string().min(1),
      license: z.string().min(1)
    }),
    /** The attribute columns, in the order of the file; the geometry column is not listed. */
    columns: z.array(catalogColumnSchema).min(1),
    /** Short cautions for the model: each one changes how a query or a style must be written. */
    notes: z.array(z.string().min(1)).optional()
  })
  .superRefine((dataset, ctx) => {
    const names = dataset.columns.map((column) => column.name);
    if (new Set(names).size !== names.length) {
      ctx.addIssue({ code: 'custom', path: ['columns'], message: `dataset "${dataset.id}" has a column name twice` });
    }
  });

export const catalogSchema = z.array(catalogDatasetSchema).min(1).superRefine((datasets, ctx) => {
  const ids = datasets.map((dataset) => dataset.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'a dataset id is used twice' });
  const files = datasets.map((dataset) => dataset.file);
  if (new Set(files).size !== files.length) ctx.addIssue({ code: 'custom', message: 'a dataset file name is used twice' });
});

export type CatalogColumn = z.infer<typeof catalogColumnSchema>;
export type CatalogDataset = z.infer<typeof catalogDatasetSchema>;
export type Catalog = z.infer<typeof catalogSchema>;

/** Validates a value into a catalog; throws a `ZodError` that names the place of each problem. */
export function parseCatalog(value: JsonValue): Catalog {
  return catalogSchema.parse(value);
}
