<script lang="ts">
  import type { Map as MaplibreMap } from 'maplibre-gl';
  import { promptExamples } from '../../../shared/promptExamples';
  import { toolNameSchema, type ClientToolResult, type ToolName, type ToolResultData } from '../../../shared/toolProtocol';
  import { createClientToolExecutor } from '$lib/chat/clientTools';

  let { ready, map }: { ready: boolean; map?: MaplibreMap } = $props();

  const execute = createClientToolExecutor(() => map);

  const exampleInput = (tool: ToolName): string => {
    const call = promptExamples.flatMap((example) => example.calls).find((candidate) => candidate.tool === tool);
    return call ? JSON.stringify(call.input, null, 2) : '';
  };

  let tool = $state<ToolName>(toolNameSchema.options[0]);
  let input = $state(exampleInput(toolNameSchema.options[0]));
  let running = $state(false);
  let resultText = $state('');
  let resultBytes = $state(0);

  const show = (result: ClientToolResult<ToolResultData> | string): void => {
    const compact = typeof result === 'string' ? result : JSON.stringify(result);
    resultBytes = new TextEncoder().encode(compact).length;
    resultText = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  };

  async function run(): Promise<void> {
    if (!ready || running) return;
    running = true;
    try {
      show(await execute({ tool, input: JSON.parse(input) }));
    } catch (error) {
      // Only the JSON of the box can fail here: the executor answers every other failure as a result.
      show(`JSON: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
  }
</script>

<div class="flex flex-col gap-2">
  <select
    class="rounded border border-bb-border bg-bb-surface p-1 text-sm"
    aria-label="ツール（開発用）"
    data-testid="dev-tool-name"
    value={tool}
    onchange={(event) => {
      tool = toolNameSchema.parse(event.currentTarget.value);
      input = exampleInput(tool);
    }}
  >
    {#each toolNameSchema.options as name (name)}
      <option value={name}>{name}</option>
    {/each}
  </select>
  <textarea
    class="h-32 w-full rounded border border-bb-border bg-bb-surface p-2 font-mono text-xs"
    aria-label="ツールの入力 JSON（開発用）"
    data-testid="dev-tool-input"
    bind:value={input}
  ></textarea>
  <button
    type="button"
    class="self-start rounded border border-bb-border px-3 py-1 text-sm disabled:opacity-50"
    data-testid="dev-tool-run"
    disabled={!ready || running}
    onclick={run}
  >
    実行
  </button>
  {#if resultText}
    <p class="text-xs text-bb-muted" data-testid="dev-tool-size">{resultBytes} bytes</p>
    <pre class="max-h-60 overflow-auto rounded border border-bb-border p-2 text-xs break-words whitespace-pre-wrap" data-testid="dev-tool-result">{resultText}</pre>
  {/if}
</div>
