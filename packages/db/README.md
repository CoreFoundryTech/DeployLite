# DeployLite DB Foundation

This package owns the PostgreSQL schema and migration tooling for the auth/data foundation.

## Local development

```bash
docker compose -f infra/local/postgres.yml up -d
export DATABASE_URL=postgres://deploylite:deploylite@localhost:55433/deploylite
pnpm --filter @deploylite/db db:migrate
pnpm --filter @deploylite/db test
```

The local compose file starts PostgreSQL only on host port `55433` to avoid common conflicts with an existing local PostgreSQL on `5432`. It does not touch VPS, Docker socket, Traefik, ACME, or deployment infrastructure.

## Secret storage boundary

`env_variable_metadata` stores metadata only. It intentionally has no plaintext `value`, `secret`, or `encrypted_value` column. Until encryption and key management are designed, application code must reject submitted secret values and persist only inert metadata.
