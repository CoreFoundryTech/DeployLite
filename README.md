# What can DeployLite do today?

DeployLite is an open-source, community-oriented, self-hosted deployment control plane for small teams and independent builders. It is lightweight and AI-native: AI can inspect a redacted operational view today, while infrastructure changes remain explicit, authorized commands.

## Use the verified deployment path

DeployLite currently supports one reviewed deployment path:

- An approved HTTPS Git repository
- A Dockerfile build through a bounded BuildKit builder
- One container per deployment

The agent validates repository origins, rejects unsafe Dockerfile inputs, constrains the build environment, and fails closed when it cannot verify the configured bounds. This does not make a socket-enabled agent safe to trust as an unprivileged process. Treat that agent as host-root-equivalent.

## Know what is implemented today

The following capabilities are verified in this repository:

| Capability | Current boundary |
| --- | --- |
| Git, Dockerfile, and BuildKit deployments | Secure single-container path only |
| Project and deployment secrets | Encrypted at rest and redacted from read paths |
| Deployment lifecycle | Fenced agent commands, recovery handling, and terminal states |
| Logs | Redacted logs with Server-Sent Events (SSE) streaming and resume support |
| Access control | Role-based access control (RBAC) and audit events |
| Domains and certificates | Metadata records only, without routing or certificate issuance |
| Model Context Protocol (MCP) | Read-only server status, deployment, and log inspection |
| Lifecycle API and SSE | Cancel works; restart and rollback remain unavailable until an agent advertises those capabilities |

## Read the roadmap before depending on a feature

DeployLite does not yet provide multi-service applications, Docker Compose, Swarm, networks, volumes, backups, managed databases, service-level secrets, Traefik, ACME, Transport Layer Security (TLS), TCP, User Datagram Protocol (UDP), a one-click catalog, registries, continuous integration and delivery (CI/CD), webhooks, observability, healthchecks, functional rollback, or remote build servers.

See the [community roadmap](docs/community-roadmap.md) for the planned P0 to P7 phases and acceptance boundaries. Planned items are not product commitments or implemented capabilities.

## Work with the community

Read [how to contribute](CONTRIBUTING.md) before proposing code, documentation, or roadmap work. Report security concerns through the process in [the security policy](SECURITY.md), not in public issues or logs.

## Understand the architecture

DeployLite is a TypeScript monorepo with separate control-plane and privileged-agent boundaries:

- `apps/api`: Fastify control-plane API
- `apps/web`: Next.js web interface
- `apps/agent`: privileged deployment agent
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

PostgreSQL integration checks are opt-in because they require a local database. See the package scripts for those commands.
