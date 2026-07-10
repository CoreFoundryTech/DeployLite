# DeployLite

**DeployLite is a lightweight, self-hosted deployment control plane built for small teams, solo builders, and AI-assisted development workflows.** It aims to make a clean VPS feel like a simple deployment target: install once, create an owner account, connect a project, manage environment values safely, and let an agent handle the deployment work.

DeployLite is intentionally smaller than a platform like Dokploy, Coolify, or a full Kubernetes stack. The goal is not to become another heavy platform. The goal is to provide a clear, hackable, AI-friendly deployment layer that is easy to inspect, easy to automate, and safe enough to run on a modest VPS.

## Why DeployLite?

- **Lightweight by default** — designed for one VPS, one Postgres database, and a small set of services.
- **AI-first operations** — includes read-only MCP tooling and API boundaries that are safe for agents to inspect before they act.
- **Self-hosted and transparent** — no hidden control plane; the code, migrations, installer, and runtime are in this repository.
- **Operator-safe secrets** — environment values are stored encrypted, shown as metadata/fingerprints, and never returned as plaintext.
- **Reviewable architecture** — TypeScript monorepo, shared contracts, explicit domain boundaries, and tests for every slice.

## Project status

DeployLite is under active build-out. The installer, owner setup, project configuration, encrypted environment value foundation, masked env UI, and audit/materialization work are in progress through small chained PRs.

| Area | Status |
|---|---|
| VPS installer | Implemented and tested for HTTP-first setup. |
| First-owner setup | Implemented with cookie sessions and RBAC. |
| Project configuration | Implemented for create/edit/delete and app metadata. |
| Encrypted env values | In progress on the `feat/env-secrets-ui` tracker branch. |
| Real deployment executor | Planned next; current deployment flow is still mock/control-plane oriented. |
| Domains, Traefik, ACME/HTTPS | Planned; not enabled by default yet. |
| MCP tools | Read-only status/deployment/log inspection. |

> **Important:** until the real deployment executor and VPS smoke phases are complete, treat DeployLite as an installable control-plane build, not a finished production deploy platform.

## Quick start on a VPS

For a clean Ubuntu/Debian VPS, the reviewed bootstrap path is:

```bash
curl -fsSL https://raw.githubusercontent.com/CoreFoundryTech/DeployLite/main/scripts/bootstrap.sh | sudo bash
```

For a stable public IP or hostname, pass it explicitly:

```bash
curl -fsSL https://raw.githubusercontent.com/CoreFoundryTech/DeployLite/main/scripts/bootstrap.sh | sudo DEPLOYLITE_PUBLIC_HOST=<ip-or-host> bash
```

After installation, open the printed URL and create the first owner account. There are no default admin credentials.

## AI-assisted workflow

DeployLite is designed so AI tools can help operate it without getting broad destructive power by default:

- MCP tools are read-only.
- Secret-like values pass through shared redaction helpers before leaving a boundary.
- Only the deployment agent mounts the Docker socket; API, Web, MCP, and PostgreSQL do not.
- Privileged agent changes are kept isolated, explicit, and reviewable.

This is the architectural point: **AI can inspect, summarize, and recommend first; privileged execution stays gated and explicit.**

## Current architecture

DeployLite is a private TypeScript monorepo today, structured so the repository can be opened later without leaking local AI/tooling artifacts.

- `apps/api` — Fastify control-plane API.
- `apps/web` — Next.js 15 App Router UI.
- `apps/agent` — privileged deployment agent and real runtime executor.
- `apps/mcp` — read-only MCP adapter.
- `packages/config` — environment parsing, redaction, crypto helpers.
- `packages/contracts` — shared Zod contracts.
- `packages/db` — PostgreSQL schema, migrations, repositories.
- `packages/domain` — domain ports and use-case types.

## Safety guardrails

