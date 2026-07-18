import assert from "node:assert/strict";
import test from "node:test";
import { runBridge } from "../local-ci-evidence-bridge.mjs";

const binding = Object.freeze({ githubHost: "github.com", authenticatedLogin: "maintainer", repository: "CoreFoundryTech/DeployLite", prNumber: 92, headSha: "a".repeat(40), baseSha: "b".repeat(40) });

function client() {
  const calls = [];
  return { calls, async discover() { calls.push("discover"); return binding; }, async revalidate() { calls.push("revalidate"); }, async publish(options) { calls.push(options.post ? "write" : "dry-run"); return { action: options.post ? "create" : "would-create" }; } };
}

test("RED contract dry-run revalidates but never posts or executes external commands", async () => {
  const github = client();
  const result = await runBridge(["--pr", "92", "--dry-run"], { github, execute: async () => ({ checks: [], aggregateOutcome: "blocked" }) });
  assert.equal(result.outcome, "blocked");
  assert.deepEqual(github.calls, ["discover", "revalidate", "dry-run"]);
});

test("RED contract requires explicit post confirmation", async () => {
  await assert.rejects(() => runBridge(["--pr", "92", "--post"], { github: client() }), /confirm-post/i);
});
