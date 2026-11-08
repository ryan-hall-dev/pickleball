// Shared Tailwind classes for the DESIGN.md form controls and buttons.

/** 48px input; pair with aria-invalid for the orange invalid border. */
export const TEXT_INPUT_CLASS_NAME =
  "h-12 w-full rounded-[14px] border border-inner-border bg-inner px-3.5 text-base text-text placeholder:text-placeholder aria-invalid:border-2 aria-invalid:border-orange disabled:opacity-60";

export const FIELD_LABEL_CLASS_NAME = "text-[13px] font-medium text-muted";

/** Primary lime CTA (56px, uppercase). Disabled per DESIGN.md: transparent, inner-border edge, placeholder text. */
export const PRIMARY_BUTTON_CLASS_NAME =
  "flex h-14 w-full items-center justify-center rounded-2xl bg-lime px-5 text-[17px] font-extrabold tracking-[0.03em] text-on-lime uppercase disabled:cursor-not-allowed disabled:border disabled:border-inner-border disabled:bg-transparent disabled:text-placeholder";

/** Secondary blue button (44px), e.g. "Add member", "Accept". */
export const SECONDARY_BUTTON_CLASS_NAME =
  "inline-flex h-11 items-center justify-center rounded-[14px] bg-blue px-4 text-[15px] font-bold text-on-blue disabled:cursor-not-allowed disabled:border disabled:border-inner-border disabled:bg-transparent disabled:text-placeholder";

// Outline buttons share everything but height and colour. Each variant sets
// those exactly once: appending a second `h-*` or colour class to a variant
// doesn't override it (whichever rule comes later in the stylesheet wins).
const OUTLINE_BUTTON_SHAPE_CLASS_NAME =
  "inline-flex items-center justify-center rounded-[14px] border px-4 text-[15px] font-semibold hover:bg-inner disabled:cursor-not-allowed disabled:border-inner-border disabled:text-placeholder";

/** Outline / ghost button (44px). */
export const OUTLINE_BUTTON_CLASS_NAME = `${OUTLINE_BUTTON_SHAPE_CLASS_NAME} h-11 border-outline text-text`;

/** Outline button at primary-CTA height (56px), e.g. Cancel beside a primary button. */
export const LARGE_OUTLINE_BUTTON_CLASS_NAME = `${OUTLINE_BUTTON_SHAPE_CLASS_NAME} h-14 border-outline text-text`;

/** Orange outline (44px) for actions that need attention, e.g. "Deactivate member". */
export const ATTENTION_OUTLINE_BUTTON_CLASS_NAME = `${OUTLINE_BUTTON_SHAPE_CLASS_NAME} h-11 border-orange-edge text-orange-soft`;

/** Text-style link button (still 44px high for touch). */
export const LINK_BUTTON_CLASS_NAME =
  "inline-flex min-h-11 items-center text-[15px] font-semibold text-link hover:text-link-hover disabled:cursor-not-allowed disabled:text-placeholder";

export const CARD_CLASS_NAME =
  "rounded-card border border-card-border bg-card p-[22px]";