- API, Web, MCP, and PostgreSQL do not mount the Docker socket.
- The agent intentionally mounts the Docker socket and therefore has host-root-equivalent privilege. A compromised agent must be treated as a compromised host.
- Separate control-plane/runtime networks and generated runtime restrictions reduce exposure; they do not sandbox a compromised socket-enabled agent.
- Repository images are built only through a per-command Buildx `docker-container` builder on a dedicated build network. DeployLite fixes CPU, memory, swap, PID, process-parallelism, build network, labels, builder name, and local image output; repository metadata cannot override them. The executor fails closed if post-creation inspection cannot prove those bounds, and it never falls back to `docker build`.
- Build steps run with `--network none`; BuildKit daemon traffic uses only the dedicated per-command bridge and never joins the DeployLite control-plane or runtime network. Bounded reconciliation removes late labelled resources and retains durable repair state when absence cannot be proven.
- These controls limit ordinary repository build resource exhaustion, but they do not remove Docker socket or BuildKit risk. The socket-enabled agent remains host-root-equivalent; the Docker-container driver may run its trusted BuildKit daemon with elevated container privileges; disk/cache pressure is not a complete quota boundary; and a daemon, BuildKit, or runtime vulnerability can escape the intended isolation. Repository input cannot request those privileges or change the trusted builder policy.
- Live activation requires an operational security review and least-privilege host controls.
- MCP tools are read-only and non-destructive: `deploylite_get_server_status`, `deploylite_list_deployments`, and `deploylite_get_deployment_logs`.
- Auth is an MVP cookie-session boundary for local administration. It is not a production hardening claim yet.
- Secret-like values must pass through shared redaction helpers before leaving a boundary.
- Traefik, ACME, and production auth claims remain gated until their dedicated phases land.

## Development checks

```bash
pnpm install
pnpm --filter @deploylite/db db:check
pnpm --filter @deploylite/web test
pnpm check
```

`pnpm check` runs build, lint/typecheck, and tests across the workspace. Integration checks that require a live PostgreSQL instance are opt-in so the default workflow stays deterministic.

## Scaffold chain

| Slice | Branch | Scope |
|---|---|---|
| PR1 | `feat/initial-platform-pr1-foundation-v2` | Workspace, shared config, contracts, domain ports, and baseline tests. |
| PR2 | `feat/initial-platform-pr2-api-control-plane` | Mock Fastify control-plane routes, request IDs, redaction, audit metadata, and SSE log streaming. |
| PR3 | `feat/initial-platform-pr3-web-agent-shell` | Static/mock web shell, server status/log views, mock agent heartbeat client, and local-only infra note. |
| PR4 | `feat/initial-platform-pr4-mcp-docs` | Read-only MCP adapter, cross-surface shape verification, and scaffold docs. |

## Scaffold history

- The deployment agent now intentionally mounts the Docker socket and has host-root-equivalent privilege; API, Web, MCP, and PostgreSQL remain socket-free.
- Auth is an MVP cookie-session boundary for local administration. It is not a production hardening claim.
- Secret-like values must pass through shared redaction helpers before leaving a boundary.
- Historical scaffold surfaces were mock-only; the current agent includes a real executor.
- MCP tools are read-only and non-destructive: `deploylite_get_server_status`, `deploylite_list_deployments`, and `deploylite_get_deployment_logs`.
- Traefik, ACME, production auth claims, and host shell execution outside the reviewed agent path are out of scope.

## VPS plug-and-play install

The installer is designed for a clean Ubuntu/Debian VPS and bootstraps DeployLite without manual Docker, Compose, Postgres, env, or migration setup. It installs/verifies Docker Engine and the Compose plugin when missing, creates `/opt/deploylite`, generates private secrets once, starts the Compose runtime, waits for health, and prints the browser URL for first-owner setup.

One-command bootstrap from the reviewed GitHub `main` branch:

```bash
curl -fsSL https://raw.githubusercontent.com/CoreFoundryTech/DeployLite/main/scripts/bootstrap.sh | sudo bash
```

For a stable public IP or hostname, pass it through the environment without printing secrets:

```bash
curl -fsSL https://raw.githubusercontent.com/CoreFoundryTech/DeployLite/main/scripts/bootstrap.sh | sudo DEPLOYLITE_PUBLIC_HOST=<ip-or-host> bash
```

Set `DEPLOYLITE_VERSION=<branch-tag-or-sha>` to bootstrap a specific GitHub ref. The bootstrapper downloads the source tarball, extracts it under a temporary directory, preserves `DEPLOYLITE_*` environment variables, runs `scripts/install.sh`, and removes temporary files on exit.

Reviewed local invocation from a checked-out release/source tree:

```bash
sudo DEPLOYLITE_PUBLIC_HOST=203.0.113.10 bash scripts/install.sh
```

