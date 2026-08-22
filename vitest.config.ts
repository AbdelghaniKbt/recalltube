import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit and property tests run everywhere and stay fast.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
  },
});
