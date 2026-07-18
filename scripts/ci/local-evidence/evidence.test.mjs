import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ADVISORY_ASSERTIONS, aggregateOutcome, assertBinding, assertCataloguedCheck, canonicalJson, createEvidence, createTrustedDiscoveryForTest, redactExcerpt } from "./evidence.mjs";

const binding = Object.freeze({ githubHost: "github.com", authenticatedLogin: "maintainer", repository: "CoreFoundryTech/DeployLite", prNumber: 123, headSha: "a".repeat(40), baseSha: "b".repeat(40) });
const discovery = createTrustedDiscoveryForTest(binding);
const check = { id: "test", argv: ["pnpm", "test"], outcome: "pass", excerpt: "token=top-secret /Users/alice/work", durationMs: 12, exitCode: 0 };

test("RED contract rejects commands that are not fixed catalogue argv", () => {
  for (const invalid of [
    { id: "unknown", argv: ["pnpm", "test"] }, { id: "test", argv: ["TOKEN=value", "pnpm"] },
    { id: "test", argv: ["git", "HEAD"] }, { id: "test", argv: ["node", "docs/run.md"] }, { id: "test", argv: ["pnpm", "test; rm -rf /"] }
  ]) assert.throws(() => assertCataloguedCheck(invalid));
});

test("binding is immutable and rejects an unprovable account, repo, PR, or SHA", () => {
  assert(Object.isFrozen(assertBinding(binding)));
  for (const invalid of [{ ...binding, authenticatedLogin: "" }, { ...binding, repository: "wrong" }, { ...binding, prNumber: 0 }, { ...binding, headSha: "A".repeat(40) }]) {
    assert.throws(() => assertBinding(invalid));
  }
});

test("evidence creation rejects forged caller-controlled discovery bindings", () => {
  assert.throws(() => createEvidence({ binding, checks: [check] }), /trusted discovery/i);
  assert.throws(() => createEvidence({ discovery: { binding }, checks: [check] }), /trusted discovery/i);

  const forgedFactory = spawnSync(process.execPath, ["--input-type=module", "--eval", `import { createTrustedDiscoveryForTest } from ${JSON.stringify(new URL("./evidence.mjs", import.meta.url).href)}; createTrustedDiscoveryForTest(${JSON.stringify(binding)});`], {
    encoding: "utf8",
    env: { ...process.env, NODE_TEST_CONTEXT: "" }
  });
  assert.notEqual(forgedFactory.status, 0);
  assert.match(forgedFactory.stderr, /unavailable outside node:test/i);
});

test("evidence accepts a legitimate discovery created by the controlled test boundary", () => {
  assert.throws(() => createTrustedDiscoveryForTest({ ...binding, authenticatedLogin: "" }));
  const evidence = createEvidence({ discovery, checks: [check] });
  assert.deepEqual(evidence.binding.discovery, { source: "github-pr-discovery", verified: true });
});

test("aggregation preserves blocked and failure rather than claiming pass", () => {
  assert.equal(aggregateOutcome([{ outcome: "pass" }, { outcome: "fail" }]), "fail");
  assert.equal(aggregateOutcome([{ outcome: "pass" }, { outcome: "blocked" }]), "blocked");
  assert.throws(() => aggregateOutcome([]));
});

test("RED contract rejects malformed reason codes instead of serializing ambiguous evidence", () => {
  assert.throws(() => createEvidence({ discovery, checks: [{ ...check, reasonCode: 42 }] }));
});

test("evidence rejects secret-bearing argv before serialization and hashing", () => {
  for (const argv of [["pnpm", "test", "--token=top-secret"], ["pnpm", "test", "--api-key", "top-secret"], ["pnpm", "test", "ghp_abcdefghijklmnopqrstuvwxyz1234567890"]]) {
    assert.throws(() => createEvidence({ discovery, checks: [{ ...check, argv }] }), /secret-bearing argv/i);
  }
  assert.throws(() => createEvidence({ discovery, checks: [{ ...check, argv: ["pnpm", "test", "known-secret"] }], knownValues: ["known-secret"] }), /secret-bearing argv/i);
});

test("canonical serialization and hash are deterministic regardless of input key order", () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, b: 3 } }), canonicalJson({ a: { b: 3, y: 2 }, z: 1 }));
  const first = createEvidence({ discovery, checks: [check] });
  const second = createEvidence({ discovery: createTrustedDiscoveryForTest({ ...binding }), checks: [{ ...check, argv: [...check.argv] }] });
  assert.equal(first.evidenceHash, second.evidenceHash);
});

test("evidence redacts known values and paths and carries non-equivalence assertions", () => {
  const redacted = redactExcerpt("password: hunter2 /home/alice/project", { knownValues: ["hunter2"] });
  assert.match(redacted.excerpt, /REDACTED/);
  assert.doesNotMatch(redacted.excerpt, /hunter2|\/home\/alice/);
  const evidence = createEvidence({ discovery, checks: [check], knownValues: ["top-secret"] });
  assert.deepEqual(evidence.assertions, ADVISORY_ASSERTIONS);
  assert.equal(evidence.assertions.satisfiesRequiredChecks, false);
  assert.equal(evidence.assertions.releaseEligibilityChanged, false);
});