Replace `203.0.113.10` with the public VPS IP or hostname. If omitted, the installer tries conservative IP detection and asks you to set `DEPLOYLITE_PUBLIC_HOST` when it cannot determine a stable address.

The GitHub bootstrap command downloads the requested repository ref, runs the reviewed installer from a temporary checkout, and cleans up the temporary files afterward.

Included:

- Production-oriented Dockerfiles for the API and Web apps.
- `infra/vps/compose.yml` with Postgres, one-shot migrations, API, Web, named volumes, separate stable control-plane/runtime networks bridged only by the agent, health checks, and restart policies.
- Temporary HTTP exposure: Web on host `:80` and API on host `:3001`.
- Browser-first initial owner creation through the existing setup UI. There are no default admin credentials.
- `scripts/bootstrap.sh`, a GitHub raw bootstrapper with mocked tests in `scripts/bootstrap.test.sh`.
- `scripts/install.sh`, a defensive Bash installer with mocked tests in `scripts/install.test.sh` and a tee-based file logger tested in `scripts/install-tee.test.sh`.

Deferred non-goals:

- Upgrades, uninstall/reset, backups, firewall mutation, Dokploy access, Traefik, ACME, domains, and HTTPS automation.

For local review without starting services, render the Compose configuration with the checked-in example env:

```bash
docker compose -f infra/vps/compose.yml --env-file infra/vps/.env.example config
```

The installer writes real runtime config to `/opt/deploylite/.env` with owner-only permissions and preserves it on reruns. Do not paste or commit that file. The HTTP-first slice deliberately sets `DEPLOYLITE_SESSION_COOKIE_SECURE=false` and requires `DEPLOYLITE_CORS_ORIGIN` to match the public Web origin. A later TLS/proxy slice must revisit both values.

### Install log, idempotency, and interactive mode

The installer tees every line of stdout and stderr through a redacting filter into `/var/log/deploylite/install.log` so post-mortem review does not require re-attaching to the terminal. The log is append-only, mode `0640` (or `0600` on filesystems that strip the group bit), and the redaction layer rewrites every line — including raw command stdout/stderr that never touched the `log()` helper, database URLs, password assignments, and secret tokens — before the bytes reach either the terminal or the file. Reruns append; the file is never truncated by the installer.

The installer also detects and repairs unsafe log file modes on every run. If a previous run left `/var/log/deploylite/install.log` with a world-readable or world-writable mode (for example `0666` from an older installer version), the current run downgrades it to `0640` when the user has permission, records the old and new mode in the log, and continues. A safe mode (`0600` or `0640`) is never changed.

Override the log path with `DEPLOYLITE_INSTALL_LOG=<path>` and the log directory with `DEPLOYLITE_INSTALL_LOG_DIR=<path>`. When the installer cannot create the configured directory it logs a warning and continues without a file log instead of failing.

Idempotency probes log a clear "already installed; preserving state" marker for each component the script detects:

- `/opt/deploylite/compose.yml` and `/opt/deploylite/.env` already present.
- Docker Engine and the Compose plugin already on `PATH`.
- Install log directory already present.

Pass `--interactive` (or `-i`) to enable confirmation prompts. The script tries a TUI dialog when one is available and falls back to plain `read` so the flag works on minimal VPS images and on piped automation. In interactive mode the installer prompts to confirm the public host (or override it) before writing `/opt/deploylite/.env`, so the first time the installer writes a secret value is always after the operator has confirmed the host the runtime will serve:

```bash
sudo DEPLOYLITE_PUBLIC_HOST=203.0.113.10 bash scripts/install.sh --interactive
```

Without `--interactive` the installer is non-interactive and safe to drive from `curl | bash`. Pass `--help` to print the full usage block.

## Auth/PostgreSQL chain

| Slice | Branch | Scope |
|---|---|---|
| PR1 | `feat/auth-postgres-pr1-db-schema` | PostgreSQL schema, hand-authored SQL migration, local DB tooling, and deterministic DB checks. |
| PR2 | `feat/auth-postgres-pr2-auth-primitives` | Auth/domain ports, repositories, bcrypt hashing, server-side session tokens, revocation, and redaction tests. |
| PR3 | `feat/auth-postgres-pr3-api-auth` | `/api/v1/auth/login`, `/api/v1/auth/me`, `/api/v1/auth/logout`, API session cookies, RBAC guards, and audit events. |
| PR4 | `feat/auth-postgres-pr4-web-docs` | Web auth boundary, local workflow docs, and final cross-surface checks. |
| PR5 | `feat/auth-postgres-pr5-db-integration-verify` | Corrective runtime PostgreSQL verification for migrations, RBAC constraints, env metadata constraints, and auth/session restart persistence. |
| PR6 | `feat/auth-postgres-pr6-db-metadata-verify` | Corrective runtime PostgreSQL verification for durable server/agent/project/deployment/log/domain/certificate/env metadata restart persistence. |

