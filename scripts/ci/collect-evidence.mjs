#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const scriptPath = fileURLToPath(import.meta.url);
const root = execFileSync("git", ["-C", dirname(scriptPath), "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const expectedScript = resolve(root, "scripts/ci/collect-evidence.mjs");
if (resolve(scriptPath) !== expectedScript) throw new Error("collector must run from scripts/ci inside the checkout");

const args = process.argv.slice(2);
const value = (flag) => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};
const values = (flag) => args.flatMap((arg, index) => arg === flag ? [args[index + 1]] : []).filter(Boolean);
const withinRoot = (path) => !isAbsolute(path) && !relative(root, resolve(root, path)).startsWith("..");
const sha256 = /^sha256:[a-f0-9]{64}$/;
const actionPin = /uses:\s+[^\s@]+@[a-f0-9]{40}(?:\s+#\s+[^\n]+)?$/gm;

async function validateInputs() {
  const workflow = await readFile(resolve(root, ".github/workflows/baseline.yml"), "utf8");
  const compose = await readFile(resolve(root, "infra/vps/compose.yml"), "utf8");
  const exceptions = JSON.parse(await readFile(resolve(root, "security/scanner-exceptions.yaml"), "utf8"));
  const pins = workflow.match(actionPin) ?? [];
  if (pins.length < 4 || /uses:\s+[^\s@]+@(?![a-f0-9]{40})/m.test(workflow)) throw new Error("all Actions must be pinned to immutable commit SHAs");
  if (!compose.includes("traefik:v3.6.7@sha256:") || !compose.includes("postgres:16-alpine@sha256:")) throw new Error("Compose must digest-pin Traefik and PostgreSQL");
  if (exceptions.version !== 1 || !Array.isArray(exceptions.exceptions)) throw new Error("scanner exceptions must be a versioned array");
  const now = new Date(process.env.CI_EVIDENCE_NOW ?? Date.now());
  if (Number.isNaN(now.valueOf())) throw new Error("CI_EVIDENCE_NOW must be a valid timestamp");
  for (const exception of exceptions.exceptions) {
    for (const field of ["id", "component", "owner", "rationale", "compensatingControl", "reviewer", "evidence", "expiresAt"]) {
      if (typeof exception[field] !== "string" || exception[field].length === 0) throw new Error(`scanner exception is missing ${field}`);
    }
    if (new Date(exception.expiresAt) <= now) throw new Error(`scanner exception ${exception.id} is expired`);
  }
}

await validateInputs();
if (args.includes("--check-only")) {
  console.log("CI evidence configuration passed.");
  process.exit(0);
}

const output = value("--output");
const commit = value("--commit");
const lockHash = value("--lock-hash");
const composeDigest = value("--compose-digest");
const images = values("--image").map((input) => {
  const [tag, digest, platform, buildId] = input.split(",");
  if (![tag, digest, platform, buildId].every(Boolean) || !sha256.test(digest)) throw new Error("images require tag,digest,platform,buildId with a sha256 digest");
  return { tag, digest, platform, buildId };
});
const checks = values("--check").map((input) => {
  const [name, result] = input.split(":");
  if (!name || !["pass", "fail", "exception"].includes(result)) throw new Error("checks require name:pass|fail|exception");
  return { name, result, command: "GitHub Actions baseline job", artifact: `artifacts/${name}.log`, timestamp: new Date().toISOString() };
});
if (!output || !withinRoot(output) || !/^[0-9a-f]{40}$/.test(commit ?? "") || !/^[0-9a-f]{64}$/.test(lockHash ?? "") || !sha256.test(composeDigest ?? "") || images.length === 0 || checks.length === 0) {
  throw new Error("output, commit, lock hash, Compose digest, image identity, and checks are required");
}
const evidence = {
  commit,
  alphaPosture: "alpha-early-access",
  runtime: { node: "24.12.0", pnpm: "9.15.4", lockHash },
  inputs: { composeDigest },
  images,
  checks,
  exceptions: JSON.parse(await readFile(resolve(root, "security/scanner-exceptions.yaml"), "utf8")).exceptions,
  smoke: { status: "pending", target: "non-production smoke not run by baseline CI" },
  review: { reviewer: "pending-independent-review", approvalLocation: "https://github.com/CoreFoundryTech/DeployLite/pulls" },
  artifacts: ["artifacts/baseline-evidence.json"]
};
const destination = resolve(root, output);
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`Wrote evidence to ${output}`);
