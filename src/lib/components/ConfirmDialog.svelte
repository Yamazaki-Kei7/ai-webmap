<script lang="ts">
  import { mapsConfig } from '../../../shared/config';
  import ModalDialog from './ModalDialog.svelte';

  let {
    open,
    title,
    message,
    confirmLabel,
    onconfirm,
    oncancel,
    testid
  }: { open: boolean; title: string; message: string; confirmLabel: string; onconfirm: () => void; oncancel: () => void; testid: string } = $props();
</script>

<ModalDialog {open} {title} onclose={oncancel} {testid}>
  <p data-testid="{testid}-message">{message}</p>
  <div class="flex justify-end gap-2">
    <!-- The focus starts on the safe choice. -->
    <!-- svelte-ignore a11y_autofocus -->
    <button type="button" class="rounded border border-bb-border px-3 py-1" autofocus data-testid="{testid}-cancel" onclick={oncancel}>{mapsConfig.text.cancel}</button>
    <button type="button" class="rounded bg-bb-accent px-3 py-1 text-bb-accent-text hover:bg-bb-accent-hover" data-testid="{testid}-confirm" onclick={onconfirm}>{confirmLabel}</button>
  </div>
</ModalDialog>