### Local onboarding smoke runbook

This runbook starts from an empty local PostgreSQL database and ends at the authenticated empty dashboard. It is local-only: it does not deploy, contact VPS/Dokploy, access a server Docker socket, or configure Traefik, ACME, DNS, or domains.

1. Start local PostgreSQL:

   ```bash
   docker compose -f infra/local/postgres.yml up -d
   ```

2. Export local API, auth, and database settings. Run these exports in every terminal that starts a local command, or source them from your shell profile or a temporary env file:

   ```bash
   export DATABASE_URL=postgres://deploylite:deploylite@localhost:55433/deploylite
   export DEPLOYLITE_SESSION_TTL_SECONDS=3600
   export DEPLOYLITE_SESSION_COOKIE_NAME=deploylite_session
   export DEPLOYLITE_SESSION_COOKIE_SECURE=false
   export DEPLOYLITE_BCRYPT_COST=10
   export DEPLOYLITE_WEB_API_BASE_URL=http://localhost:3001
   ```

   `DEPLOYLITE_BCRYPT_COST` must be between `10` and `14`; lower values fail configuration parsing. Do not use default credentials for durable local onboarding. The first admin is created from the UI with your own email and password while the user table is empty.

3. Apply and verify the schema:

   ```bash
   pnpm --filter @deploylite/db db:migrate
   pnpm --filter @deploylite/db db:check
   ```

   For opt-in runtime verification against local PostgreSQL, run the integration check. It creates and drops a disposable database on the configured server, applies migrations to that empty database, checks role seeds and database constraint rejection, verifies auth/session repository persistence across a new client lifecycle, and proves deployment metadata foundations survive a recreated DB client lifecycle:

   ```bash
   pnpm --filter @deploylite/db db:verify:integration
   ```

   This command requires PostgreSQL from `infra/local/postgres.yml` or a compatible `DATABASE_URL`. It is intentionally not part of `pnpm check`, so deterministic workspace checks do not require Docker.

4. Start the local API and web app in separate terminals:

   ```bash
   pnpm --filter @deploylite/api dev
   ```

   ```bash
   pnpm --filter @deploylite/web dev
   ```

   The API listens on `127.0.0.1:3001` by default. Override with `DEPLOYLITE_API_HOST` and `DEPLOYLITE_API_PORT` only for local development.

5. Complete the browser smoke at `http://localhost:3000`:

   - The setup screen should ask you to create the first local admin.
   - Create a custom admin email/password. The password must be at least 12 characters.
   - Sign in with that custom admin account.
   - Confirm the dashboard loads and shows empty local metadata states when no projects, agents, deployments, or logs exist.
   - Sign out, reload protected content, and confirm you return to the login/setup boundary.

6. Verify restart persistence without resetting PostgreSQL:

   - Stop and restart the API and web processes.
   - Open `http://localhost:3000` again.
   - Sign in with the same custom admin credentials.
   - Confirm no seeded/default account is required and the dashboard still loads.

Optional browser automation is intentionally deferred from the default workflow. If an opt-in smoke command is added later, it must stay outside `pnpm check` and CI unless separately approved.

To tear down the local PostgreSQL database and remove local data after verification:

```bash
docker compose -f infra/local/postgres.yml down -v
```

## Review checklist

- Shared contracts keep agent status, deployment records, log events, request IDs, and correlation IDs consistent across surfaces.
- SSE log resume uses monotonically ordered sequences and `Last-Event-ID`-style filtering.
- MCP outputs include structured content, request/correlation context, and redacted text content.
- Tests must not require real infrastructure or production credentials.

## Checks

```bash
pnpm install
pnpm --filter @deploylite/db db:check
pnpm --filter @deploylite/web test
pnpm check
```

`pnpm check` runs build, lint/typecheck, and tests across the workspace. The web build is expected to pass as a real Next.js build; web auth routes use dynamic rendering where request cookies are read.
