const CHECKS = Object.freeze({
  "runtime-contract": { argv: ["node", "--test", "scripts/ci/local-evidence/evidence.test.mjs"], capability: "node", timeoutMs: 30_000 },
  "vitest-forbid-only": { argv: ["pnpm", "exec", "vitest", "run"], capability: "pnpm", timeoutMs: 120_000 },
  lint: { argv: ["pnpm", "lint"], capability: "pnpm", timeoutMs: 120_000 },
  typecheck: { argv: ["pnpm", "typecheck"], capability: "pnpm", timeoutMs: 120_000 },
  test: { argv: ["pnpm", "test"], capability: "pnpm", timeoutMs: 180_000 },
  build: { argv: ["pnpm", "build"], capability: "pnpm", timeoutMs: 180_000 },
  "evidence-config": { argv: ["node", "--check", "scripts/ci/local-evidence/evidence.mjs"], capability: "node", timeoutMs: 30_000 },
  "compose-contract": { argv: ["docker", "compose", "config", "--quiet"], capability: "docker", timeoutMs: 60_000 },
  "postgres-integration": { argv: ["pnpm", "test", "--", "--project=postgres"], capability: "postgres", timeoutMs: 180_000 },
  actionlint: { argv: ["actionlint"], capability: "actionlint", timeoutMs: 60_000 },
  trivy: { argv: ["trivy", "fs", "--quiet", "."], capability: "trivy", timeoutMs: 180_000 }
});

export function getChecks(ids) {
  if (!Array.isArray(ids) || ids.length === 0) throw new TypeError("at least one catalogued check is required");
  return Object.freeze(ids.map((id) => {
    const check = CHECKS[id];
    if (!check) throw new TypeError(`check ${id} is not catalogued`);
    return Object.freeze({ id, argv: Object.freeze([...check.argv]), capability: check.capability, timeoutMs: check.timeoutMs });
  }));
}
