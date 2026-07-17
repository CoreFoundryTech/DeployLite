import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    forbidOnly: true,
    include: ["src/**/*.test.ts"]
  }
});
