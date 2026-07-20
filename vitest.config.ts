import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@ntnkit/core": path.resolve(__dirname, "packages/core/src/index.ts"),
      "@ntnkit/sdk": path.resolve(__dirname, "packages/sdk/src/index.ts"),
      "@ntnkit/scan": path.resolve(__dirname, "packages/scan/src/index.ts"),
      "@ntnkit/sqlite": path.resolve(__dirname, "packages/sqlite/src/index.ts"),
    },
  },
  test: {
    include: ["packages/**/*.test.ts"],
    environment: "node",
  },
});
