import { act } from "@testing-library/react";

/**
 * jsdom (31) has HTMLDialogElement but no showModal/close. Tests only need
 * the open attribute and the close event, so this stands in for them. Call
 * it at the top of a test file that opens a native <dialog>.
 */
export function polyfillDialogForTests() {
  const dialogPrototype = HTMLDialogElement.prototype;
  dialogPrototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  dialogPrototype.close ??= function close(this: HTMLDialogElement) {
    if (!this.hasAttribute("open")) return;
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}

/**
 * What the browser does on Esc: a cancelable "cancel", then close unless
 * prevented. Inside act so React applies the resulting state updates.
 */
export function pressEscapeOnDialog(dialog: HTMLDialogElement) {
  act(() => {
    const cancelEvent = new Event("cancel", { cancelable: true });
    if (dialog.dispatchEvent(cancelEvent)) dialog.close();
  });
}
