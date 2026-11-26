"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMessages } from "@/i18n/LocaleProvider";

// Phone workflow; manager tools stay outside ordinary game turnover.
const HOST_NAV_ITEMS = [
  { href: "/setup", labelKey: "setup" },
  { href: "/live", labelKey: "live" },
  { href: "/hosts", labelKey: "hosts" },
] as const;

/** A section stays current on its sub-pages (e.g. /hosts/...). */
function isCurrentSection(pathname: string, href: string): boolean {
  return pathname === href || (href !== "/" && pathname.startsWith(`${href}/`));
}

/** `column`: the phone ☰ menu, one full-width link per row. */
export function HostNav({ layout = "row" }: { layout?: "row" | "column" }) {
  const pathname = usePathname();
  const text = useMessages().host.header;
  return (
    <nav aria-label={text.navLabel}>
      <ul
        className={
          layout === "row" ? "flex flex-wrap gap-1" : "flex flex-col gap-1"
        }
      >
        {HOST_NAV_ITEMS.map(({ href, labelKey }) => {
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
                className={`${layout === "row" ? "inline-flex" : "flex"} min-h-11 items-center rounded-xl px-4 text-[15px] ${
                  isInCurrentSection
                    ? "bg-nav-active font-semibold text-text"
                    : "font-medium text-muted hover:text-text"
                }`}
              >
                {text.nav[labelKey]}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
