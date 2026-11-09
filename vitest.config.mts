import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/lib/firewall/**/*.ts", "src/lib/engine/conditions.ts", "src/lib/engine/state-machine.ts", "src/lib/util/**/*.ts"],
      reporter: [["text", { skipFull: false }], "json-summary"],
      // The Spend Firewall must stay at 100% branch coverage.
      thresholds: {
        "src/lib/firewall/engine.ts": { branches: 100, functions: 100, lines: 100, statements: 100 },
      },
    },
  },
});
