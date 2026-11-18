<script lang="ts">
  import { mapsConfig } from '../../../shared/config';
  import { restoreProgress } from '$lib/map/persist.svelte';
  import type { MapFlow } from '$lib/map/savedMapFlow.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import OpenMapDialog from './OpenMapDialog.svelte';
  import SaveMapDialog from './SaveMapDialog.svelte';

  /** The save / open / new controls of the top bar, the map's title with its unsaved mark, and the dialogs. `engineReady`: opening rebuilds the layers with the data engine. */
  let { flow, engineReady }: { flow: MapFlow; engineReady: boolean } = $props();

  const text = mapsConfig.text;

  const unsaved = $derived(flow.unsaved);
  // The map is being rebuilt: it is not changed meanwhile.
  const busy = $derived(flow.opening || flow.saving || restoreProgress.current !== null);

  let saveOpen = $state(false);
  let openOpen = $state(false);
  let newOpen = $state(false);
  let notice = $state<string | null>(null);
  // A save that failed after its dialog was closed: shown here until the next save is started.
  let saveFailure = $state<string | null>(null);

  // 「保存しました」 stays for a moment.
  $effect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => (notice = null), mapsConfig.noticeMs);
    return () => clearTimeout(timer);
  });

  // Leaving the page throws the changes away: the browser asks first.
  $effect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent): void => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  });

  function startNew(): void {
    newOpen = false;
    notice = null;
    saveFailure = null;
    flow.startNew();
  }
</script>

<div class="flex min-w-0 flex-wrap items-center gap-2" data-testid="map-bar">
  <button
    type="button"
    class="rounded border border-bb-border px-2 py-0.5 text-sm whitespace-nowrap disabled:opacity-50"
    aria-haspopup="dialog"
    disabled={busy}
    data-testid="map-save"
    onclick={() => {
      saveFailure = null;
      saveOpen = true;
    }}
  >
    {text.save}
  </button>
  <button
    type="button"
    class="rounded border border-bb-border px-2 py-0.5 text-sm whitespace-nowrap disabled:opacity-50"
    aria-haspopup="dialog"
    disabled={busy || !engineReady}
    title={engineReady ? undefined : text.openNeedsEngine}
    data-testid="map-open"
    onclick={() => (openOpen = true)}
  >
    {text.open}
  </button>
  <button
    type="button"
    class="rounded border border-bb-border px-2 py-0.5 text-sm whitespace-nowrap disabled:opacity-50"
    disabled={busy}
    data-testid="map-new"
    onclick={() => (unsaved ? (newOpen = true) : startNew())}
  >
    {text.newMap}
  </button>
  <span class="min-w-0 max-w-48 truncate text-sm font-medium" data-testid="map-title">
    {flow.opening ? text.loadingTitle : (flow.title ?? text.untitled)}
    {#if unsaved}
      <span class="text-bb-accent" aria-hidden="true" data-testid="map-unsaved">{text.unsavedMark}</span>
      <span class="sr-only">{text.unsavedLabel}</span>
    {/if}
  </span>
  <span class="text-sm whitespace-nowrap text-bb-success" role="status" data-testid="map-notice">{notice ?? ''}</span>
  {#if saveFailure}
    <span class="text-sm text-bb-danger" role="alert" data-testid="map-save-error">{saveFailure}</span>
  {/if}
</div>

<SaveMapDialog
  open={saveOpen}
  {flow}
  onclose={() => (saveOpen = false)}
  onfailedclosed={(message) => (saveFailure = message)}
  onsaved={() => {
    saveOpen = false;
    saveFailure = null;
    notice = text.saved;
  }}
/>
<OpenMapDialog
  open={openOpen}
  {flow}
  {unsaved}
  onclose={() => (openOpen = false)}
  onopened={() => {
    openOpen = false;
    saveFailure = null;
  }}
/>
<ConfirmDialog
  open={newOpen}
  title={text.newMap}
  message={text.newDialog.confirmDiscard}
  confirmLabel={text.newDialog.discardAndNew}
  testid="discard-new-dialog"
  oncancel={() => (newOpen = false)}
  onconfirm={startNew}
/>
