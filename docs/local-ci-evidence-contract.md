# Local CI Evidence Contract (Advisory Only)

This slice defines the version 1 local-evidence data contract. It does **not** execute pull-request code, create worktrees, call GitHub, post comments, run Actions, or change a release control.

Every record binds the GitHub host, authenticated login, `owner/repository`, PR number, and exact lower-case 40-character head SHA. Evidence accepts only a private trusted-discovery capsule; caller-provided identity fields and caller-created lookalike objects cannot create evidence. The only current construction seam is guarded for `node:test` and unavailable to normal production processes. A later execution slice supplies the `gh`-backed production discovery boundary. The model exposes only `pass`, `fail`, and `blocked`; missing or unprovable information must be `blocked`, never `pass`.

Evidence is explicitly `source=local`, `advisory=true`, `githubActions=false`, and `receipt=false`. It does not satisfy required checks, change merge or release eligibility, or replace hosted provenance. DeployLite remains Alpha, and PR #85 / the Platform Release Baseline chain are outside this bridge.

`evidence.mjs` provides deterministic sorted-key serialization, SHA-256 hashing, bounded excerpts, basic secret/path redaction primitives, and rejects secret-bearing argv before it can be serialized or hashed. The schema enforces the discovery marker and rejects common secret-bearing argv shapes; the model applies the complete semantic guard, including known secret values. Later slices own isolated execution, stronger redaction fail-closure, and opt-in Issue-comment publication. To roll back this slice, remove only this schema, model, tests, and document; no gate, receipt, PR, account, or release state needs restoration.
