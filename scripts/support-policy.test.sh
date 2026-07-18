#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  printf 'support policy validation failed: %s\n' "$*" >&2
  exit 1
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
root_dir="$(git -C "${script_dir}/.." rev-parse --show-toplevel 2>/dev/null)" || fail "script must run from a Git checkout"
[[ "${script_dir}/support-policy.test.sh" == "${root_dir}/scripts/support-policy.test.sh" ]] || fail "script must be located inside the checkout"
cd -- "${root_dir}"

for file in docs/support-policy.md docs/release-evidence.md schemas/release-evidence.schema.json; do
  [[ -f "${file}" ]] || fail "missing required file: ${file}"
done

node --input-type=module <<'NODE'
import { readFile } from "node:fs/promises";

const schema = JSON.parse(await readFile("schemas/release-evidence.schema.json", "utf8"));
const fixtureDir = "schemas/fixtures";
const required = ["commit", "alphaPosture", "runtime", "inputs", "images", "checks", "exceptions", "smoke", "review", "artifacts"];
const digest = /^sha256:[0-9a-f]{64}$/;
const sha = /^[0-9a-f]{40}$/;
const exceptionId = /^[A-Z][A-Z0-9_-]*-[0-9]+$/;
const asOf = Date.parse("2026-07-18T00:00:00.000Z");

const fail = (message) => { throw new Error(message); };
const object = (value, label) => value && typeof value === "object" && !Array.isArray(value) ? value : fail(`${label} must be an object`);
const text = (value, label) => typeof value === "string" && value.length > 0 ? value : fail(`${label} must be a non-empty string`);
const dateTime = (value, label) => /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? value : fail(`${label} must be an RFC 3339 date-time`);

if (schema.type !== "object" || !Array.isArray(schema.required) || required.some((key) => !schema.required.includes(key))) {
  fail("release evidence schema must require the complete baseline evidence envelope");
}
if (schema.properties?.alphaPosture?.const !== "alpha-early-access") {
  fail("release evidence schema must lock the Alpha/early-access posture");
}
for (const key of ["images", "checks", "artifacts"]) {
  if (schema.properties?.[key]?.type !== "array" || schema.properties[key].minItems !== 1) {
    fail(`release evidence schema must require non-empty ${key}`);
  }
}
if (schema.properties?.exceptions?.type !== "array") {
  fail("release evidence schema must define exceptions as an array");
}
for (const key of ["runtime", "inputs", "smoke", "review"]) {
  if (schema.properties?.[key]?.type !== "object" || !Array.isArray(schema.properties[key].required) || schema.properties[key].required.length === 0) {
    fail(`release evidence schema must require material ${key} evidence`);
  }
}
if (schema.properties?.exceptions?.items?.properties?.expiresAt?.format !== "date-time") {
  fail("release evidence schema must require exception expiry as date-time");
}
if (schema.properties?.images?.items?.properties?.digest?.pattern !== "^sha256:[0-9a-f]{64}$") {
  fail("release evidence schema must require immutable image digests");
}
if (schema.properties?.checks?.items?.properties?.timestamp?.format !== "date-time") {
  fail("release evidence schema must require check timestamps as date-time");
}

