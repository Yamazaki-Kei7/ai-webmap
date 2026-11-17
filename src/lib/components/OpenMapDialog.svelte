<script lang="ts">
  import { mapsConfig } from '../../../shared/config';
  import type { SavedMapSummary } from '../../../shared/persistedMap';
  import type { MapFlow } from '$lib/map/savedMapFlow.svelte';
  import { fill, formatUpdatedAt } from '$lib/map/savedMaps';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import ModalDialog from './ModalDialog.svelte';

  /** `unsaved`: opening a map throws away the changes of the one shown, so it is asked first. */
  let { open, flow, unsaved, onclose, onopened }: { open: boolean; flow: MapFlow; unsaved: boolean; onclose: () => void; onopened: () => void } = $props();

  const text = mapsConfig.text.openDialog;

  // `null`: not loaded yet.
  let maps = $state<SavedMapSummary[] | null>(null);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let removing = $state(false);
  // The map a confirmation is about.
  let toRemove = $state<SavedMapSummary | null>(null);
  let toOpen = $state<SavedMapSummary | null>(null);

  const busy = $derived(flow.opening || removing);

  async function load(): Promise<void> {
    const outcome = await flow.list();
    if (outcome.ok) maps = outcome.maps;
    else if (outcome.message !== null) error = outcome.message;
  }

  // Every opening shows the list as the server has it now.
  $effect(() => {
    if (!open) return;
    maps = null;
    error = null;
    notice = null;
    toRemove = null;
    toOpen = null;
    void load();
  });

  async function openMap(summary: SavedMapSummary): Promise<void> {
    toOpen = null;
    error = null;
    notice = null;
    const outcome = await flow.open(summary.mapId);
    if (outcome.ok) onopened();
    else if (outcome.message !== null) error = outcome.message;
  }

  const requestOpen = (summary: SavedMapSummary): void => {
    if (unsaved) toOpen = summary;
    else void openMap(summary);
  };

  async function removeMap(summary: SavedMapSummary): Promise<void> {
    toRemove = null;
    removing = true;
    error = null;
    notice = null;
    const outcome = await flow.remove(summary.mapId);
    removing = false;
    if (outcome.ok) {
      maps = (maps ?? []).filter(({ mapId }) => mapId !== summary.mapId);
      notice = text.removed;
    } else if (outcome.message !== null) error = outcome.message;
  }
</script>

<ModalDialog {open} title={text.title} {onclose} testid="open-dialog">
  {#if error}
    <p class="text-bb-danger" role="alert" data-testid="open-error">{error}</p>
  {/if}
  {#if notice}
    <p class="text-bb-muted" role="status" data-testid="open-notice">{notice}</p>
  {/if}
  {#if flow.opening}
    <p class="text-bb-muted" role="status" data-testid="open-opening">{text.opening}</p>
  {:else if removing}
    <p class="text-bb-muted" role="status">{text.removing}</p>
  {/if}

  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if maps === null}
      {#if error === null}
        <p class="text-bb-muted" role="status" data-testid="open-loading">{text.loading}</p>
      {/if}
    {:else if maps.length === 0}
      <p class="text-bb-muted" data-testid="open-empty">{text.empty}</p>
    {:else}
      <ul class="flex flex-col gap-2" data-testid="open-list">
        {#each maps as summary (summary.mapId)}
          <li class="flex items-center gap-2 rounded border border-bb-border p-2" data-testid="open-item" data-map-id={summary.mapId}>
            <div class="min-w-0 flex-1">
              <p class="truncate font-medium" data-testid="open-item-title">{summary.title}</p>
              <p class="text-xs text-bb-muted"><span class="sr-only">{text.updatedAt} </span><time datetime={new Date(summary.updatedAt).toISOString()} data-testid="open-item-time">{formatUpdatedAt(summary.updatedAt)}</time></p>
            </div>
            <button
              type="button"
              class="rounded bg-bb-accent px-3 py-1 text-bb-accent-text hover:bg-bb-accent-hover disabled:opacity-50"
              aria-label={fill(text.openLabel, { title: summary.title })}
              disabled={busy}
              data-testid="open-item-open"
              onclick={() => requestOpen(summary)}
            >
              {text.open}
            </button>
            <button
              type="button"
              class="rounded border border-bb-border px-3 py-1 disabled:opacity-50"
              aria-label={fill(text.removeLabel, { title: summary.title })}
              disabled={busy}
              data-testid="open-item-remove"
              onclick={() => (toRemove = summary)}
            >
              {text.remove}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <div class="flex justify-end">
    <button type="button" class="rounded border border-bb-border px-3 py-1" data-testid="open-close" onclick={onclose}>{text.close}</button>
  </div>
</ModalDialog>

<ConfirmDialog
  open={toOpen !== null}
  title={text.title}
  message={text.confirmDiscard}
  confirmLabel={text.discardAndOpen}
  testid="discard-open-dialog"
  oncancel={() => (toOpen = null)}
  onconfirm={() => toOpen && openMap(toOpen)}
/>
<ConfirmDialog
  open={toRemove !== null}
  title={text.remove}
  message={toRemove ? fill(text.confirmRemove, { title: toRemove.title }) : ''}
  confirmLabel={text.confirmRemoveAction}
  testid="remove-dialog"
  oncancel={() => (toRemove = null)}
  onconfirm={() => toRemove && removeMap(toRemove)}
/>
