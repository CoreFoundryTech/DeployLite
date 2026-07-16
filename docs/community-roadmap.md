---
meta:
  title: How will DeployLite grow?
  contentType: Conceptual
  category: Community
---

# How will DeployLite grow?

DeployLite is an open-source, community-oriented, self-hosted deployment control plane. This roadmap separates verified capabilities from planned work, so contributors can evaluate scope without treating future phases as shipped features.

## Page plan

| Topic | Plan |
| --- | --- |
| Goal | Explain the public roadmap and each phase boundary |
| Audience | Contributors, operators, and prospective users |
| Content | Verified baseline, planned phases, and community expectations |
| Open questions | Priorities, maintainers, and phase proposals are decided in public project discussion |

## Start from the verified baseline

DeployLite currently supports a secure Git, Dockerfile, and BuildKit path for one container. It also has encrypted project and deployment secrets, fenced agent lifecycle commands and recovery, redacted Server-Sent Events (SSE) logs, role-based access control (RBAC), audit events, basic domain and certificate metadata, a read-only Model Context Protocol (MCP) surface, and lifecycle API controls.

Cancel is functional. Restart and rollback are unavailable until the agent advertises the required capability. Domain and certificate records do not yet configure routing, certificate issuance, or renewal.

## Follow the planned phases

Each phase has an outcome and a boundary. A phase is not complete until its acceptance boundary is met.

| Phase | Planned outcome | Acceptance boundary |
| --- | --- | --- |
| P0 | Harden the shared command, capability, secret, and audit model | Every new mutation has actor, project scope, idempotency, audit evidence, and a terminal result; unsupported actions are rejected |
| P1 | Add an application model and curated, versioned one-click catalog | Catalog inputs validate deterministically; templates reference secrets instead of embedding values; the existing Git and Dockerfile path keeps passing regression tests |
| P2 | Add multi-service projects through validated Docker Compose before Swarm | Compose inputs are parsed, canonicalized, policy-validated, dry-runable, and secret-safe; stack logs and replacement behavior have integration coverage |
| P3 | Add servers, registries, networks, volumes, domains, Traefik, ACME, TLS, TCP, and UDP | Server enrollment is scoped and expiring; registry credentials remain encrypted and redacted; routing is idempotent; ownership, renewal, and routing rollback have observable tests |
| P4 | Add stateful workloads and operations | Managed databases have isolated storage, generated credentials, backups, retention, restore confirmation, and restore evidence; telemetry never exposes secrets |
| P5 | Add CI/CD, webhooks, notifications, scheduling, observability, healthchecks, and tenant governance | Automation is idempotent and cancellable; integrations have delivery status; authorization tests deny cross-tenant access; events trace to a source command |
| P6 | Publish a versioned API and controlled MCP writes | API tokens are scoped and rotatable; MCP writes use the same command, audit, idempotency, authorization, and confirmation path as the web interface |
| P7 | Add audited AI assistance | AI receives allowlisted redacted context, links recommendations to evidence, and can only request a normal command preview; it cannot autonomously control infrastructure |

## Keep planned work honest

The roadmap includes Docker, Docker Compose, Swarm, networks, volumes and backups, managed databases, service-level secrets, Traefik, ACME, TLS, TCP, UDP, catalog applications, Git and registry integrations, CI/CD, webhooks, observability, healthchecks, functional rollback, and remote or build servers. None of these items is implemented unless the verified baseline says so.

DeployLite will not copy third-party code, templates, credentials, private endpoints, or deployment configuration into this project. References may inform a problem statement, but DeployLite defines and tests its own public behavior.

## Contribute within the safety boundary

Read [how to contribute](../CONTRIBUTING.md) before opening work. Read [the security policy](../SECURITY.md) before reporting a vulnerability.

Contributions must keep secrets encrypted at rest, redacted in every read path, and outside AI and MCP context. Infrastructure mutations must use the shared command boundary with authorization, audit evidence, idempotency, capability negotiation, and a visible terminal result.
