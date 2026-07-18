import assert from "node:assert/strict";
import test from "node:test";
import { runCheck, sanitizedEnvironment } from "./process.mjs";

const check = { id: "test", argv: ["pnpm", "test"], timeoutMs: 25, capability: "pnpm" };

test("RED unavailable capabilities block without spawning", async () => {
  let spawned = false;
  const result = await runCheck(check, { cwd: "/tmp/run", available: new Set(), spawn: async () => { spawned = true; } });
  assert.deepEqual(result, { ...check, outcome: "blocked", reasonCode: "missing_capability", exitCode: null, durationMs: 0, excerpt: "" });
  assert.equal(spawned, false);
});

test("sanitized process execution excludes secrets and blocks timeout or errors", async () => {
  const env = sanitizedEnvironment({ GH_TOKEN: "secret", DATABASE_URL: "postgres://secret", PATH: "/bin" });
  assert.deepEqual(env, { CI: "true", HOME: "/nonexistent", NO_COLOR: "1", PATH: "/bin" });
  for (const event of ["timeout", "error"]) {
    const result = await runCheck(check, { cwd: "/tmp/run", available: new Set(["pnpm"]), spawn: async () => ({ event, output: "token=secret" }) });
    assert.equal(result.outcome, "blocked");
    assert.equal(result.reasonCode, event === "timeout" ? "timeout" : "execution_error");
  }
});

test("fixed argv uses no shell and reports actual failures", async () => {
  let received;
  const result = await runCheck(check, { cwd: "/tmp/run", available: new Set(["pnpm"]), spawn: async (input) => { received = input; return { exitCode: 2, output: "failed" }; } });
  assert.deepEqual(received, { command: "pnpm", args: ["test"], cwd: "/tmp/run", env: sanitizedEnvironment(process.env), timeoutMs: 25, shell: false });
  assert.equal(result.outcome, "fail");
});
