"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Later milestones add Session setup, Live courts, Members and History.
const HOST_NAV_ITEMS = [
  { href: "/", label: "Home" },
  { href: "/hosts", label: "Hosts" },
] as const;

export function HostNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Host">
      <ul className="flex flex-wrap gap-1">
        {HOST_NAV_ITEMS.map(({ href, label }) => {
          const isCurrentPage = pathname === href;
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={isCurrentPage ? "page" : undefined}
                className={`inline-flex min-h-11 items-center rounded-xl px-4 text-[15px] ${
                  isCurrentPage
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
