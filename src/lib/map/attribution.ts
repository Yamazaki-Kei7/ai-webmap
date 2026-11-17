import { catalog, type CatalogDataset } from '../../../shared/catalog';
import { legendConfig } from '../../../shared/config';
import type { LayerState } from './mapState.svelte';

export type DataSource = CatalogDataset['source'];

const { attribution } = legendConfig;

/** What tells two sources apart: the key of the de-duplication, and of the list that shows them. */
export const sourceKey = (source: DataSource): string => `${source.name}\n${source.url}\n${source.year}`;

/** The sources of the datasets the visible layers read, in the order they are met, each once (datasets of one source count once). */
export function visibleSources(layers: readonly Pick<LayerState, 'visible' | 'datasetIds'>[]): DataSource[] {
  const byDataset = new Map(catalog.map((dataset) => [dataset.id, dataset.source]));
  const sources = new Map<string, DataSource>();
  for (const layer of layers) {
    if (!layer.visible) continue;
    for (const id of layer.datasetIds) {
      const source = byDataset.get(id);
      if (source) sources.set(sourceKey(source), source);
    }
  }
  return [...sources.values()];
}

const parenthesized = /（[^（）]*）/g;

/**
 * The publisher a source name stands for: the name without the parenthesised dataset name, keeping the last
 * parenthesis, which is the body that publishes it ("国土数値情報（行政区域データ）（国土交通省）" -> "国土数値情報（国土交通省）").
 */
export function publisherOf(sourceName: string): string {
  const groups = sourceName.match(parenthesized) ?? [];
  const [first, last] = [groups[0], groups.at(-1)];
  if (groups.length < 2 || first === undefined || last === undefined) return sourceName;
  return `${sourceName.slice(0, sourceName.indexOf(first))}${last}`;
}

/** The one-line attribution: the first publisher, 「ほか N 件」 for the other publishers, and the licence. Null without a source. */
export function attributionLine(sources: readonly DataSource[]): string | null {
  const publishers = [...new Set(sources.map((source) => publisherOf(source.name)))];
  if (publishers.length === 0) return null;
  const [first, ...others] = publishers;
  const text =
    others.length === 0
      ? attribution.line.replace('{publisher}', first)
      : attribution.lineMore.replace('{publisher}', first).replace('{n}', String(others.length));
  return `${text}（${attribution.licenseLabel}）`;
}
