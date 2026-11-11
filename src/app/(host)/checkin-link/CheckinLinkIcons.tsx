import type { ReactNode } from "react";

// Decorative line icons from the Sticker and QR designs (docs/designs/m5).
// Always placed next to words, so they are hidden from screen readers.

function LineIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      {children}
    </svg>
  );
}

export function QrCodeIcon() {
  return (
    <LineIcon>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <path d="M14 14h3v3h-3zM18 18h3v3h-3zM14 20h2M20 14v2" />
    </LineIcon>
  );
}

export function CopyIcon() {
  return (
    <LineIcon>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
    </LineIcon>
  );
}

export function FullScreenIcon() {
  return (
    <LineIcon>
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </LineIcon>
  );
}

export function PrintIcon() {
  return (
    <LineIcon>
      <path d="M6 9V3h12v6M6 18H4v-7h16v7h-2" />
      <rect x="6" y="14" width="12" height="7" />
    </LineIcon>
  );
}

export function BackChevronIcon() {
  return (
    <LineIcon>
      <path d="M15 6l-6 6 6 6" />
    </LineIcon>
  );
}
