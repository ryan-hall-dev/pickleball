/** Decorative check mark; pair it with text or aria-pressed so status isn't the icon alone. */
export function CheckIcon({ sizePx }: { sizePx: number }) {
  return (
    <svg
      aria-hidden="true"
      width={sizePx}
      height={sizePx}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}
