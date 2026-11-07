/** Up to two initials: first and last word of the name (e.g. "Grace Kim" → "GK"). */
export function initialsFromName(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const firstInitial = Array.from(words[0])[0];
  const lastInitial = words.length > 1 ? Array.from(words.at(-1)!)[0] : "";
  return `${firstInitial}${lastInitial}`.toUpperCase();
}

/** 36px initials circle in the neutral (waiting) colours. Decorative: the name is always shown beside it. */
export function InitialsAvatar({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-9 shrink-0 items-center justify-center rounded-full bg-inner-border text-[13px] font-bold text-text-soft"
    >
      {initialsFromName(name)}
    </span>
  );
}
