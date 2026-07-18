import { getChecks } from "./catalog.mjs";
import { aggregateOutcome } from "./evidence.mjs";
import { runCheck } from "./process.mjs";
import { redactOutput } from "./redact.mjs";
import { assertExecutionBinding, createDetachedWorktree, removeDetachedWorktree } from "./worktree.mjs";

const blocked = (check, reasonCode) => ({ ...check, outcome: "blocked", reasonCode, exitCode: null, durationMs: 0, excerpt: "" });

export async function executeIsolated({ binding, expected, controllerRoot, worktreeParent, ids, git, makePath, available, spawn, knownValues, canary }) {
  const checks = getChecks(ids);
  try {
    assertExecutionBinding(binding, expected);
    const worktree = await createDetachedWorktree({ binding, controllerRoot, worktreeParent, git, makePath });
    let results;
    try {
      results = await Promise.all(checks.map((check) => runCheck(check, { cwd: worktree.path, available, spawn })));
    } finally {
      await removeDetachedWorktree({ controllerRoot, path: worktree.path, git });
    }
    const safe = results.map((result) => {
      const output = redactOutput(result.excerpt, { knownValues, canary });
      return output.safe ? { ...result, ...output } : blocked(result, output.reasonCode);
    });
    return Object.freeze({ checks: safe, aggregateOutcome: aggregateOutcome(safe) });
  } catch {
    const results = checks.map((check) => blocked(check, "isolation_or_cleanup_error"));
    return Object.freeze({ checks: results, aggregateOutcome: "blocked" });
  }
}
