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
const required = ["commit", "alphaPosture", "runtime", "inputs", "images", "checks", "exceptions", "smoke", "review", "artifacts"];

if (schema.type !== "object" || !Array.isArray(schema.required) || required.some((key) => !schema.required.includes(key))) {
  throw new Error("release evidence schema must require the complete baseline evidence envelope");
}
if (schema.properties?.alphaPosture?.const !== "alpha-early-access") {
  throw new Error("release evidence schema must lock the Alpha/early-access posture");
}
for (const key of ["checks", "exceptions", "artifacts"]) {
  if (schema.properties?.[key]?.type !== "array") {
    throw new Error(`release evidence schema must define ${key} as an array`);
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
