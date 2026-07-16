---
meta:
  title: How do I report a DeployLite security issue?
  contentType: How-to
  category: Security
---

# How do I report a DeployLite security issue?

Report vulnerabilities privately. Do not post exploit steps, credentials, private endpoints, deployment logs, certificate material, database dumps, or secret values in public issues, pull requests, discussions, or chat.

## Report through a private channel

Use the repository's private security advisory workflow when it is available. If it is unavailable, contact a repository maintainer through an existing private channel before publishing details.

Include the affected revision, a minimal reproduction, expected and observed behavior, impact, and any mitigation used. Replace secret values with descriptions before sharing evidence.

## Respect the deployment boundary

Do not test against infrastructure you do not own or control. Do not access Docker sockets, build servers, registries, backups, databases, certificates, or deployment agents without explicit authorization.

## What maintainers will evaluate

Reports receive priority when they involve authorization, secret encryption or redaction, audit integrity, repository-origin validation, event-stream data exposure, privileged-agent access, or cross-project access.

The current deployment boundary and roadmap are documented in the [README](README.md) and [community roadmap](docs/community-roadmap.md).
