import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/tests/**/*.test.ts"],
    // Route handlers and `lib/api` import `server-only`, which throws outside a
    // React Server Component; the stub keeps those modules importable.
    alias: {
      "server-only": fileURLToPath(new URL("./src/tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
