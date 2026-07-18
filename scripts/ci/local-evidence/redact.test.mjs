import assert from "node:assert/strict";
import test from "node:test";
import { redactOutput } from "./redact.mjs";

test("RED redacts secret keys, known values, and absolute paths before evidence", () => {
  const result = redactOutput("token=top-secret /Users/alice/repo value=known-value", { knownValues: ["known-value"], canary: "canary-value" });
  assert.equal(result.safe, true);
  assert.equal(result.excerpt.includes("top-secret"), false);
  assert.equal(result.excerpt.includes("known-value"), false);
  assert.equal(result.excerpt.includes("/Users/alice"), false);
});

test("canary residue removes excerpts and blocks persistence", () => {
  const result = redactOutput("CANARY-VALUE", { canary: "canary-value" });
  assert.deepEqual(result, { safe: false, excerpt: "", redactions: 0, truncated: false, reasonCode: "unsafe_output" });
});
