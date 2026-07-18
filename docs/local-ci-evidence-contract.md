# Local CI Evidence Contract (Advisory Only)

This slice defines the version 1 local-evidence data contract. It does **not** execute pull-request code, create worktrees, call GitHub, post comments, run Actions, or change a release control.

Every record binds the GitHub host, authenticated login, `owner/repository`, PR number, and exact lower-case 40-character head SHA. The model exposes only `pass`, `fail`, and `blocked`; missing or unprovable information must be `blocked`, never `pass`.

Evidence is explicitly `source=local`, `advisory=true`, `githubActions=false`, and `receipt=false`. It does not satisfy required checks, change merge or release eligibility, or replace hosted provenance. DeployLite remains Alpha, and PR #85 / the Platform Release Baseline chain are outside this bridge.

`evidence.mjs` provides deterministic sorted-key serialization, SHA-256 hashing, bounded excerpts, and basic secret/path redaction primitives. Later slices own isolated execution, stronger redaction fail-closure, and opt-in Issue-comment publication. To roll back this slice, remove only this schema, model, tests, and document; no gate, receipt, PR, account, or release state needs restoration.
