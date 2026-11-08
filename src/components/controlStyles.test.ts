// @vitest-environment node
import { describe, expect, it } from "vitest";
import * as controlStyles from "./controlStyles";

// Two utilities from the same group (e.g. `h-11 h-14`) don't override each
// other in Tailwind: whichever rule comes later in the stylesheet wins, so one
// of them silently does nothing. Each shared style must set each group once.
const CONFLICT_GROUPS: Record<string, RegExp> = {
  height: /^h-/,
  borderColour: /^border-(?!\d|\[|[xytblr]-|solid$|dashed$|none$)[a-z]/,
  textColour: /^text-(?!\[|xs$|sm$|base$|lg$|\d?xl$|left$|center$|right$)/,
  background: /^bg-/,
};

function unconditionalClasses(className: string): string[] {
  // Variant classes (hover:, disabled:, sm:, aria-invalid:) apply on top.
  return className.split(/\s+/).filter((name) => name && !name.includes(":"));
}

describe("shared control styles", () => {
  const styleEntries: [string, string][] = Object.entries(controlStyles);

  it.each(styleEntries)(
    "%s sets each style group at most once",
    (_, className) => {
      const classes = unconditionalClasses(className);
      for (const [group, pattern] of Object.entries(CONFLICT_GROUPS)) {
        const groupClasses = classes.filter((name) => pattern.test(name));
        expect(
          groupClasses,
          `${group}: ${groupClasses.join(" ")}`,
        ).toHaveLength(Math.min(groupClasses.length, 1));
      }
    },
  );

  it("gives the attention and large outline buttons their own colour and height", () => {
    const attention = unconditionalClasses(
      controlStyles.ATTENTION_OUTLINE_BUTTON_CLASS_NAME,
    );
    expect(attention).toEqual(
      expect.arrayContaining([
        "h-11",
        "border-orange-edge",
        "text-orange-soft",
      ]),
    );
    expect(attention).not.toContain("border-outline");
    expect(attention).not.toContain("text-text");
    expect(
      unconditionalClasses(controlStyles.LARGE_OUTLINE_BUTTON_CLASS_NAME),
    ).toEqual(expect.arrayContaining(["h-14", "border-outline"]));
    expect(
      unconditionalClasses(controlStyles.LARGE_OUTLINE_BUTTON_CLASS_NAME),
    ).not.toContain("h-11");
  });
});
