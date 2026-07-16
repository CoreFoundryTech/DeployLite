---
meta:
  title: How do I contribute to DeployLite?
  contentType: How-to
  category: Community
---

# How do I contribute to DeployLite?

DeployLite welcomes code, documentation, testing, design, and roadmap contributions. Start with a focused change that preserves the implemented and planned distinction in the [README](README.md) and [community roadmap](docs/community-roadmap.md).

## Choose a reviewable contribution

Keep one contribution focused on one outcome:

- Fix a verified behavior with a regression test
- Document an existing behavior with repository evidence
- Propose a roadmap phase or acceptance boundary without claiming it is implemented
- Add a constrained implementation slice that fits the shared command and audit model

Do not include credentials, private endpoints, production logs, deployment output, or copied third-party templates and code.

## Preserve the safety boundary

Treat privileged execution as a security boundary. New infrastructure mutations must include project scope, authorization, idempotency, audit evidence, capability negotiation, progress reporting, and a terminal result.

Keep secret values encrypted at rest. Redact secret-like values from APIs, logs, event streams, MCP output, test fixtures, and AI context. Do not add an autonomous AI or MCP mutation path.

## Validate your change

Run the deterministic workspace check before you submit work:

```bash
pnpm check
```

Run a smaller relevant test command while developing. Document any check that cannot run locally, including the missing dependency and the expected command. Do not weaken a check to make it pass.

## Write a useful contribution summary

State the user outcome, files changed, tests run, and known limits. Mark planned behavior as planned. Link only to files and documentation that exist in the repository.

## Report security issues privately

Follow [the security policy](SECURITY.md) for vulnerabilities, secret exposure, privilege-boundary concerns, or unsafe deployment behavior.
