/**
 * The file-naming rule of the dataset files, on its own so that the conversion and the catalog generator can use it
 * without importing the generated catalog (`shared/datasets.ts` derives the lists from the catalog).
 */

export const parquetExtension = '.parquet';

/** The file of a dataset, derived from its id. */
export function datasetFileName(id: string): string {
  return `${id}${parquetExtension}`;
}
