import assert from "node:assert/strict";
import test from "node:test";
import { getChecks } from "./catalog.mjs";

test("RED fixed catalog rejects unknown, composed, and document-derived checks", () => {
  assert.throws(() => getChecks(["unknown"]), /catalogued/);
  assert.throws(() => getChecks(["test; rm -rf /"]), /catalogued/);
  assert.throws(() => getChecks(["docs/run.md"]), /catalogued/);
});

test("fixed catalog returns immutable argv without caller supplied additions", () => {
  const [check] = getChecks(["runtime-contract"]);
  assert.deepEqual(check.argv, ["node", "--test", "scripts/ci/local-evidence/evidence.test.mjs"]);
  assert.throws(() => check.argv.push("--unsafe"));
});
