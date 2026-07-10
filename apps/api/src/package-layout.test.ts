import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("API production package layout", () => {
  it("has no API runtime dependency on the privileged agent package", async () => {
    const root = resolve(import.meta.dirname, "../../..");
    const [manifest, appSource, executorSource, dockerfile] = await Promise.all([
      readFile(resolve(root, "apps/api/package.json"), "utf8"),
      readFile(resolve(root, "apps/api/src/app.ts"), "utf8"),
      readFile(resolve(root, "apps/api/src/commands/executor.ts"), "utf8"),
      readFile(resolve(root, "apps/api/Dockerfile"), "utf8")
    ]);
    expect(manifest).not.toContain('"@deploylite/agent"');
    expect(`${appSource}\n${executorSource}`).not.toContain('from "@deploylite/agent"');
    expect(dockerfile).not.toContain("apps/agent");
  });

  it("statically resolves every API workspace runtime package included by the Docker build graph", async () => {
    const root = resolve(import.meta.dirname, "../../..");
    const dockerfile = await readFile(resolve(root, "apps/api/Dockerfile"), "utf8");
    for (const workspace of ["config", "contracts", "db", "domain"]) {
      expect(dockerfile).toContain(`COPY packages/${workspace}/package.json packages/${workspace}/package.json`);
      expect(dockerfile).toContain(`COPY packages/${workspace} packages/${workspace}`);
    }
    const require = createRequire(import.meta.url);
    for (const packageName of ["@deploylite/config", "@deploylite/contracts", "@deploylite/db", "@deploylite/domain"]) {
      expect(require.resolve(packageName)).toMatch(/dist\/index\.js$/);
    }
  });
});
