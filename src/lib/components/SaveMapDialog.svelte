<script lang="ts">
  import { untrack } from 'svelte';
  import { mapsConfig } from '../../../shared/config';
  import { toPersisted } from '$lib/map/persist.svelte';
  import type { MapFlow } from '$lib/map/savedMapFlow.svelte';
  import { fill, persistFailureText } from '$lib/map/savedMaps';
  import ModalDialog from './ModalDialog.svelte';

  /** `onfailedclosed`: the save failed after the dialog was closed (a second Esc closes it in Chromium): the dialog cannot show it, so the bar does. */
  let { open, flow, onclose, onsaved, onfailedclosed }: { open: boolean; flow: MapFlow; onclose: () => void; onsaved: () => void; onfailedclosed: (message: string) => void } = $props();

  const text = mapsConfig.text.saveDialog;

  let title = $state('');
  let error = $state<string | null>(null);
  // The map cannot be updated (gone, or changed elsewhere): what is on the screen can be saved as a new map.
  let offerNew = $state(false);

  // Every opening starts from the title of the map shown (empty for one never saved).
  $effect(() => {
    if (!open) return;
    title = untrack(() => flow.title ?? '');
    error = null;
    offerNew = false;
  });

  // A map that cannot be saved as it is: said before the call, with the save button disabled.
  const blocked = $derived.by(() => {
    if (!open) return null;
    const persisted = toPersisted();
    return persisted.ok ? null : persistFailureText(persisted.reason);
  });
  const trimmed = $derived(title.trim());
  // The save is the flow's: it goes on when the dialog is not looked at, so a second one is refused until it is over.
  const saving = $derived(flow.saving);
  const canSave = $derived(!saving && blocked === null && trimmed !== '');

  async function save(asNew: boolean): Promise<void> {
    if (!canSave) return;
    error = null;
    offerNew = false;
    const outcome = await flow.save(trimmed, { asNew });
    if (outcome.ok) onsaved();
    else if (outcome.message !== null) {
      if (!open) onfailedclosed(outcome.message);
      error = outcome.message;
      offerNew = outcome.offerNew === true;
    }
  }
</script>

<ModalDialog {open} title={text.title} {onclose} closable={!saving} testid="save-dialog">
  <form
    class="flex flex-col gap-3"
    onsubmit={(event) => {
      event.preventDefault();
      void save(false);
    }}
  >
    <label class="flex flex-col gap-1">
      <span>{text.titleLabel}</span>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="rounded border border-bb-border bg-bb-surface p-2 focus-visible:outline-2 focus-visible:outline-bb-focus-ring"
        autofocus
        required
        maxlength={mapsConfig.title.maxChars}
        autocomplete="off"
        data-testid="save-title"
        bind:value={title}
      />
      <span class="text-xs text-bb-muted">{fill(text.titleHint, { max: mapsConfig.title.maxChars })}</span>
    </label>

    {#if blocked}
      <p class="text-bb-danger" role="alert" data-testid="save-blocked">{blocked}</p>
    {/if}
    {#if error}
      <p class="text-bb-danger" role="alert" data-testid="save-error">{error}</p>
    {/if}
    {#if saving}
      <p class="text-bb-muted" role="status" data-testid="save-saving">{text.saving}</p>
    {/if}

    <div class="flex flex-wrap justify-end gap-2">
      {#if offerNew}
        <button type="button" class="rounded border border-bb-border px-3 py-1 disabled:opacity-50" disabled={!canSave} data-testid="save-as-new" onclick={() => save(true)}>{text.saveAsNew}</button>
      {/if}
      <button type="button" class="rounded border border-bb-border px-3 py-1 disabled:opacity-50" disabled={saving} data-testid="save-cancel" onclick={onclose}>{mapsConfig.text.cancel}</button>
      <button type="submit" class="rounded bg-bb-accent px-3 py-1 text-bb-accent-text hover:bg-bb-accent-hover disabled:opacity-50" disabled={!canSave} data-testid="save-submit">
        {mapsConfig.text.save}
      </button>
    </div>
  </form>
</ModalDialog>
