import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DuckDBConnection } from '@duckdb/node-api';
import { z } from 'zod';
import { catalogSchema, type Catalog, type CatalogDataset } from '../../shared/catalog-schema.js';
import { dataConfig } from '../../shared/config.js';
import { datasetFileName } from '../../shared/dataset-files.js';
import {
  assembleDataset,
  bboxOf,
  buildDescribeSql,
  buildDistinctCountSql,
  buildExtentSql,
  buildGeometryTypesSql,
  buildStatsSql,
  buildTopValuesSql,
  catalogColumnType,
  checkColumnTexts,
  geometryFamilyOf,
  listedValuesLimit,
  missingDatasetFileMessage,
  parquetRelation,
  serializeCatalog,
  type MeasuredColumn,
  type MeasuredDataset
} from './catalog-plan.js';
import { catalogFile, convertCommand, datasetTexts, type DatasetText, type ValuesKind } from './catalog.config.js';
import { count, log, queryOne, queryRows } from './convert-io.js';
import { conversionConfig, datasetIds } from './datasets.config.js';

/**
 * Measures the dataset files of `data/dist/` and writes the catalog: shared by `npm run data:convert` (its last step)
 * and `npm run data:catalog`. The connection needs the spatial extension (geometry types and extents).
 */

const describedColumn = z.object({ column_name: z.string(), column_type: z.string() });
const geometryTypeRow = z.object({ geometry_type: z.string() });
const extentRow = z.object({
  feature_count: count,
  min_lon: z.number(),
  min_lat: z.number(),
  max_lon: z.number(),
  max_lat: z.number()
});
const statsRow = z.object({ min: z.number().nullable(), max: z.number().nullable() });
const topValueRow = z.object({ value: z.string(), count });
const distinctRow = z.object({ distinct_count: count });

/** Measures one column: the range of a number column; the values of a string column that is flagged for them (`all` or `top`). */
export async function measureColumn(
  connection: DuckDBConnection,
  relation: string,
  datasetId: string,
  column: { name: string; type: MeasuredColumn['type'] },
  valuesKind: ValuesKind | undefined
): Promise<MeasuredColumn> {
  if (column.type === 'number') {
    const { min, max } = await queryOne(connection, buildStatsSql(relation, column.name), statsRow);
    // A column with no value at all has no range.
    return min === null || max === null ? column : { ...column, stats: { min, max } };
  }
  if (valuesKind === undefined) return column;
  const { distinct_count } = await queryOne(connection, buildDistinctCountSql(relation, column.name), distinctRow);
  const limit = listedValuesLimit(datasetId, column.name, valuesKind, distinct_count);
  const values = await queryRows(connection, buildTopValuesSql(relation, column.name, limit), topValueRow);
  return { ...column, topValues: values, distinctCount: distinct_count };
}

async function measureDataset(connection: DuckDBConnection, text: DatasetText): Promise<MeasuredDataset> {
  const file = datasetFileName(text.id);
  const path = join(conversionConfig.dirs.dist, file);
  if (!existsSync(path)) throw new Error(missingDatasetFileMessage(path, convertCommand));
  const relation = parquetRelation(path);
  const geometryColumn = conversionConfig.geometryColumn;

  const described = await queryRows(connection, buildDescribeSql(relation), describedColumn);
  if (!described.some((column) => column.column_name === geometryColumn)) {
    throw new Error(`Dataset "${text.id}": ${path} has no geometry column "${geometryColumn}".`);
  }
  const attributes = described
    .filter((column) => column.column_name !== geometryColumn)
    .map((column) => ({ name: column.column_name, type: catalogColumnType(text.id, column.column_name, column.column_type) }));
  // Both directions of the text check run before any measuring.
  checkColumnTexts(text.id, attributes, text.columns);

  const geometryTypes = await queryRows(connection, buildGeometryTypesSql(relation, geometryColumn), geometryTypeRow);
  const extent = await queryOne(connection, buildExtentSql(relation, geometryColumn), extentRow);
  const columns: MeasuredColumn[] = [];
  for (const attribute of attributes) {
    const valuesKind = text.columns.find((columnText) => columnText.name === attribute.name)?.values;
    columns.push(await measureColumn(connection, relation, text.id, attribute, valuesKind));
  }
  return {
    file,
    geometryType: geometryFamilyOf(text.id, geometryTypes.map((row) => row.geometry_type)),
    featureCount: extent.feature_count,
    bbox: bboxOf({ minLon: extent.min_lon, minLat: extent.min_lat, maxLon: extent.max_lon, maxLat: extent.max_lat }),
    columns
  };
}

function datasetText(id: string): DatasetText {
  const found = datasetTexts.find((text) => text.id === id);
  if (found === undefined) throw new Error(`No catalog text for dataset "${id}" in catalog.config.ts.`);
  return found;
}

/** The catalog of the files in `data/dist/`, validated with the schema of `shared/catalog-schema.ts`. */
export async function buildCatalog(connection: DuckDBConnection): Promise<Catalog> {
  const datasets: CatalogDataset[] = [];
  for (const id of datasetIds) {
    const text = datasetText(id);
    datasets.push(assembleDataset(text, await measureDataset(connection, text)));
  }
  return catalogSchema.parse(datasets);
}

/** Writes `shared/catalog.json`, only when the catalog is valid. */
export async function writeCatalog(connection: DuckDBConnection): Promise<void> {
  const catalog = await buildCatalog(connection);
  const json = serializeCatalog(catalog);
  writeFileSync(catalogFile, json);
  const minified = JSON.stringify(catalog).length;
  log(`Catalog: ${catalogFile} (${catalog.length} datasets, ${minified} characters minified, limit ${dataConfig.catalog.maxJsonChars}).`);
}
