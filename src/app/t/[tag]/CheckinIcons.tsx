import type { ReactNode } from "react";

// Decorative line icons from the check-in designs (docs/designs/m5). Always
// placed next to words, so they are hidden from screen readers.

function StrokeIcon({
  sizePx,
  strokeWidth = 2,
  className,
  children,
}: {
  sizePx: number;
  strokeWidth?: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <svg
      aria-hidden="true"
      width={sizePx}
      height={sizePx}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className ?? ""}`}
    >
      {children}
    </svg>
  );
}

export function CheckMarkIcon({ sizePx }: { sizePx: number }) {
  return (
    <StrokeIcon sizePx={sizePx} strokeWidth={3}>
      <path d="M5 12l5 5L20 7" />
    </StrokeIcon>
  );
}

export function SearchIcon({ className }: { className?: string }) {
  return (
    <StrokeIcon sizePx={18} className={className}>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </StrokeIcon>
  );
}

export function ChevronIcon({
  direction,
  className,
}: {
  direction: "left" | "right" | "up" | "down";
  className?: string;
}) {
  const path = {
    left: "M15 6l-6 6 6 6",
    right: "M9 6l6 6-6 6",
    up: "M6 15l6-6 6 6",
    down: "M6 9l6 6 6-6",
  }[direction];
  return (
    <StrokeIcon sizePx={18} className={className}>
      <path d={path} />
    </StrokeIcon>
  );
}

export function ClockIcon({ sizePx }: { sizePx: number }) {
  return (
    <StrokeIcon sizePx={sizePx}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </StrokeIcon>
  );
}

/** The "Waiting" pill's icon. */
export function PendingIcon() {
  return (
    <StrokeIcon sizePx={12} strokeWidth={3}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5" />
    </StrokeIcon>
  );
}

export function RefreshIcon() {
  return (
    <StrokeIcon sizePx={16}>
      <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
      <path d="M21 3v5h-5" />
    </StrokeIcon>
  );
}

export function PersonIcon() {
  return (
    <StrokeIcon sizePx={34}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
    </StrokeIcon>
  );
}

export function BrokenLinkIcon() {
  return (
    <StrokeIcon sizePx={34}>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
      <path d="M3 3l18 18" />
    </StrokeIcon>
  );
}

export function CalendarIcon() {
  return (
    <StrokeIcon sizePx={34}>
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </StrokeIcon>
  );
}

export function NoConnectionIcon() {
  return (
    <StrokeIcon sizePx={34}>
      <path d="M2 8.5a15 15 0 0 1 20 0M5 12a10 10 0 0 1 9-2.6M8.5 15.5a5 5 0 0 1 4-1.4" />
      <path d="M3 3l18 18" />
      <circle cx="12" cy="19" r="1" fill="currentColor" />
    </StrokeIcon>
  );
}
