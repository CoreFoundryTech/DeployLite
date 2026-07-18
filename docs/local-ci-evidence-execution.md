# Local CI Evidence: Execution and Redaction

This Phase 2 component is local, advisory, and Alpha-only. It is **not** GitHub Actions, a required check, a merge or release gate, hosted provenance, or a receipt. Required checks remain unsatisfied and release eligibility does not change. It does not use paid Actions, VPSs, cards, deployments, or PR #85–#90 baseline changes.

## Execution boundary

The controller accepts only static catalog IDs. Each resolves to fixed argv and runs with `shell: false`, a timeout, a disposable detached worktree at the exact SHA, and an environment limited to `PATH`, `CI`, `HOME=/nonexistent`, and `NO_COLOR`. No `GH_TOKEN`, application secret, or repository environment is inherited. Missing capabilities, timeout, execution error, worktree/SHA mismatch, and cleanup failure are `blocked`; none may be reported as `pass`.

## Output boundary and rollback

Before a check result can be returned for later evidence persistence, output is bounded and redacted for secret key/value pairs, common credentials, known values, absolute paths, and a canary. Any residue removes the excerpt and blocks the result. Raw output is never persisted. Roll back this slice by reverting only `scripts/ci/local-evidence/{catalog,worktree,process,redact,execute}.mjs` and their tests plus this document; remove any disposable local worktree with `git worktree remove --force <path>`.
