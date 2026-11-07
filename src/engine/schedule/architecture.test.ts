// @vitest-environment node
// Guards the engine rules in CLAUDE.md: the scheduler never reads the report,
// and engine code never reads the clock or unseeded randomness.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ENGINE_DIRECTORY = join(process.cwd(), "src", "engine");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

const isTestFile = (path: string) => /\.(test|bench)\.ts$/.test(path);

describe("engine architecture", () => {
  it("the scheduler never imports the report module", () => {
    for (const path of sourceFiles(join(ENGINE_DIRECTORY, "schedule"))) {
      expect(readFileSync(path, "utf8"), path).not.toMatch(
        /from\s+["'][^"']*report[^"']*["']/,
      );
    }
  });

  it("engine code never reads the clock or unseeded randomness", () => {
    for (const path of sourceFiles(ENGINE_DIRECTORY)) {
      if (isTestFile(path)) continue;
      const source = readFileSync(path, "utf8");
      expect(source, path).not.toMatch(/Date\.now\(|Math\.random\(|new Date\(/);
    }
  });

  it("engine code never imports React, Next.js or Supabase", () => {
    for (const path of sourceFiles(ENGINE_DIRECTORY)) {
      expect(readFileSync(path, "utf8"), path).not.toMatch(
        /from\s+["'](react|react-dom|next|@supabase)(\/[^"']*)?["']/,
      );
    }
  });
});
