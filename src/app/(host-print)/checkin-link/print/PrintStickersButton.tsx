"use client";

import { SECONDARY_BUTTON_CLASS_NAME } from "@/components/controlStyles";

/** Opens the browser's print dialog for the sticker sheet (S03 toolbar). */
export function PrintStickersButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className={SECONDARY_BUTTON_CLASS_NAME}
    >
      Print
    </button>
  );
}
