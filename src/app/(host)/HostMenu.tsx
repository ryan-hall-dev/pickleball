"use client";

import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useMessages } from "@/i18n/LocaleProvider";

/**
 * The ☰ menu on phones (docs/plans/mobile-compact-ui.md): the header's nav,
 * host name and Sign out, which tablets show inline. Closes on Escape, on a
 * tap outside and when the page changes.
 */
export function HostMenu({ children }: { children: ReactNode }) {
  const text = useMessages().host.header;
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const container = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();
  const [openedOn, setOpenedOn] = useState(pathname);
  // A link in the menu was followed: the new page starts with it closed.
  if (open && openedOn !== pathname) setOpen(false);

  useEffect(() => {
    if (!open) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    }
    function closeOnOutsidePress(event: PointerEvent) {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOnOutsidePress);
    };
  }, [open]);

  return (
    <div ref={container} className="lg:hidden">
      <button
        ref={button}
        type="button"
        aria-label={text.menu}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          setOpenedOn(pathname);
          setOpen((value) => !value);
        }}
        className="flex size-11 items-center justify-center rounded-xl hover:bg-inner"
      >
        <svg
          aria-hidden="true"
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>
      {open && (
        <div
          id={panelId}
          className="absolute inset-x-0 top-full z-20 flex flex-col gap-3 border-b border-card-border bg-bg-header px-3 pt-2 pb-3"
        >
          {children}
        </div>
      )}
    </div>
  );
}
