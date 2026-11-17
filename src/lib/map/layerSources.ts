import type { GeoJsonFeatureCollection } from '../duckdb/queryTypes';
import { mapLayerIds } from './drawOrder';
import { derivedLabelPoints, type LabelPointCollection } from './labelPoint';
import { toMapLibreLayers, usesLabelPoints, type MapLibreLayerSpec, type StyledLayer } from './styleCompiler';

/**
 * What the map holds for the layers (the map view mounts exactly this): a GeoJSON source per entry, with the map layers
 * that sit in it. A layer with no features yet has no entry. The map layers sit inside their source, so a source goes
 * after its layers. A polygon layer's labels are in a second source of one point per feature, placed after the geometry source.
 */
export type MapSource = {
  /** The source id. */
  id: string;
  /** The index of the layer in the draw order (bottom to top) the source belongs to. */
  index: number;
  data: GeoJsonFeatureCollection | LabelPointCollection;
  layers: MapLibreLayerSpec[];
};

/** The sources of the layers listed bottom to top; `featuresOf` gives a layer's features (undefined while it has none). */
export function mapSourcesOf(bottomUp: readonly StyledLayer[], featuresOf: (layerId: string) => GeoJsonFeatureCollection | undefined): MapSource[] {
  return bottomUp.flatMap((layer, index): MapSource[] => {
    const features = featuresOf(layer.id);
    if (!features) return [];
    const ids = mapLayerIds(layer.id);
    const specs = toMapLibreLayers(layer);
    const own: MapSource = { id: ids.source, index, data: features, layers: specs.filter((spec) => spec.source === ids.source) };
    if (!usesLabelPoints(layer)) return [own];
    return [own, { id: ids.labelSource, index, data: derivedLabelPoints(features), layers: specs.filter((spec) => spec.source === ids.labelSource) }];
  });
}
