import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as productionEvidence from "./evidence.mjs";

const sourcePath = fileURLToPath(new URL("./evidence.mjs", import.meta.url));
const fixtureDir = await mkdtemp(join(tmpdir(), "deploylite-evidence-test-"));
const fixturePath = join(fixtureDir, "evidence.mjs");
const source = await readFile(sourcePath, "utf8");
const testFixtureSource = source.replace(
  "function createTrustedDiscovery(binding) {",
  "export function createTrustedDiscoveryForTest(binding) {"
);
assert.notEqual(testFixtureSource, source, "test fixture must expose the private factory only in its isolated copy");
await writeFile(fixturePath, testFixtureSource);
const {
  ADVISORY_ASSERTIONS,
  aggregateOutcome,
  assertBinding,
  assertCataloguedCheck,
  canonicalJson,
  createEvidence,
  createTrustedDiscoveryForTest,
  redactExcerpt
} = await import(pathToFileURL(fixturePath).href);

after(async () => rm(fixtureDir, { recursive: true, force: true }));

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
  assert.throws(() => productionEvidence.createEvidence({ binding, checks: [check] }), /trusted discovery/i);
  assert.throws(() => productionEvidence.createEvidence({ discovery: { binding }, checks: [check] }), /trusted discovery/i);

  const forgedFactory = spawnSync(process.execPath, ["--input-type=module", "--eval", `import { createEvidence, createTrustedDiscoveryForTest } from ${JSON.stringify(new URL("./evidence.mjs", import.meta.url).href)}; const discovery = createTrustedDiscoveryForTest(${JSON.stringify(binding)}); createEvidence({ discovery, checks: [${JSON.stringify(check)}] });`], {
    encoding: "utf8",
    env: { ...process.env, NODE_TEST_CONTEXT: "forged-truthy-context" }
  });
  assert.notEqual(forgedFactory.status, 0);
  assert.match(forgedFactory.stderr, /createTrustedDiscoveryForTest|trusted discovery/i);
});

test("evidence accepts a legitimate discovery created by test-only source instrumentation", () => {
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
