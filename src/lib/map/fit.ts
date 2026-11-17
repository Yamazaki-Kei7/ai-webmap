import type { Bbox } from '../duckdb/queryTypes';

export type FitBounds = [[number, number], [number, number]];

type Fittable = { id: string; featureCount: number; bbox: Bbox };

/**
 * What to fit the map to after the layers changed: the latest layer that is new (not in `fitted`), unless it has no
 * feature (its box is a placeholder). `fitted` takes up every new layer, empty ones too.
 */
export function pickFitBounds(layers: readonly Fittable[], fitted: Set<string>): FitBounds | undefined {
  const fresh = layers.filter((layer) => !fitted.has(layer.id));
  for (const layer of fresh) fitted.add(layer.id);
  const latest = fresh.at(-1);
  if (!latest || latest.featureCount === 0) return undefined;
  const [west, south, east, north] = latest.bbox;
  return [
    [west, south],
    [east, north]
  ];
}
