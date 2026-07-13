import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    forbidOnly: true,
    globals: false,
    include: ["src/**/*.test.ts"]
  }
});
