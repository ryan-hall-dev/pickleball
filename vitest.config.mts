import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // Vite resolves the tsconfig `@/*` alias natively.
  resolve: { tsconfigPaths: true },
  test: {
    // UI tests default to jsdom; engine tests opt into node with `// @vitest-environment node`.
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    benchmark: {
      include: ["src/**/*.bench.ts"],
    },
  },
});
