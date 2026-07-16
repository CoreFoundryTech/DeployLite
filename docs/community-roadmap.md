---
meta:
  title: How will DeployLite grow?
  contentType: Conceptual
  category: Community
---

# How will DeployLite grow?

DeployLite is an open-source, community-oriented, self-hosted deployment control plane. This roadmap separates the verified `main` baseline from planned work, so contributors can evaluate scope without treating a future phase as shipped behavior.

## Page plan

| Topic | Plan |
| --- | --- |
| Goal | Explain the public roadmap and each phase boundary |
| Audience | Contributors, operators, and prospective users |
| Content | Verified baseline, planned phases, and community expectations |
| Open questions | Priorities, maintainers, and phase proposals are decided in public project discussion |

## Start from the verified baseline

The `main` branch provides an HTTP-first VPS installer, first-owner setup, cookie sessions and RBAC, project metadata management, encrypted environment-value foundations with masked handling, control-plane deployment and log metadata, and a read-only MCP surface.

The existing deployment-control and agent surfaces are not a real production executor. Real Docker execution, privileged host mutation, routing, certificates, and production hardening are planned rather than implemented.

## Follow the planned phases

Each phase has an outcome and an acceptance boundary. A phase is not complete until its acceptance boundary is met.

| Phase | Planned outcome | Acceptance boundary |
| --- | --- | --- |
| P0 | Harden the shared command, capability, secret, and audit model | Every new mutation has actor, project scope, idempotency, audit evidence, and a terminal result; unsupported actions are rejected |
| P1 | Add a real, secure Git and Dockerfile deployment path plus a curated, versioned catalog | Repository and build inputs validate deterministically; templates reference secrets instead of embedding values; real execution has regression and safety coverage |
| P2 | Add multi-service projects through validated Docker Compose before Swarm | Compose inputs are parsed, canonicalized, policy-validated, dry-runable, and secret-safe; stack logs and replacement behavior have integration coverage |
| P3 | Add servers, registries, networks, volumes, domains, routing, certificates, TCP, and UDP | Server enrollment is scoped and expiring; registry credentials remain encrypted and redacted; routing is idempotent; ownership, renewal, and routing rollback have observable tests |
| P4 | Add stateful workloads and operations | Managed databases have isolated storage, generated credentials, backups, retention, restore confirmation, and restore evidence; telemetry never exposes secrets |
| P5 | Add CI/CD, webhooks, notifications, scheduling, observability, healthchecks, and tenant governance | Automation is idempotent and cancellable; integrations have delivery status; authorization tests deny cross-tenant access; events trace to a source command |
| P6 | Publish a versioned API and controlled MCP writes | API tokens are scoped and rotatable; MCP writes use the same command, audit, idempotency, authorization, and confirmation path as the web interface |
| P7 | Add audited AI assistance | AI receives allowlisted redacted context, links recommendations to evidence, and can only request a normal command preview; it cannot autonomously control infrastructure |

## Keep planned work honest

The roadmap includes real Git and Dockerfile execution, Docker Compose, Swarm, networks, volumes, backups, managed databases, service-level secrets, routing, certificates, TCP, UDP, catalog applications, registries, CI/CD, webhooks, observability, healthchecks, functional rollback, and remote build servers. None of these items is implemented unless the verified baseline says so.

DeployLite will not copy third-party code, templates, credentials, private endpoints, or deployment configuration into this project. References may inform a problem statement, but DeployLite defines and tests its own public behavior.

## Contribute within the safety boundary

Read [how to contribute](../CONTRIBUTING.md) before opening work. Read [the security policy](../SECURITY.md) before reporting a vulnerability.

Contributions must keep secrets encrypted at rest, redacted in every read path, and outside AI and MCP context. Infrastructure mutations must use a shared command boundary with authorization, audit evidence, idempotency, capability negotiation, and a visible terminal result.
