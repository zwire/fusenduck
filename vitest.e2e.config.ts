import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The browser tests (tests/e2e) drive Chromium through playwright-core. Run: pnpm test:e2e
export default defineConfig({
  resolve: {
    alias: { "@fusenduck/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)) },
  },
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
