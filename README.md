# DeployLite

DeployLite is an open-source, community-oriented, self-hosted deployment control plane for small teams and independent builders. It is intentionally lightweight and AI-native: AI can inspect a redacted operational view, while infrastructure changes remain explicit and authorized.

## What is implemented on `main`

The following capabilities are available in the current `main` branch:

| Capability | Current boundary |
| --- | --- |
| VPS installation | HTTP-first installer and local runtime setup |
| Access control | First-owner setup, cookie sessions, and role-based access control (RBAC) |
| Project configuration | Create, edit, and delete project metadata |
| Environment values | Encrypted-value foundation and masked value handling |
| Control-plane views | Deployment and log metadata with Server-Sent Events (SSE) log inspection |
| Model Context Protocol (MCP) | Read-only server status, deployment, and log inspection |

The current deployment-control and agent surfaces are Alpha/early access, not a finished production deployment platform. Real Docker execution, privileged host mutation, and production hardening remain gated work. See the [platform support policy](docs/support-policy.md) and [release-evidence contract](docs/release-evidence.md) for the current release-baseline boundary.

## What is planned

DeployLite does not yet provide a real deployment executor, multi-service applications, Docker Compose or Swarm workloads, networks, volumes, backups, managed databases, service-level secrets, routing, certificates, registries, CI/CD, webhooks, observability, healthchecks, functional rollback, remote build servers, or MCP writes.

See the [community roadmap](docs/community-roadmap.md) for planned P0–P7 phases and their acceptance boundaries. Planned work is not a product commitment or an implemented capability.

## Work with the community

Read [how to contribute](CONTRIBUTING.md) before proposing code, documentation, or roadmap work. Report security concerns through [the security policy](SECURITY.md), not through public issues or logs.

## Architecture

DeployLite is a TypeScript monorepo with separate control-plane and agent boundaries:

- `apps/api`: Fastify control-plane API
- `apps/web`: Next.js web interface
- `apps/agent`: deployment-agent surface; real executor work remains gated
- `apps/mcp`: read-only MCP adapter
- `packages/config`: configuration, encryption, and redaction helpers
- `packages/contracts`: shared Zod contracts
- `packages/db`: PostgreSQL schema, migrations, and repositories
- `packages/domain`: domain ports and use-case types

## Validate changes

Run the workspace checks before submitting a change:

```bash
pnpm check
```

PostgreSQL integration checks are opt-in because they require a local database. See package scripts for the relevant commands.
