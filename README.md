# DeployLite

Initial scaffold for DeployLite, a self-hosted deployment platform. This chain establishes TypeScript workspace boundaries, shared contracts, domain foundations, mock API/web/agent surfaces, and read-only MCP tools only.

The current auth foundation is intentionally narrow: API sessions are opaque HttpOnly cookies with canonical roles, while deployment infrastructure remains mock-only and non-mutating.

## Scaffold chain

| Slice | Branch | Scope |
|---|---|---|
| PR1 | `feat/initial-platform-pr1-foundation-v2` | Workspace, shared config, contracts, domain ports, and baseline tests. |
| PR2 | `feat/initial-platform-pr2-api-control-plane` | Mock Fastify control-plane routes, request IDs, redaction, audit metadata, and SSE log streaming. |
| PR3 | `feat/initial-platform-pr3-web-agent-shell` | Static/mock web shell, server status/log views, mock agent heartbeat client, and local-only infra note. |
| PR4 | `feat/initial-platform-pr4-mcp-docs` | Read-only MCP adapter, cross-surface shape verification, and scaffold docs. |

## Safety guardrails

- No Docker socket access or host mutation exists in this scaffold.
- Auth is an MVP cookie-session boundary for local administration. It is not a production hardening claim.
- Secret-like values must pass through shared redaction helpers before leaving a boundary.
- API, web, agent, and MCP surfaces are mock-only in this scaffold.
- MCP tools are read-only and non-destructive: `deploylite_get_server_status`, `deploylite_list_deployments`, and `deploylite_get_deployment_logs`.
- Traefik, ACME, production auth claims, real secret storage, and host shell execution are out of scope.

## Auth/PostgreSQL chain

| Slice | Branch | Scope |
|---|---|---|
| PR1 | `feat/auth-postgres-pr1-db-schema` | PostgreSQL schema, hand-authored SQL migration, local DB tooling, and deterministic DB checks. |
| PR2 | `feat/auth-postgres-pr2-auth-primitives` | Auth/domain ports, repositories, bcrypt hashing, server-side session tokens, revocation, and redaction tests. |
| PR3 | `feat/auth-postgres-pr3-api-auth` | `/api/v1/auth/login`, `/api/v1/auth/me`, `/api/v1/auth/logout`, API session cookies, RBAC guards, and audit events. |
| PR4 | `feat/auth-postgres-pr4-web-docs` | Web auth boundary, local workflow docs, and final cross-surface checks. |

### Local DB/auth quick path

1. Start local PostgreSQL only:

   ```bash
   docker compose -f infra/local/postgres.yml up -d
   ```

2. Export local auth/database settings:

   ```bash
   export DATABASE_URL=postgres://deploylite:deploylite@localhost:55433/deploylite
   export DEPLOYLITE_SESSION_TTL_SECONDS=3600
   export DEPLOYLITE_SESSION_COOKIE_NAME=deploylite_session
   export DEPLOYLITE_SESSION_COOKIE_SECURE=false
   export DEPLOYLITE_BCRYPT_COST=4
   export DEPLOYLITE_WEB_API_BASE_URL=http://localhost:3001
   ```

3. Apply and verify the schema:

   ```bash
   pnpm --filter @deploylite/db db:migrate
   pnpm --filter @deploylite/db db:check
   ```

   For opt-in runtime verification against local PostgreSQL, run the integration check. It creates and drops a disposable database on the configured server, applies migrations to that empty database, checks role seeds and database constraint rejection, and verifies auth/session repository persistence across a new client lifecycle:

   ```bash
   pnpm --filter @deploylite/db db:verify:integration
   ```

   This command requires PostgreSQL from `infra/local/postgres.yml` or a compatible `DATABASE_URL`. It is intentionally not part of `pnpm check`, so deterministic workspace checks do not require Docker.

4. Build and run the local web shell:

   ```bash
   pnpm --filter @deploylite/api build
   pnpm --filter @deploylite/web dev
   ```

The seeded in-memory API admin for local scaffold checks is `admin@example.test` with password `deploylite-admin-password`. Durable first-admin bootstrap remains bounded to the repository/auth foundation and must not be treated as production onboarding.

To reset the local database, stop PostgreSQL with volumes removed and repeat the migration step:

```bash
docker compose -f infra/local/postgres.yml down -v
docker compose -f infra/local/postgres.yml up -d
pnpm --filter @deploylite/db db:migrate
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
