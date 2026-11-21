import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Light mode is read under bright court lights (docs/plans/light-mode.md):
// text and status text at least 7:1 (WCAG AAA), secondary text at least 4.5:1.

const css = readFileSync(path.join(__dirname, "globals.css"), "utf8");

function tokensIn(block: string): Record<string, string> {
  return Object.fromEntries(
    [...block.matchAll(/--color-([a-z-]+): (#[0-9a-f]{6});/g)].map((match) => [
      match[1],
      match[2],
    ]),
  );
}

const lightBlock = css.slice(css.indexOf("@theme {"), css.indexOf("}\n"));
const LIGHT = tokensIn(lightBlock);

function relativeLuminance(hex: string): number {
  const [red, green, blue] = [1, 3, 5].map((start) => {
    const channel = parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [
    relativeLuminance(foreground),
    relativeLuminance(background),
  ].sort((first, second) => second - first);
  return (lighter + 0.05) / (darker + 0.05);
}

const STRONG_PAIRS: [text: string, surface: string][] = [
  ["text", "bg"],
  ["text", "card"],
  ["text", "inner"],
  ["text", "bg-header"],
  ["text", "lime-surface"],
  ["text", "blue-surface"],
  ["text", "orange-surface"],
  ["link", "card"],
  ["lime-ink", "card"],
  ["lime-ink", "inner"],
  ["lime-ink", "lime-surface"],
  ["blue-ink", "card"],
  ["blue-ink", "inner"],
  ["blue-ink", "blue-surface"],
  ["orange-ink", "card"],
  ["orange-ink", "inner"],
  ["orange-ink", "orange-surface"],
  ["lime-soft", "lime-surface"],
  ["blue-soft", "blue-surface"],
  ["orange-soft", "orange-surface"],
  ["orange-soft", "orange-surface-row"],
  ["orange-text", "orange-surface"],
  ["orange-text", "orange-surface-strong"],
  ["on-lime", "lime"],
  ["on-blue", "blue"],
  ["on-orange", "orange"],
  ["text-soft", "inner-border"],
  ["bg", "text"],
];

const SECONDARY_PAIRS: [text: string, surface: string][] = [
  ["muted", "bg"],
  ["muted", "card"],
  ["muted", "inner"],
  ["placeholder", "inner"],
  ["lime-caption", "lime-surface"],
  ["lime-status", "lime-surface"],
  ["lime-soft", "lime-avatar"],
  ["blue-soft", "blue-avatar"],
  ["orange-avatar-text", "orange-avatar"],
];

describe("light theme contrast", () => {
  it.each(STRONG_PAIRS)("%s on %s is at least 7:1", (text, surface) => {
    expect(contrastRatio(LIGHT[text]!, LIGHT[surface]!)).toBeGreaterThanOrEqual(
      7,
    );
  });

  it.each(SECONDARY_PAIRS)("%s on %s is at least 4.5:1", (text, surface) => {
    expect(contrastRatio(LIGHT[text]!, LIGHT[surface]!)).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  it("defines a dark value for every light token", () => {
    const darkBlock = css.slice(css.indexOf(':root[data-theme="dark"]'));
    expect(Object.keys(tokensIn(darkBlock)).sort()).toEqual(
      Object.keys(LIGHT).sort(),
    );
  });
});
