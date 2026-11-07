import type { ReactNode } from "react";

/**
 * Orange attention text with a "!" badge, so errors never rely on colour alone.
 * `id` lets an input point at it with aria-describedby.
 */
export function AttentionMessage({
  id,
  children,
}: {
  id?: string;
  children: ReactNode;
}) {
  return (
    <p id={id} className="flex items-start gap-2 text-sm text-orange-soft">
      <span
        aria-hidden="true"
        className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-orange text-xs font-extrabold text-on-orange"
      >
        !
      </span>
      <span>{children}</span>
    </p>
  );
}
