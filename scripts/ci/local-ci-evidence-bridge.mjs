import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { createGitHubClient, renderAdvisoryComment } from "./local-evidence/github.mjs";
import { executeIsolated } from "./local-evidence/execute.mjs";
import { getChecks } from "./local-evidence/catalog.mjs";

const execFileAsync = promisify(execFile);
const parseArgs = (args) => {
  const value = (flag) => args[args.indexOf(flag) + 1];
  const pr = Number(value("--pr"));
  if (!Number.isInteger(pr) || pr < 1) throw new TypeError("--pr must be a positive integer");
  const post = args.includes("--post"), dryRun = args.includes("--dry-run");
  if (post && !args.includes("--confirm-post")) throw new TypeError("--post requires --confirm-post");
  return { pr, post, dryRun, ids: (value("--checks") ?? "runtime-contract").split(","), output: value("--output") ?? `artifacts/advisory/pr-${pr}.json` };
};

export async function runBridge(args, { github = createGitHubClient(), execute = defaultExecute, write = defaultWrite } = {}) {
  const options = parseArgs(args);
  const binding = await github.discover(options.pr);
  if (options.dryRun) {
    await github.revalidate(binding);
    const publication = await github.publish({ binding, body: "", post: false });
    return { outcome: "blocked", reasonCode: "dry_run_no_execution", binding, publication };
  }
  await github.revalidate(binding);
  const execution = await execute(binding, options.ids);
  let evidence;
  try { evidence = await github.createEvidence({ binding, checks: execution.checks }); } catch (error) { return { outcome: "blocked", reasonCode: "identity_revalidation_failed", detail: error.message }; }
  try { await write(options.output, `${JSON.stringify(evidence, null, 2)}\n`); } catch (error) { return { outcome: "blocked", reasonCode: "evidence_write_failed", detail: error.message }; }
  let publication;
  try { publication = await github.publish({ binding, body: renderAdvisoryComment(evidence), post: options.post }); } catch (error) { return { outcome: "blocked", reasonCode: "publication_revalidation_failed", detail: error.message }; }
  return { outcome: evidence.aggregateOutcome, binding, evidenceHash: evidence.evidenceHash, publication };
}

async function defaultExecute(binding, ids) {
  const checks = getChecks(ids);
  const available = new Set((await Promise.all([...new Set(checks.map((check) => check.capability))].map(async (name) => {
    try { await execFileAsync("which", [name], { shell: false }); return name; } catch { return null; }
  }))).filter(Boolean));
  const git = async (args) => (await execFileAsync("git", args, { encoding: "utf8", shell: false })).stdout;
  return executeIsolated({ binding, expected: binding, controllerRoot: process.cwd(), worktreeParent: tmpdir(), ids, git, available });
}

async function defaultWrite(path, content) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content, { mode: 0o600 }); }

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  runBridge(process.argv.slice(2)).then((result) => { console.log(JSON.stringify(result)); process.exitCode = result.outcome === "pass" ? 0 : 1; }).catch((error) => { console.log(JSON.stringify({ outcome: "blocked", reasonCode: "bridge_error" })); console.error(error.message); process.exitCode = 1; });
}
