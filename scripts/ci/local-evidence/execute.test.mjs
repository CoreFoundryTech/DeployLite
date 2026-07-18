import assert from "node:assert/strict";
import test from "node:test";
import { executeIsolated } from "./execute.mjs";

const sha = "a".repeat(40);
const options = { binding: { headSha: sha, repository: "CoreFoundryTech/DeployLite", authenticatedLogin: "maintainer" }, expected: { repository: "CoreFoundryTech/DeployLite", authenticatedLogin: "maintainer" }, controllerRoot: "/repo", worktreeParent: "/tmp", ids: ["runtime-contract"], makePath: () => "/tmp/run", available: new Set(["node"]) };

test("RED isolation and cleanup failures block without retaining a check result", async () => {
  let spawned = false;
  const failedSetup = await executeIsolated({ ...options, git: async () => { throw new Error("no worktree"); }, spawn: async () => { spawned = true; } });
  assert.equal(failedSetup.aggregateOutcome, "blocked");
  assert.equal(spawned, false);
  const cleanupFailure = await executeIsolated({ ...options, git: async (argv) => argv.includes("HEAD") ? sha : argv.includes("remove") ? Promise.reject(new Error("cleanup")) : "", spawn: async () => ({ exitCode: 0, output: "ok" }) });
  assert.equal(cleanupFailure.checks[0].reasonCode, "isolation_or_cleanup_error");
});

test("runtime fixture redacts before returning aggregate evidence", async () => {
  const result = await executeIsolated({ ...options, knownValues: ["top-secret"], canary: "canary", git: async (argv) => argv.includes("HEAD") ? sha : "", spawn: async () => ({ exitCode: 0, output: "token=top-secret /Users/alice canary" }) });
  assert.equal(result.aggregateOutcome, "pass");
  assert.equal(result.checks[0].excerpt.includes("top-secret"), false);
  assert.equal(result.checks[0].excerpt.includes("/Users/alice"), false);
});
