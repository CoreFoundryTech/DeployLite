# Local CI Evidence Bridge

Run `pnpm ci:local:evidence -- --pr <number>` to evaluate catalogued checks in a detached local worktree. It reads the active `gh` account and current repository, then binds account, repository, PR, and remote head SHA before execution, evidence emission, and publication.

Use `--dry-run` to prove discovery and the intended comment action without executing checks, writing evidence, or posting. `--post --confirm-post` is the only write path. It rechecks identity and SHA immediately before using only the GitHub Issue-comment API, then creates or updates the current account's single SHA marker comment. It never calls status, check-run, workflow, review, release, merge, deployment, receipt, ownership, or account APIs.

Evidence is local advisory evidence, not GitHub Actions, a required check, a merge/release gate, a receipt, or hosted provenance. Required checks remain unsatisfied, release eligibility is unchanged, PR #85 stays blocked, and DeployLite remains Alpha. Keep `artifacts/advisory/` local, retain it only for the operator's review window, then delete it and its disposable worktree on rollback. Never supply secrets: child checks receive a sanitized environment and evidence redacts known secret-shaped values and paths. No paid Actions, VPS, card, deployment, DNS, or external PR code execution is introduced.
