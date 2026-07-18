import assert from "node:assert/strict";
import test from "node:test";
import { createGitHubClient, markerFor, renderAdvisoryComment } from "./github.mjs";

const sha = "a".repeat(40);
const binding = Object.freeze({ githubHost: "github.com", authenticatedLogin: "maintainer", repository: "CoreFoundryTech/DeployLite", prNumber: 92, headSha: sha, baseSha: "b".repeat(40) });

function fakeGh({ login = "maintainer", repository = binding.repository, headSha = sha, comments = [] } = {}) {
  const calls = [];
  return {
    calls,
    async run(args) {
      calls.push(args);
      if (args[0] === "repo") return JSON.stringify({ nameWithOwner: repository, url: `https://github.com/${repository}` });
      if (args[0] === "api" && args.includes("user")) return login;
      if (args[0] === "pr") return JSON.stringify({ number: binding.prNumber, headRefOid: headSha, baseRefOid: binding.baseSha });
      if (args.some((part) => part.includes("comments"))) return JSON.stringify(comments);
      return "";
    }
  };
}

test("RED contract blocks identity drift and stale heads before a write", async () => {
  const identityDrift = fakeGh({ login: "other" });
  await assert.rejects(() => createGitHubClient(identityDrift).revalidate(binding), /identity/i);
  assert.equal(identityDrift.calls.some((args) => args.includes("--method")), false);

  const stale = fakeGh({ headSha: "c".repeat(40) });
  await assert.rejects(() => createGitHubClient(stale).revalidate(binding), /head SHA/i);
  assert.equal(stale.calls.some((args) => args.includes("--method")), false);
});

test("RED contract blocks active repository drift before a write", async () => {
  const repositoryDrift = fakeGh({ repository: "CoreFoundryTech/other-repository" });
  await assert.rejects(() => createGitHubClient(repositoryDrift).revalidate(binding), /repository/i);
  assert.equal(repositoryDrift.calls.some((args) => args.includes("--method")), false);
});

test("RED contract paginates comments and updates exactly one matching marker", async () => {
  const marker = markerFor(binding);
  const gh = fakeGh({ comments: [{ id: 7, body: `${marker}\nold`, user: { login: "maintainer" } }, { id: 8, body: `${marker}\nother`, user: { login: "someone-else" } }] });
  const result = await createGitHubClient(gh).publish({ binding, body: "new advisory evidence", post: true });
  assert.deepEqual(result, { action: "update", commentId: 7 });
  const write = gh.calls.at(-1);
  assert.deepEqual(write.slice(0, 4), ["api", "--method", "PATCH", "repos/CoreFoundryTech/DeployLite/issues/comments/7"]);
  assert.equal(gh.calls.some((args) => args.includes("--paginate")), true);
});

test("RED contract dry-run has zero writes and forbidden GitHub APIs are unreachable", async () => {
  const gh = fakeGh();
  const client = createGitHubClient(gh);
  assert.deepEqual(await client.publish({ binding, body: "ignored", post: false }), { action: "would-create" });
  assert.equal(gh.calls.some((args) => args.includes("--method")), false);
  for (const args of gh.calls) assert.equal(args.join(" ").match(/check-runs|statuses|actions|workflow|receipts/i), null);
});

test("advisory comment carries its immutable SHA and digest disclaimers", () => {
  const body = renderAdvisoryComment({ binding, evidenceHash: "d".repeat(64), aggregateOutcome: "pass" });
  assert.match(body, new RegExp(markerFor(binding)));
  assert.match(body, /evidence-sha256:d{64}/);
  assert.match(body, /not GitHub Actions|not a required check|not a receipt/i);
  assert.match(body, /Alpha/i);
});