function validateRecord(record) {
  object(record, "record");
  if (!sha.test(record.commit ?? "")) fail("commit must be a 40-character lowercase SHA");
  if (record.alphaPosture !== "alpha-early-access") fail("Alpha posture must remain locked");
  const runtime = object(record.runtime, "runtime");
  text(runtime.node, "runtime.node"); text(runtime.pnpm, "runtime.pnpm");
  if (!/^[0-9a-f]{64}$/.test(runtime.lockHash ?? "")) fail("runtime.lockHash must be a SHA-256 hash");
  const inputs = object(record.inputs, "inputs");
  if (!digest.test(inputs.composeDigest ?? "")) fail("inputs.composeDigest must be an immutable digest");
  if (!Array.isArray(record.images) || record.images.length === 0) fail("images must be non-empty");
  for (const image of record.images) {
    object(image, "image"); text(image.tag, "image.tag"); text(image.platform, "image.platform"); text(image.buildId, "image.buildId");
    if (!digest.test(image.digest ?? "")) fail("image.digest must be immutable");
  }
  if (!Array.isArray(record.checks) || record.checks.length === 0) fail("checks must be non-empty");
  const exceptions = Array.isArray(record.exceptions) ? record.exceptions : fail("exceptions must be an array");
  const exceptionIds = new Set();
  for (const exception of exceptions) {
    object(exception, "exception");
    for (const key of ["id", "component", "owner", "rationale", "compensatingControl", "reviewer", "evidence", "expiresAt"]) text(exception[key], `exception.${key}`);
    if (!exceptionId.test(exception.id)) fail("exception.id has an invalid format");
    const expiry = Date.parse(dateTime(exception.expiresAt, "exception.expiresAt"));
    if (expiry <= asOf) fail("exception.expiresAt is expired");
    exceptionIds.add(exception.id);
  }
  for (const check of record.checks) {
    object(check, "check");
    for (const key of ["name", "result", "command", "artifact", "timestamp"]) text(check[key], `check.${key}`);
    if (!new Set(["pass", "fail", "exception"]).has(check.result)) fail("check.result is invalid");
    dateTime(check.timestamp, "check.timestamp");
    if (check.result === "exception" && (!exceptionId.test(check.exceptionId ?? "") || !exceptionIds.has(check.exceptionId))) fail("exception check must reference a declared exception");
  }
  const smoke = object(record.smoke, "smoke"); text(smoke.status, "smoke.status"); text(smoke.target, "smoke.target");
  const review = object(record.review, "review"); text(review.reviewer, "review.reviewer"); text(review.approvalLocation, "review.approvalLocation");
  if (!Array.isArray(record.artifacts) || record.artifacts.length === 0 || record.artifacts.some((artifact) => typeof artifact !== "string" || artifact.length === 0)) fail("artifacts must be non-empty");
}

const valid = JSON.parse(await readFile(`${fixtureDir}/release-evidence.valid.json`, "utf8"));
validateRecord(valid);
for (const file of ["release-evidence.incomplete.json", "release-evidence.malformed-exception.json", "release-evidence.expired-exception.json"]) {
  const invalid = JSON.parse(await readFile(`${fixtureDir}/${file}`, "utf8"));
  try { validateRecord(invalid); fail(`${file} must be rejected`); } catch (error) {
    if (error.message === `${file} must be rejected`) throw error;
  }
}
NODE

required_policy_sections=(
  "Support matrix"
  "Version/range owner"
  "Support boundary and compatibility expectation"
  "Update cadence/trigger"
  "Upgrade controls"
  "Rollback policy"
  "Exceptions and expiry"
  "Non-goals"
  "Node.js"
  "Corepack-managed pnpm"
  "Docker Engine"
  "Docker Compose plugin"
  "Traefik"
  "PostgreSQL"
)

for section in "${required_policy_sections[@]}"; do
  grep -Fq "${section}" docs/support-policy.md || fail "support policy missing: ${section}"
done

grep -Fq "observed Docker 29 compatibility only" docs/support-policy.md || fail "Traefik compatibility caveat is missing"
grep -Fq "not proof of support, lifecycle, provenance, supply-chain integrity, or upgrade readiness" docs/support-policy.md || fail "Traefik caveat is incomplete"
grep -Fq "Alpha/early access" docs/release-evidence.md || fail "release evidence must retain Alpha wording"
for control in "pre-upgrade checks" "rollback trigger" "rollback steps" "expiry"; do
  grep -Fqi "${control}" docs/release-evidence.md || fail "release evidence missing: ${control}"
done

printf 'Support policy and release-evidence schema validation passed.\n'
printf 'Release-evidence record fixtures: 1 valid accepted; 3 invalid rejected.\n'
