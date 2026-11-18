import { mapConfig, queryConfig, toolConfig } from '../../../shared/config';
import type { AppliedStyle, LabelSpec, StyleSpec, ViewTarget } from '../../../shared/mapSpec';
import {
  clientToolRequestSchema,
  fitToolResult,
  toolError,
  type AddLayerData,
  type ClientToolRequest,
  type ClientToolResult,
  type ToolInputs,
  type ToolResultData
} from '../../../shared/toolProtocol';
import { firstLineWithoutUrls } from '../duckdb/errors';
import type { Bbox, LayerQueryResult, TableQueryResult } from '../duckdb/queryTypes';
import { outsideDegrees } from '../map/degrees';
import type { LayerState, NewLayer } from '../map/mapState.svelte';
import { clampZoom } from '../map/zoom';
import type { FitOptions, MapView } from './mapView';

/**
 * The browser side of the six tools: runs one `ClientToolRequest` (the interrupt reason the backend raised) and answers
 * with a `ClientToolResult`, fitted to the size limits. The engine, the map state and the map's camera come in as
 * dependencies, so the executor is tested without DuckDB or MapLibre (`clientTools.ts` builds the real one).
 */

export type ToolExecutorDeps = {
  queryLayer: (sql: string) => Promise<ClientToolResult<LayerQueryResult>>;
  queryTable: (sql: string, maxRows: number) => Promise<ClientToolResult<TableQueryResult>>;
  map: {
    addLayer: (input: NewLayer, data: LayerQueryResult) => ClientToolResult<LayerState>;
    replaceLayer: (layerId: string, input: NewLayer, data: LayerQueryResult) => ClientToolResult<LayerState>;
    setStyle: (layerId: string, style: StyleSpec, name?: string) => ClientToolResult<LayerState>;
    setLabel: (layerId: string, label: LabelSpec | null) => ClientToolResult<LayerState>;
    removeLayer: (layerId: string) => boolean;
    getLayer: (layerId: string) => LayerState | undefined;
    layerIds: () => string[];
    /** The layer's `applied` as `<map_state>` shows it. */
    appliedOf: (layerId: string) => AppliedStyle | undefined;
    /** The number of the map's session: it changes when the map is reset (sign-out, a restored map). */
    currentSession: () => number;
  };
  view: MapView;
};

export type ToolExecutor = (request: ClientToolRequest) => Promise<ClientToolResult<ToolResultData>>;

type ToolResult = ClientToolResult<ToolResultData>;

const fitOptions: FitOptions = { padding: mapConfig.fitPaddingPx, maxZoom: mapConfig.fitMaxZoom, duration: mapConfig.fitDurationMs };

const ok = (data: ToolResultData): ToolResult => ({ ok: true, data });

const unknownErrorMessage = 'unknown error';

/** The failure of anything that threw: its first line, without URLs and stack. */
const thrownError = (error: Error | string): ToolResult =>
  toolError('ENGINE_UNAVAILABLE', `The tool failed: ${firstLineWithoutUrls(typeof error === 'string' ? error : error.message, queryConfig.maxErrorChars) ?? unknownErrorMessage}`);

function invalidInput(issues: readonly { path: readonly PropertyKey[] }[]): ToolResult {
  const paths = [...new Set(issues.map(({ path }) => path.map(String).join('.') || '(root)'))].slice(0, toolConfig.maxIssuePaths);
  return toolError('INVALID_INPUT', `The request is not valid at: ${paths.join(', ')}.`, 'Check the tool name and its input against the tool description.');
}

const round = (value: number): number => Number(value.toFixed(toolConfig.viewDecimals));

const sameJson = (a: StyleSpec | LabelSpec | null, b: StyleSpec | LabelSpec | null): boolean => JSON.stringify(a) === JSON.stringify(b);

