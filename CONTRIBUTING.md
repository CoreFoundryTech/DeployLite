---
meta:
  title: How do I contribute to DeployLite?
  contentType: How-to
  category: Community
---

# How do I contribute to DeployLite?

DeployLite welcomes code, documentation, testing, design, and roadmap contributions. Start with a focused change that preserves the implemented-versus-planned distinction in the [README](README.md) and [community roadmap](docs/community-roadmap.md).

## Choose a reviewable contribution

Keep one contribution focused on one outcome:

- Fix a verified behavior with a regression test.
- Document existing behavior with repository evidence.
- Propose a roadmap phase or acceptance boundary without claiming it is implemented.
- Add a constrained implementation slice with clear authorization, audit, and rollback boundaries.

Do not include credentials, private endpoints, production logs, deployment output, or copied third-party templates or code.

## Preserve the safety boundary

Treat privileged execution as a security boundary. A proposed infrastructure mutation must define project scope, authorization, idempotency, audit evidence, capability negotiation, progress reporting, and a terminal result before it becomes part of the product.

Keep secret values encrypted at rest and redact secret-like values from APIs, logs, event streams, MCP output, test fixtures, and AI context. Do not add an autonomous AI or MCP mutation path.

## Validate your change

Run the deterministic workspace check before submitting work:

```bash
pnpm check
```

Run the smallest relevant test command while developing. Document a check that cannot run locally, including the missing dependency and expected command. Do not weaken a check to make it pass.

## Write a useful contribution summary

State the user outcome, files changed, tests run, and known limits. Mark planned behavior as planned. Link only to repository files and documentation that exist.

## Report security issues privately

Follow [the security policy](SECURITY.md) for vulnerabilities, secret exposure, privilege-boundary concerns, or unsafe deployment behavior.
