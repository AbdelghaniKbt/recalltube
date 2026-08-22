import { defineConfig } from "vitest/config";

/**
 * Browser integration tests. Separated from the unit suite because they need a built artifact,
 * a real Chromium, and a display; they also download the embedding model on first run.
 */
export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.spec.ts"],
    environment: "node",
    testTimeout: 300_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
