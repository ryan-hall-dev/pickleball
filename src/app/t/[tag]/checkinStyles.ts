import { LARGE_OUTLINE_BUTTON_CLASS_NAME } from "@/components/controlStyles";

// Classes for the phone check-in page (docs/designs/m5/player-checkin.html)
// that the shared controls don't cover.

/** Info notice: inner fill with a grey "i" badge. */
export const INFO_NOTICE_CLASS_NAME =
  "flex items-start gap-2.5 rounded-2xl border border-inner-border bg-inner px-3.5 py-3 text-sm text-text-soft";

/** Card panel under a state screen (P06, P07, P09). */
export const STATE_PANEL_CLASS_NAME =
  "flex w-full flex-col gap-3 rounded-[20px] border border-card-border bg-card p-4 text-left";

export const FULL_WIDTH_OUTLINE_BUTTON_CLASS_NAME = `${LARGE_OUTLINE_BUTTON_CLASS_NAME} w-full`;

/** Bottom bar for a screen's main button; respects the phone's home indicator. */
export const BOTTOM_ACTION_BAR_CLASS_NAME =
  "mt-auto flex flex-col gap-2.5 pt-4 pb-[max(24px,env(safe-area-inset-bottom))]";

// Level buttons share a 3-column grid on a 390px phone, so they are narrower
// than the shared option buttons ("Intermediate" must fit).
const LEVEL_OPTION_SHAPE_CLASS_NAME =
  "h-11 rounded-xl border px-1.5 text-sm disabled:cursor-not-allowed";

export const SELECTED_LEVEL_OPTION_CLASS_NAME = `${LEVEL_OPTION_SHAPE_CLASS_NAME} border-lime bg-lime font-bold text-on-lime`;

export const UNSELECTED_LEVEL_OPTION_CLASS_NAME = `${LEVEL_OPTION_SHAPE_CLASS_NAME} border-inner-border bg-inner font-semibold text-text hover:bg-nav-active`;
