# Release evidence contract

Use this record for a fixed commit only. A complete record is necessary evidence for later gates, not a declaration that DeployLite is ready for production or public use. DeployLite remains **Alpha/early access** until the aggregate gate and separate release decision pass.

## Required record

Create `release-evidence.json` from `schemas/release-evidence.schema.json`. The record must contain:

| Field | Evidence required |
| --- | --- |
| `commit` | Immutable commit SHA under review. |
| `alphaPosture` | Exactly `alpha-early-access`. |
| `runtime` and `inputs` | Node/pnpm versions, lock hash, Compose inputs, and relevant image digests. |
| `images` | Image tag, immutable digest, platform, and build identity when available. |
| `checks` | Command, timestamp, result (`pass`, `fail`, or `exception`), and retained output location for every applicable gate. |
| `exceptions` | ID, component, owner, rationale, compensating control, reviewer, evidence link, and unexpired UTC expiry. |
| `smoke` | Non-production target/result only when the staging slice exists; otherwise record it as pending. |
| `review` | Reviewer and approval location for the current slice. |
| `artifacts` | Retained report, SBOM, scan, or command-output locations. |

## Upgrade and rollback evidence

For every supported-component update, include before/after versions and digests, vendor lifecycle source, compatibility result, pre-upgrade checks, approval, validation result, rollback trigger, rollback steps, and rollback result. Missing evidence, a failing check, or an expired exception blocks release eligibility.

## Current boundary

The policy/evidence slice documents controls only. CI/security gates, automation, VPS smoke, backups, production deployment, and aggregate release approval are intentionally pending.
