import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@fusenduck/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)) },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    // Browser tests need Chromium: pnpm test:e2e runs them (vitest.e2e.config.ts).
    exclude: [...configDefaults.exclude, "tests/e2e/**"],
    testTimeout: 30_000,
  },
});
