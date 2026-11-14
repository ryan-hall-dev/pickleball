"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Design order: Session setup, Live courts, History. Later milestones add Live
// courts and History; Hosts (admin tools) stays last. There is no Members
// section: participants exist per session only (session-only participants).
const HOST_NAV_ITEMS = [
  { href: "/setup", label: "Session setup" },
  { href: "/hosts", label: "Hosts" },
] as const;

/** A section stays current on its sub-pages (e.g. /hosts/...). */
function isCurrentSection(pathname: string, href: string): boolean {
  return pathname === href || (href !== "/" && pathname.startsWith(`${href}/`));
}

export function HostNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Host">
      <ul className="flex flex-wrap gap-1">
        {HOST_NAV_ITEMS.map(({ href, label }) => {
          const isInCurrentSection = isCurrentSection(pathname, href);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={
                  pathname === href
                    ? "page"
                    : isInCurrentSection
                      ? "true"
                      : undefined
                }
                className={`inline-flex min-h-11 items-center rounded-xl px-4 text-[15px] ${
                  isInCurrentSection
                    ? "bg-nav-active font-semibold text-text"
                    : "font-medium text-muted hover:text-text"
                }`}
              >
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
