import { createHash } from "node:crypto";

export const OUTCOMES = Object.freeze(["pass", "fail", "blocked"]);
export const CATALOGUE_IDS = Object.freeze(new Set([
  "runtime-contract", "vitest-forbid-only", "lint", "typecheck", "test", "build", "evidence-config",
  "compose-contract", "postgres-integration", "actionlint", "trivy"
]));

export const ADVISORY_ASSERTIONS = Object.freeze({
  source: "local",
  advisory: true,
  receipt: false,
  githubActions: false,
  satisfiesRequiredChecks: false,
  releaseEligibilityChanged: false,
  alphaPosture: "alpha-early-access"
});

const sha = /^[a-f0-9]{40}$/;
const unsafeArgument = /(?:[;&|`$()]|^\w+=|^HEAD$|^refs\/|\.(?:md|json|ya?ml)$)/i;
const secretOption = /^--?(?:api[-_]?key|auth(?:orization)?|credential|gh[-_]?token|password|private[-_]?key|secret|token)(?:=|$)/i;
const secretValue = /(?:\b(?:api[-_]?key|auth(?:orization)?|credential|gh[-_]?token|password|private[-_]?key|secret|token)\b\s*[:=]|\bbearer\s+|\bgh[pousr]_[a-z0-9_]+\b|\bgithub_pat_[a-z0-9_]+\b|\bAKIA[0-9A-Z]{16}\b)/i;
const trustedDiscoveries = new WeakSet();

function assert(condition, message) {
  if (!condition) throw new TypeError(message);
}

export function assertBinding(binding) {
  assert(binding && typeof binding === "object", "binding is required");
  const { githubHost, authenticatedLogin, repository, prNumber, headSha, baseSha } = binding;
  assert(typeof githubHost === "string" && githubHost.length > 0, "githubHost is required");
  assert(typeof authenticatedLogin === "string" && authenticatedLogin.length > 0, "authenticatedLogin is required");
  assert(typeof repository === "string" && /^[^/\s]+\/[^/\s]+$/.test(repository), "repository must be owner/name");
  assert(Number.isInteger(prNumber) && prNumber > 0, "prNumber must be a positive integer");
  assert(typeof headSha === "string" && sha.test(headSha), "headSha must be a lowercase 40-character SHA");
  assert(baseSha === undefined || (typeof baseSha === "string" && sha.test(baseSha)), "baseSha must be a lowercase 40-character SHA");
  return Object.freeze({ githubHost, authenticatedLogin, repository, prNumber, headSha, ...(baseSha ? { baseSha } : {}) });
}

function createTrustedDiscovery(binding) {
  const source = "github-pr-discovery";
  const verified = true;
  assert(source === "github-pr-discovery" && verified === true, "discovery must be verified by GitHub PR discovery");
  const trusted = Object.freeze({
    binding: Object.freeze({ ...assertBinding(binding), discovery: Object.freeze({ source, verified }) })
  });
  trustedDiscoveries.add(trusted);
  return trusted;
}

/**
 * Controlled node:test-only seam. Production callers have no binding factory:
 * a later GitHub discovery boundary will create the private trusted capsule.
 */
export function createTrustedDiscoveryForTest(binding) {
  assert(process.env.NODE_TEST_CONTEXT, "trusted discovery test seam is unavailable outside node:test");
  return createTrustedDiscovery(binding);
}

export function assertCataloguedCheck({ id, argv }) {
  assert(CATALOGUE_IDS.has(id), `check ${id} is not catalogued`);
  assert(Array.isArray(argv) && argv.length > 0 && argv.every((part) => typeof part === "string" && part.length > 0), "argv must be a non-empty string array");
  assert(argv.every((part) => !unsafeArgument.test(part)), "argv must not contain shell, environment, ref, or documentation/config arguments");
  return Object.freeze({ id, argv: Object.freeze([...argv]) });
}

function assertSafeArgv(argv, knownValues) {
  const knownSecrets = [...knownValues].filter((value) => typeof value === "string" && value.length > 0);
  const containsKnownSecret = (argument) => knownSecrets.some((secret) => argument.includes(secret));
  assert(!argv.some((argument) => secretOption.test(argument) || secretValue.test(argument) || containsKnownSecret(argument)), "secret-bearing argv must be rejected before evidence serialization");
}

export function aggregateOutcome(checks) {
  assert(Array.isArray(checks) && checks.length > 0, "at least one check is required");
  for (const check of checks) assert(OUTCOMES.includes(check.outcome), "check outcome must be pass, fail, or blocked");
  if (checks.some((check) => check.outcome === "blocked")) return "blocked";
  return checks.some((check) => check.outcome === "fail") ? "fail" : "pass";
}

export function redactExcerpt(value, { knownValues = [], limit = 1600 } = {}) {
  assert(typeof value === "string", "excerpt must be a string");
  let redactions = 0;
  let result = value.replace(/\b(?:token|secret|password|authorization)\b\s*([=:])\s*[^\s]+/gi, (_, separator) => {
    redactions += 1;
    return `redacted${separator}[REDACTED]`;
  }).replace(/\/(?:Users|home)\/[^\s]+/g, () => {
    redactions += 1;
    return "[REDACTED_PATH]";
  });
  for (const knownValue of [...knownValues].filter(Boolean).sort((a, b) => b.length - a.length)) {
    const escaped = knownValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(escaped, "g"), () => {
      redactions += 1;
      return "[REDACTED]";
    });
  }
  return Object.freeze({ excerpt: result.slice(0, limit), redactions, truncated: result.length > limit });
}

export function canonicalJson(value) {
  const sort = (input) => Array.isArray(input)
    ? input.map(sort)
    : input && typeof input === "object"
      ? Object.fromEntries(Object.keys(input).sort().map((key) => [key, sort(input[key])]))
      : input;
  return JSON.stringify(sort(value));
}

export function createEvidence({ discovery, checks, generatedAt = "1970-01-01T00:00:00.000Z", knownValues = [] }) {
  assert(trustedDiscoveries.has(discovery), "trusted discovery binding is required for evidence creation");
  const immutableBinding = discovery.binding;
  assert(Array.isArray(checks), "checks must be an array");
  const normalizedChecks = checks.map(({ id, argv, outcome, reasonCode, excerpt = "", durationMs = 0, exitCode = null }) => {
    const command = assertCataloguedCheck({ id, argv });
    assertSafeArgv(command.argv, knownValues);
    assert(OUTCOMES.includes(outcome), "check outcome must be pass, fail, or blocked");
    assert(reasonCode === undefined || (typeof reasonCode === "string" && reasonCode.length > 0), "reasonCode must be a non-empty string when provided");
    assert(Number.isInteger(durationMs) && durationMs >= 0, "durationMs must be a non-negative integer");
    const redacted = redactExcerpt(excerpt, { knownValues });
    return { ...command, outcome, ...(reasonCode ? { reasonCode } : {}), exitCode, durationMs, ...redacted };
  });
  const payload = { schemaVersion: 1, binding: immutableBinding, generatedAt, assertions: ADVISORY_ASSERTIONS, aggregateOutcome: aggregateOutcome(normalizedChecks), checks: normalizedChecks };
  return Object.freeze({ ...payload, evidenceHash: createHash("sha256").update(canonicalJson(payload)).digest("hex") });
}
