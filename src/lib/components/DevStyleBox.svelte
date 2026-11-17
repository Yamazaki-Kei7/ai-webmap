<script lang="ts">
  import type { ZodType } from 'zod';
  import { labelSpecSchema, styleSpecSchema } from '../../../shared/mapSpec';
  import type { ClientToolResult } from '../../../shared/toolProtocol';
  import { mapState, setLabel, setStyle, type LayerState } from '$lib/map/mapState.svelte';

  let layerId = $state('');
  let input = $state('');
  let errorText = $state('');

  // The selected layer, or the first one while the selection is gone (removed) or not made yet.
  const selected = $derived(mapState.layers.find((layer) => layer.id === layerId)?.id ?? mapState.layers[0]?.id ?? '');

  function show(result: ClientToolResult<LayerState>): void {
    errorText = result.ok ? '' : `${result.error.code}: ${result.error.message}`;
  }

  function schemaError(issues: readonly { path: PropertyKey[]; message: string }[]): string {
    return `INVALID_STYLE: ${issues.map(({ path, message }) => `${path.map(String).join('.') || '(root)'} ${message}`).join('; ')}`;
  }

  /** Parses the box with the schema; invalid JSON or a spec that fails the schema is shown and answers null. */
  function parseInput<T>(schema: ZodType<T>): T | null {
    try {
      const parsed = schema.safeParse(JSON.parse(input));
      if (parsed.success) return parsed.data;
      errorText = schemaError(parsed.error.issues);
    } catch (error) {
      errorText = `JSON: ${error instanceof Error ? error.message : String(error)}`;
    }
    return null;
  }

  function applyStyle(): void {
    const style = parseInput(styleSpecSchema);
    if (style) show(setStyle(selected, style));
  }

  function applyLabel(): void {
    const label = parseInput(labelSpecSchema);
    if (label) show(setLabel(selected, label));
  }
</script>

<div class="flex flex-col gap-2">
  <select
    class="rounded border border-bb-border bg-bb-surface p-1 text-sm"
    aria-label="スタイルを設定するレイヤー（開発用）"
    data-testid="dev-style-layer"
    value={selected}
    onchange={(event) => (layerId = event.currentTarget.value)}
  >
    {#each mapState.layers as layer (layer.id)}
      <option value={layer.id}>{layer.id} {layer.name}</option>
    {/each}
  </select>
  <textarea
    class="h-24 w-full rounded border border-bb-border bg-bb-surface p-2 font-mono text-xs"
    placeholder={'{"type":"single","color":"#1f78b4"}'}
    aria-label="スタイルまたはラベルの JSON（開発用）"
    data-testid="dev-style-input"
    bind:value={input}
  ></textarea>
  <div class="flex flex-wrap gap-2">
    <button type="button" class="rounded border border-bb-border px-3 py-1 text-sm disabled:opacity-50" data-testid="dev-style-apply" disabled={selected === ''} onclick={applyStyle}>
      スタイル適用
    </button>
    <button type="button" class="rounded border border-bb-border px-3 py-1 text-sm disabled:opacity-50" data-testid="dev-label-apply" disabled={selected === ''} onclick={applyLabel}>
      ラベル適用
    </button>
    <button type="button" class="rounded border border-bb-border px-3 py-1 text-sm disabled:opacity-50" data-testid="dev-label-clear" disabled={selected === ''} onclick={() => show(setLabel(selected, null))}>
      ラベル解除
    </button>
  </div>
  {#if errorText}
    <p class="text-xs break-words text-bb-danger" data-testid="dev-style-error">{errorText}</p>
  {/if}
</div>
