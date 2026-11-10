/** Up to two initials: first and last word of the name (e.g. "Grace Kim" → "GK"). */
export function initialsFromName(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const firstInitial = Array.from(words[0])[0];
  const lastInitial = words.length > 1 ? Array.from(words.at(-1)!)[0] : "";
  return `${firstInitial}${lastInitial}`.toUpperCase();
}

/** DESIGN.md avatar colours by status. */
const AVATAR_TONE_CLASS_NAMES = {
  waiting: "bg-inner-border text-text-soft",
  notAttending: "bg-inner-border text-muted",
  playing: "bg-lime-avatar text-lime-soft",
  next: "bg-blue-avatar text-blue-soft",
} as const;

const AVATAR_SIZE_CLASS_NAMES = {
  /** 36px: lists. */
  list: "size-9 text-[13px]",
  /** 30px: guest chips. */
  chip: "size-[30px] text-[11px]",
  /** 44px: the player check-in page's own-name cards. */
  large: "size-11 text-sm",
  /** 52px: the player check-in confirm sheet. */
  extraLarge: "size-[52px] text-base",
} as const;

/** Initials circle (36px, neutral colours by default). Decorative: the name is always shown beside it. */
export function InitialsAvatar({
  name,
  tone = "waiting",
  size = "list",
}: {
  name: string;
  tone?: keyof typeof AVATAR_TONE_CLASS_NAMES;
  size?: keyof typeof AVATAR_SIZE_CLASS_NAMES;
}) {
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-full font-bold ${AVATAR_SIZE_CLASS_NAMES[size]} ${AVATAR_TONE_CLASS_NAMES[tone]}`}
    >
      {initialsFromName(name)}
    </span>
  );
}
