import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    forbidOnly: true,
    include: ["src/**/*.test.ts"]
  }
});
