# DeployLite DB Foundation

This package owns the PostgreSQL schema and migration tooling for the auth/data foundation.

## Local development

```bash
docker compose -f infra/local/postgres.yml up -d
export DATABASE_URL=postgres://deploylite:deploylite@localhost:55433/deploylite
pnpm --filter @deploylite/db db:migrate
pnpm --filter @deploylite/db db:check
pnpm --filter @deploylite/db test
```

The local compose file starts PostgreSQL only on host port `55433` to avoid common conflicts with an existing local PostgreSQL on `5432`. It does not touch VPS, Docker socket, Traefik, ACME, or deployment infrastructure.

`db:check` is a deterministic offline check for this package's hand-authored SQL migration workflow. It validates that migration files exist, canonical RBAC roles are present and DB-enforced, env variable storage remains metadata-only, required foundation tables/indexes exist, and TypeScript schema exports compile.

For opt-in runtime PostgreSQL verification, run:

```bash
pnpm --filter @deploylite/db db:verify:integration
```

The integration check creates and drops a disposable database on the configured local server, applies migrations to an empty database, verifies canonical role and constraint behavior, and proves auth/session plus deployment metadata rows survive closing and recreating the PostgreSQL client lifecycle. It is intentionally outside `pnpm check` so normal workspace checks stay Docker-free.

## Secret storage boundary

`env_variable_metadata` stores metadata only. It intentionally has no plaintext `value`, `secret`, or `encrypted_value` column. Until encryption and key management are designed, application code must reject submitted secret values and persist only inert metadata.
