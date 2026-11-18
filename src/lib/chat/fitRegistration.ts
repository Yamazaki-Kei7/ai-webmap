import type { ClientToolResult } from '../../../shared/toolProtocol';
import type { LayerQueryResult } from '../duckdb/queryTypes';
import type { LayerState, NewLayer } from '../map/mapState.svelte';

type AddLayer = (input: NewLayer, data: LayerQueryResult) => ClientToolResult<LayerState>;

/**
 * Wraps `addLayer` so that a layer it adds is put in `fitted`: the tool executor moves the map itself (or leaves it, for
 * `zoomTo: false`), so the map view's own fit must skip the layer.
 */
export function markingFitted(add: AddLayer, fitted: Set<string>): AddLayer {
  return (input, data) => {
    const added = add(input, data);
    if (added.ok) fitted.add(added.data.id);
    return added;
  };
}
