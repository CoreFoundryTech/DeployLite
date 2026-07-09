import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@deploylite/agent": new URL("../../apps/agent/src/index.ts", import.meta.url).pathname,
      "@deploylite/config": new URL("../../packages/config/src/index.ts", import.meta.url).pathname,
      "@deploylite/contracts": new URL("../../packages/contracts/src/index.ts", import.meta.url).pathname,
      "@deploylite/db": new URL("../../packages/db/src/index.ts", import.meta.url).pathname,
      "@deploylite/domain": new URL("../../packages/domain/src/index.ts", import.meta.url).pathname
    }
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"]
  }
});
