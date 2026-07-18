import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ADVISORY_ASSERTIONS, aggregateOutcome, assertBinding, assertCataloguedCheck, canonicalJson, redactExcerpt } from "./evidence.mjs";

const execFileAsync = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const fail = (message) => { throw new TypeError(message); };
const parse = (value) => { try { return JSON.parse(value); } catch { return fail("GitHub returned invalid JSON"); } };
const endpoint = (binding, suffix) => `repos/${binding.repository}/issues/${binding.prNumber}${suffix}`;

export function markerFor(binding) {
  const { repository, prNumber, headSha } = assertBinding(binding);
  return `<!-- deploylite-local-ci-evidence:${repository}:${prNumber}:${headSha} -->`;
}

export function renderAdvisoryComment({ binding, evidenceHash, aggregateOutcome }) {
  if (!/^[a-f0-9]{64}$/.test(evidenceHash)) fail("evidence hash is required");
  return `${markerFor(binding)}\n<!-- evidence-sha256:${evidenceHash} -->\n## Local CI advisory evidence\n\nOutcome: **${aggregateOutcome}** for \`${binding.headSha}\`.\n\nThis is local advisory evidence, not GitHub Actions, not a required check, not a merge or release gate, and not a receipt or hosted provenance. Required checks remain unsatisfied, release eligibility is unchanged, PR #85 remains blocked, and DeployLite remains Alpha.`;
}

export function createGitHubClient({ run = defaultRun } = {}) {
  const account = async (host) => {
    const login = (await run(["api", "--hostname", host, "user", "--jq", ".login"])).trim();
    if (!login) fail("authenticated GitHub identity is unavailable");
    return login;
  };
  const pull = async (binding) => {
    const value = parse(await run(["pr", "view", String(binding.prNumber), "--repo", binding.repository, "--json", "headRefOid,baseRefOid"]));
    if (!SHA.test(value.headRefOid) || value.headRefOid !== binding.headSha) fail("remote PR head SHA changed or is unreadable");
    return value;
  };
  return Object.freeze({
    async discover(prNumber) {
      if (!Number.isInteger(prNumber) || prNumber < 1) fail("PR number must be a positive integer");
      const repo = parse(await run(["repo", "view", "--json", "nameWithOwner,url"]));
      if (!repositoryPattern.test(repo.nameWithOwner)) fail("current repository is unreadable");
      const host = new URL(repo.url).hostname;
      const authenticatedLogin = await account(host);
      const pr = parse(await run(["pr", "view", String(prNumber), "--repo", repo.nameWithOwner, "--json", "headRefOid,baseRefOid"]));
      return assertBinding({ githubHost: host, authenticatedLogin, repository: repo.nameWithOwner, prNumber, headSha: pr.headRefOid, baseSha: pr.baseRefOid });
    },
    async revalidate(binding) {
      binding = assertBinding(binding);
      if (await account(binding.githubHost) !== binding.authenticatedLogin) fail("authenticated GitHub identity drifted");
      await pull(binding);
    },
    async createEvidence({ binding, checks, generatedAt = new Date().toISOString(), knownValues = [] }) {
      await this.revalidate(binding);
      const normalized = checks.map(({ id, argv, outcome, reasonCode, excerpt = "", durationMs = 0, exitCode = null }) => ({ ...assertCataloguedCheck({ id, argv }), outcome, ...(reasonCode ? { reasonCode } : {}), exitCode, durationMs, ...redactExcerpt(excerpt, { knownValues }) }));
      const payload = { schemaVersion: 1, binding: { ...binding, discovery: { source: "github-pr-discovery", verified: true } }, generatedAt, assertions: ADVISORY_ASSERTIONS, aggregateOutcome: aggregateOutcome(normalized), checks: normalized };
      return Object.freeze({ ...payload, evidenceHash: createHash("sha256").update(canonicalJson(payload)).digest("hex") });
    },
    async publish({ binding, body, post }) {
      await this.revalidate(binding);
      const comments = parse(await run(["api", "--paginate", endpoint(binding, "/comments")]));
      const existing = comments.find((comment) => comment.user?.login === binding.authenticatedLogin && comment.body?.includes(markerFor(binding)));
      if (!post) return { action: existing ? "would-update" : "would-create" };
      if (existing) {
        await run(["api", "--method", "PATCH", `repos/${binding.repository}/issues/comments/${existing.id}`, "-f", `body=${body}`]);
        return { action: "update", commentId: existing.id };
      }
      await run(["api", "--method", "POST", endpoint(binding, "/comments"), "-f", `body=${body}`]);
      return { action: "create" };
    }
  });
}

async function defaultRun(args) {
  const { stdout } = await execFileAsync("gh", args, { encoding: "utf8", maxBuffer: 1024 * 1024, shell: false });
  return stdout;
}
