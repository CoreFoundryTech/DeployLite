#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const scriptPath = fileURLToPath(import.meta.url);
const root = execFileSync("git", ["-C", dirname(scriptPath), "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
if (resolve(scriptPath) !== resolve(root, "scripts/renovate-config.test.mjs")) {
  throw new Error("Renovate configuration test must run from the checkout");
}

const config = JSON.parse(await readFile(resolve(root, "renovate.json5"), "utf8"));
const fail = (message) => {
  throw new Error(`Invalid Renovate configuration: ${message}`);
};
const equal = (actual, expected, label) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} must equal ${JSON.stringify(expected)}`);
};
const ruleFor = (description) => {
  const rule = config.packageRules?.find((candidate) => candidate.description === description);
  if (!rule) fail(`missing rule: ${description}`);
  return rule;
};

const serialized = JSON.stringify(config).toLowerCase();
if (serialized.includes("latest")) fail("floating latest references are prohibited");
if (serialized.includes("automerge\":true") || config.automerge !== false || config.platformAutomerge !== false) {
  fail("automerge must be disabled everywhere");
}

equal(config.extends, ["config:recommended"], "extends");
equal(config.labels, ["dependencies", "release-baseline"], "labels");
equal(config.reviewers, ["CoreFoundryTech"], "reviewers");
equal(config.schedule, ["before 5am on monday"], "schedule");
if (config.timezone !== "Etc/UTC") fail("schedule must use UTC");
if (config.prConcurrentLimit !== 3 || config.branchConcurrentLimit !== 3 || config.prHourlyLimit !== 1) {
  fail("PR and branch concurrency limits must be bounded");
}
if (config.separateMajorMinor !== true || config.separateMultipleMajor !== true) {
  fail("major updates must be isolated");
}
if (!config.prBodyNotes?.some((note) => note.includes("baseline CI evidence"))) {
  fail("PR body must require baseline CI evidence");
}

const nonMajorTypes = ["digest", "patch", "minor"];
const npm = ruleFor("Keep npm patch and minor updates reviewable within the npm ecosystem");
equal(npm.matchManagers, ["npm"], "npm managers");
equal(npm.matchUpdateTypes, ["patch", "minor"], "npm update types");
const actions = ruleFor("Keep GitHub Action SHA and non-major updates isolated from application dependencies");
equal(actions.matchManagers, ["github-actions"], "GitHub Actions managers");
equal(actions.matchUpdateTypes, nonMajorTypes, "GitHub Actions update types");
const dockerfile = ruleFor("Keep Dockerfile base-image patch and digest updates isolated");
equal(dockerfile.matchManagers, ["dockerfile"], "Dockerfile managers");
equal(dockerfile.matchUpdateTypes, nonMajorTypes, "Dockerfile update types");
const compose = ruleFor("Keep Compose image patch and digest updates isolated from Dockerfiles");
equal(compose.matchManagers, ["docker-compose"], "Compose managers");
equal(compose.excludePackageNames, ["traefik"], "Compose exclusions");
const traefik = ruleFor("Keep Traefik updates isolated for Docker 29 compatibility review");
equal(traefik.matchPackageNames, ["traefik"], "Traefik packages");
if (traefik.allowedVersions !== ">=3.6.7 <4") fail("Traefik must remain within the documented support boundary");
const node = ruleFor("Keep Node runtime updates isolated from Docker image updates");
equal(node.matchPackageNames, ["node"], "Node packages");
if (node.allowedVersions !== ">=24.12.0 <25") fail("Node must remain within the documented support boundary");
const pnpm = ruleFor("Keep Corepack pnpm updates isolated from npm dependency updates");
equal(pnpm.matchPackageNames, ["pnpm"], "pnpm packages");
equal(pnpm.matchManagers, ["npm"], "pnpm managers");
equal(pnpm.matchDepTypes, ["packageManager"], "pnpm dependency types");
if (pnpm.allowedVersions !== ">=9.15.4 <10") fail("pnpm must remain within the documented support boundary");
const majors = ruleFor("Require manual dashboard approval before any major update PR is created");
equal(majors.matchUpdateTypes, ["major"], "major update types");
if (majors.dependencyDashboardApproval !== true || majors.automerge !== false) fail("major updates require manual approval without automerge");

const groupedRules = config.packageRules.filter((rule) => rule.groupName);
const groupNames = new Set(groupedRules.map((rule) => rule.groupName));
if (groupNames.size !== groupedRules.length) fail("group names must not span ecosystems");
if (groupedRules.some((rule) => rule.matchManagers?.length !== 1)) fail("grouped rules must target exactly one ecosystem manager");
if (config.customManagers?.length !== 1 || config.customManagers[0].customType !== "regex" || config.customManagers[0].datasourceTemplate !== "node-version") {
  fail("the Node version file must use an explicit node-version regex manager");
}

if (process.argv.includes("--dry-run")) {
  console.log("Renovate dry-run policy: configuration is bounded; no network, branch, PR, or dependency mutation was requested.");
}
console.log("Renovate configuration passed.");
