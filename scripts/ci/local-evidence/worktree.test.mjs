import assert from "node:assert/strict";
import test from "node:test";
import { assertExecutionBinding, createDetachedWorktree } from "./worktree.mjs";

const sha = "a".repeat(40);
const binding = { headSha: sha };

test("RED exact SHA worktree rejects controller escapes and mismatched checkout HEAD", async () => {
  await assert.rejects(createDetachedWorktree({ binding, controllerRoot: "/repo", worktreeParent: "/repo/tmp", git: async () => sha }), /outside/i);
  await assert.rejects(createDetachedWorktree({ binding, controllerRoot: "/repo", worktreeParent: "/tmp", git: async (argv) => argv.includes("HEAD") ? "b".repeat(40) : "" }), /SHA mismatch/);
});

test("binding mismatch blocks before git worktree commands", () => {
  assert.throws(() => assertExecutionBinding({ ...binding, repository: "CoreFoundryTech/DeployLite", authenticatedLogin: "maintainer" }, { repository: "wrong/repo", authenticatedLogin: "maintainer" }), /repository mismatch/);
  assert.throws(() => assertExecutionBinding({ ...binding, repository: "CoreFoundryTech/DeployLite", authenticatedLogin: "maintainer" }, { repository: "CoreFoundryTech/DeployLite", authenticatedLogin: "other" }), /account mismatch/);
});

test("exact SHA worktree fetches, detaches, and verifies its HEAD", async () => {
  const calls = [];
  const worktree = await createDetachedWorktree({ binding, controllerRoot: "/repo", worktreeParent: "/tmp", git: async (argv) => {
    calls.push(argv);
    return argv.includes("HEAD") ? sha : "";
  }, makePath: () => "/tmp/run" });
  assert.equal(worktree.path, "/tmp/run");
  assert.deepEqual(calls[0], ["-C", "/repo", "fetch", "--no-tags", "origin", sha]);
  assert.deepEqual(calls.at(-1), ["-C", "/tmp/run", "rev-parse", "HEAD"]);
});
