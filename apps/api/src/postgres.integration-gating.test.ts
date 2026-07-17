import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const integrationFlag = "DEPLOYLITE_API_POSTGRES_INTEGRATION";

function runIntegrationTest(integrationEnabled: boolean) {
  const env: NodeJS.ProcessEnv = { ...process.env, [integrationFlag]: integrationEnabled ? "1" : "0" };
  delete env.DATABASE_URL;

  return spawnSync("pnpm", ["exec", "vitest", "run", "--config", "vitest.config.ts", "src/postgres.integration.test.ts"], {
    cwd: packageRoot,
    encoding: "utf8",
    env
  });
}

describe("API PostgreSQL integration test gating", () => {
  it("fails clearly when enabled without DATABASE_URL", () => {
    const result = runIntegrationTest(true);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("DATABASE_URL must be set when DEPLOYLITE_API_POSTGRES_INTEGRATION=1.");
  }, 30_000);

  it("skips when disabled without DATABASE_URL", () => {
    const result = runIntegrationTest(false);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/Test Files\s+1 skipped/);
  }, 30_000);
});
