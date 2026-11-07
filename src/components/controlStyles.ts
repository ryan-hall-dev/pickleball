// Shared Tailwind classes for the DESIGN.md form controls and buttons.

/** 48px input; pair with aria-invalid for the orange invalid border. */
export const TEXT_INPUT_CLASS_NAME =
  "h-12 w-full rounded-[14px] border border-inner-border bg-inner px-3.5 text-base text-text placeholder:text-placeholder aria-invalid:border-2 aria-invalid:border-orange disabled:opacity-60";

export const FIELD_LABEL_CLASS_NAME = "text-[13px] font-medium text-muted";

/** Primary lime CTA (56px, uppercase). Disabled per DESIGN.md: transparent, inner-border edge, placeholder text. */
export const PRIMARY_BUTTON_CLASS_NAME =
  "flex h-14 w-full items-center justify-center rounded-2xl bg-lime px-5 text-[17px] font-extrabold tracking-[0.03em] text-on-lime uppercase disabled:cursor-not-allowed disabled:border disabled:border-inner-border disabled:bg-transparent disabled:text-placeholder";

/** Outline / ghost button (44px). */
export const OUTLINE_BUTTON_CLASS_NAME =
  "inline-flex h-11 items-center justify-center rounded-[14px] border border-outline px-4 text-[15px] font-semibold text-text hover:bg-inner disabled:cursor-not-allowed disabled:border-inner-border disabled:text-placeholder";

/** Text-style link button (still 44px high for touch). */
export const LINK_BUTTON_CLASS_NAME =
  "inline-flex min-h-11 items-center text-[15px] font-semibold text-link hover:text-link-hover disabled:cursor-not-allowed disabled:text-placeholder";

export const CARD_CLASS_NAME =
  "rounded-card border border-card-border bg-card p-[22px]";
