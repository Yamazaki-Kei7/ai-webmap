/**
 * jsdom has no modal `<dialog>` behaviour (`showModal`, `close`): this gives it the part the app relies on: the `open`
 * attribute, and the `close` event when it is closed. The focus trap and Esc are the browser's; they are checked in a browser.
 */
export function installDialogStub(): void {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
}
