import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 20000,
    coverage: {
      provider: "v8",
      include: ["src/domain/**", "src/services/**", "src/adapters/llm/**", "src/adapters/memory/**", "src/adapters/graph/**", "src/workers/**", "src/util/**", "src/config.ts"],
      exclude: ["src/**/index.ts"],
      reporter: ["text", "html"],
      thresholds: { statements: 80, branches: 70, functions: 80, lines: 80 },
    },
  },
});
