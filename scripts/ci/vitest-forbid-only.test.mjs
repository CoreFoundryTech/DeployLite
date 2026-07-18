#!/usr/bin/env node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(scriptPath), "../..");
const expectedScript = resolve(root, "scripts/ci/vitest-forbid-only.test.mjs");

if (resolve(scriptPath) !== expectedScript) throw new Error("Vitest forbid-only contract must run from scripts/ci inside the checkout");

const packageFiles = [
  "package.json",
  "apps/agent/package.json",
  "apps/api/package.json",
  "apps/mcp/package.json",
  "apps/web/package.json",
  "packages/config/package.json",
  "packages/contracts/package.json",
  "packages/db/package.json",
  "packages/domain/package.json"
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertCommandCoverage() {
  for (const file of packageFiles) {
    const manifest = JSON.parse(await readFile(join(root, file), "utf8"));
    for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
      if (typeof command === "string" && command.includes("vitest run")) {
        assert(command.includes("--allowOnly=false"), `${file} script ${name} must include --allowOnly=false`);
      }
    }
  }

  const workflow = await readFile(join(root, ".github/workflows/baseline.yml"), "utf8");
  assert(workflow.includes("pnpm ci:vitest:forbid-only"), "baseline workflow must validate the Vitest forbid-only contract");
  assert(workflow.includes("pnpm test"), "baseline workflow must execute the root test command");
  assert(workflow.includes("db:verify:integration"), "baseline workflow must execute PostgreSQL integration tests");
}

function runVitest(config, file) {
  return spawnSync("pnpm", ["exec", "vitest", "run", "--allowOnly=false", "--root", dirname(config), "--config", config, file], {
    cwd: root,
    encoding: "utf8"
  });
}

async function assertFixtureBehavior() {
  const fixtureDir = await mkdtemp(join(tmpdir(), "deploylite-vitest-forbid-only-"));
  const config = join(fixtureDir, "vitest.config.mjs");
  const normal = join(fixtureDir, "normal.test.mjs");
  const focused = join(fixtureDir, "focused.test.mjs");

  try {
    await writeFile(config, 'export default { test: { globals: true, include: ["**/*.test.mjs"] } };\n');
    await writeFile(normal, 'test("normal test runs", () => expect(true).toBe(true));\n');
    await writeFile(focused, 'test.only("focused test is rejected", () => expect(true).toBe(true));\n');

    const normalResult = runVitest(config, normal);
    assert(normalResult.status === 0, `normal Vitest fixture must pass: ${normalResult.stderr || normalResult.stdout}`);

    const focusedResult = runVitest(config, focused);
    assert(focusedResult.status !== 0, "focused Vitest fixture must fail with --allowOnly=false");
  } finally {
    assert(relative(tmpdir(), fixtureDir) && !relative(tmpdir(), fixtureDir).startsWith(".."), "fixture cleanup must stay inside the OS temp directory");
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

await assertCommandCoverage();
await assertFixtureBehavior();
console.log("Vitest forbid-only contract passed: normal tests run and focused tests fail.");