export function createToolExecutor(deps: ToolExecutorDeps): ToolExecutor {
  const { map, view } = deps;

  const unknownLayer = (layerId: string): ToolResult =>
    toolError('UNKNOWN_LAYER', `There is no layer "${layerId}".`, `Layers: ${map.layerIds().join(', ') || 'none'}.`);

  const noFeatures = (what: string): ToolResult =>
    toolError('NO_GEOMETRY', `${what} has no features, so there is nowhere to move the map to.`, 'Loosen the filter, or give a box or a point.');

  async function runQuery({ sql }: ToolInputs['runQuery']): Promise<ToolResult> {
    const table = await deps.queryTable(sql, queryConfig.maxRows);
    if (!table.ok) return table;
    const { columns, rows, truncated } = table.data;
    return ok({ columns, rows, rowCount: rows.length, truncated });
  }

  /** What the replaced layer lost: the model is told when its old style or label did not carry over. */
  function replaceWarnings(previous: LayerState, input: ToolInputs['addLayer'], layer: LayerState): string[] {
    const warnings: string[] = [];
    if (input.style === undefined && !sameJson(previous.style, layer.style)) {
      warnings.push('The old style does not fit the new data; a single colour was used. Set a style if you want another.');
    }
    if (input.label === undefined && previous.label !== null && layer.label === null) {
      warnings.push('The old label was removed: its column is not in the new data.');
    }
    return warnings;
  }

  async function addLayer(input: ToolInputs['addLayer']): Promise<ToolResult> {
    const { replaceLayerId } = input;
    const previous = replaceLayerId === undefined ? undefined : map.getLayer(replaceLayerId);
    if (replaceLayerId !== undefined && previous === undefined) return unknownLayer(replaceLayerId);

    const session = map.currentSession();
    const queried = await deps.queryLayer(input.sql);
    // The map was reset (a restored map, a sign-out) while the query ran: the layer belongs to a map that is gone.
    if (session !== map.currentSession()) return toolError('SESSION_RESET', 'The map was replaced while the query ran, so the layer was not added.', 'Do not call more tools for this request. Stop.');
    if (!queried.ok) return queried;
    const outside = outsideDegrees(queried.data);
    if (outside) return outside;
    const spec: NewLayer = { name: input.name, sql: input.sql, style: input.style, label: input.label };
    const placed = replaceLayerId === undefined ? map.addLayer(spec, queried.data) : map.replaceLayer(replaceLayerId, spec, queried.data);
    if (!placed.ok) return placed;
    const layer = placed.data;

    // The layer is on the map now: a camera that fails to move does not make the tool fail.
    if ((input.zoomTo ?? true) && layer.featureCount > 0) {
      try {
        await view.fitBounds(layer.bbox, fitOptions);
      } catch {
        // The layer stays on the map; only the camera did not move.
      }
    }

    const applied = map.appliedOf(layer.id);
    if (applied === undefined) return unknownLayer(layer.id);
    const warnings = previous === undefined ? [] : replaceWarnings(previous, input, layer);
    const [west, south, east, north] = layer.bbox;
    const data: AddLayerData = {
      layerId: layer.id,
      name: layer.name,
      featureCount: layer.featureCount,
      geometryType: layer.geometryType,
      columns: layer.columns.map(({ name, type }) => ({ name, type })),
      bbox: [west, south, east, north],
      applied,
      ...(warnings.length > 0 ? { warnings } : {})
    };
    return ok(data);
  }

  function setLayerStyle({ layerId, style, name }: ToolInputs['setLayerStyle']): ToolResult {
    const styled = map.setStyle(layerId, style, name);
    if (!styled.ok) return styled;
    const applied = map.appliedOf(layerId);
    return applied === undefined ? unknownLayer(layerId) : ok({ layerId, name: styled.data.name, applied });
  }

  function setLayerLabel({ layerId, label }: ToolInputs['setLayerLabel']): ToolResult {
    const labelled = map.setLabel(layerId, label);
    if (!labelled.ok) return labelled;
    const { label: set } = labelled.data;
    return ok({ layerId, label: set === null ? null : { ...set } });
  }

  function removeLayer({ layerId }: ToolInputs['removeLayer']): ToolResult {
    if (!map.removeLayer(layerId)) return unknownLayer(layerId);
    return ok({ removed: layerId, remaining: map.layerIds() });
  }

  /** Moves the map as the target says. A failure answers a result; undefined means the map has moved. */
  async function moveTo(target: ViewTarget): Promise<ToolResult | undefined> {
    switch (target.type) {
      case 'center':
        view.jumpTo(target.center, target.zoom);
        return undefined;
      case 'bbox':
        await view.fitBounds(target.bbox, fitOptions);
        return undefined;
      case 'layer': {
        const layer = map.getLayer(target.layerId);
        if (layer === undefined) return unknownLayer(target.layerId);
        if (layer.featureCount === 0) return noFeatures(`Layer ${layer.id}`);
        await view.fitBounds(layer.bbox, fitOptions);
        return undefined;
      }
      case 'query': {
        // The query is run as a layer would be (guarded, with the same limits) and is not added to the map.
        const queried = await deps.queryLayer(target.sql);
        if (!queried.ok) return queried;
        if (queried.data.featureCount === 0) return noFeatures('The query');
        const outside = outsideDegrees(queried.data);
        if (outside) return outside;
        await view.fitBounds(queried.data.bbox, fitOptions);
        return undefined;
      }
    }
  }

  async function setView({ target }: ToolInputs['setView']): Promise<ToolResult> {
    const failed = await moveTo(target);
    if (failed) return failed;
    const { center, zoom } = view.getView();
    return ok({ center: [round(center[0]), round(center[1])], zoom: clampZoom(round(zoom)) });
  }

  async function run(request: ClientToolRequest): Promise<ToolResult> {
    switch (request.tool) {
      case 'runQuery':
        return runQuery(request.input);
      case 'addLayer':
        return addLayer(request.input);
      case 'setLayerStyle':
        return setLayerStyle(request.input);
      case 'setLayerLabel':
        return setLayerLabel(request.input);
      case 'removeLayer':
        return removeLayer(request.input);
      case 'setView':
        return setView(request.input);
    }
  }

  // The request comes through the interrupt, so it is checked again here; whatever happens, the answer is a result.
  // The map's session is not checked: a sign-out during a camera wait leaves no layer (`UNKNOWN_LAYER`), and the session of 4.5 is dropped with its conversation.
  const execute: ToolExecutor = async (request) => {
    try {
      const parsed = clientToolRequestSchema.safeParse(request);
      return fitToolResult(parsed.success ? await run(parsed.data) : invalidInput(parsed.error.issues));
    } catch (error) {
      return thrownError(error instanceof Error ? error : String(error));
    }
  };

  // One call at a time, in the order received (the model's order): layer ids, replaces and the view read back depend on the calls before. `execute` never rejects; if it did, the chain would still go on (the rejection reaches only the caller).
  let previous: Promise<void> = Promise.resolve();
  const noop = (): void => undefined;
  return (request) => {
    const result = previous.then(() => execute(request));
    previous = result.then(noop, noop);
    return result;
  };
}
