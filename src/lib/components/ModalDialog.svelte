<script lang="ts">
  import type { Snippet } from 'svelte';

  /**
   * An accessible modal over the native `<dialog>`: the page behind it is inert (the focus stays inside), Esc closes it
   * (`onclose` is told, whoever closed it), and the focus goes back to what had it when it opened. The body is rendered only while it is open.
   */
  /** `closable` false: Esc is refused (the dialog is busy; its own buttons are off too). */
  let { open, title, onclose, testid, closable = true, children }: { open: boolean; title: string; onclose: () => void; testid: string; closable?: boolean; children: Snippet } = $props();

  let dialog = $state<HTMLDialogElement>();
  const titleId = $props.id();

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  });
</script>

<dialog
  bind:this={dialog}
  class="m-auto w-[min(32rem,calc(100vw-2rem))] max-h-[85dvh] rounded border border-bb-border bg-bb-surface p-4 text-bb-text shadow-lg backdrop:bg-black/40"
  aria-labelledby={titleId}
  data-testid={testid}
  {onclose}
  oncancel={(event) => {
    if (!closable) event.preventDefault();
  }}
>
  {#if open}
    <div class="flex max-h-[calc(85dvh-2rem)] flex-col gap-3 text-sm">
      <h2 id={titleId} class="text-base font-bold">{title}</h2>
      {@render children()}
    </div>
  {/if}
</dialog>
