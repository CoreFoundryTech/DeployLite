import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureDirectory = await mkdtemp(join(packageRoot, "src", ".vitest-only-guard-"));
const fixturePath = join(fixtureDirectory, "only-guard.test.ts");

try {
  await writeFile(
    fixturePath,
    'import { it } from "vitest";\n\nit.only("must be rejected", () => {});\n'
  );

  const result = spawnSync(
    "pnpm",
    ["exec", "vitest", "run", fixturePath, "--config", "vitest.config.ts"],
    { cwd: packageRoot, encoding: "utf8" }
  );
  const output = `${result.stdout}\n${result.stderr}`;

  if (result.status === 0 || !/Unexpected \.only modifier/.test(output)) {
    throw new Error(`Vitest did not reject the temporary .only fixture as expected:\n${output}`);
  }

  console.log("Vitest .only guard rejected the temporary focused test as expected.");
} finally {
  await rm(fixtureDirectory, { force: true, recursive: true });
}
