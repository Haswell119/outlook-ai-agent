import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 20000,
    coverage: {
      provider: "v8",
      include: ["src/domain/**", "src/services/**", "src/adapters/llm/**", "src/adapters/memory/**"],
      reporter: ["text", "html"],
    },
  },
});
