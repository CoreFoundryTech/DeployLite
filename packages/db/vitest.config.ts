import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@deploylite/config": new URL("../config/src/index.ts", import.meta.url).pathname,
      "@deploylite/contracts": new URL("../contracts/src/index.ts", import.meta.url).pathname,
      "@deploylite/domain": new URL("../domain/src/index.ts", import.meta.url).pathname
    }
  },
  test: {
    environment: "node",
    forbidOnly: true,
    include: ["src/**/*.test.ts"]
  }
});
