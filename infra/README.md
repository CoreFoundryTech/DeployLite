# DeployLite Infrastructure

This directory contains local-development infrastructure and the first reviewable VPS runtime contract used by `scripts/bootstrap.sh` and `scripts/install.sh`.

- No production Traefik, ACME, DNS, or certificate mutation is performed here.
- The deployment agent intentionally mounts the Docker socket; API, Web, MCP, and PostgreSQL do not.
- Future infrastructure changes must stay behind explicit review and real environment configuration.

## Local PostgreSQL

`infra/local/postgres.yml` is the deterministic local PostgreSQL fixture used by the onboarding runbook and opt-in DB integration checks.

## VPS runtime preview

`infra/vps/compose.yml` defines the runtime slice used by the plug-and-play installer:

- `postgres` uses `postgres:16-alpine` with a durable named volume.
- `migrate` runs the existing hand-authored SQL migrations once before the API starts.
- `api` builds `apps/api/Dockerfile`, binds internally to `0.0.0.0:3001`, and is temporarily exposed on host `:3001`.
- `web` builds `apps/web/Dockerfile`, serves Next.js on container `:3000`, and is temporarily exposed on host `:80`.
- `deploylite-control-plane` connects PostgreSQL, migrations, API, Web, and the agent. `deploylite-runtime` connects only the agent and dynamically launched project runtimes, so untrusted runtime containers cannot resolve control-plane services through Compose network membership.
- The agent is the only service on both networks and the only service with the Docker socket mount.
- Docker socket access gives the agent host-root-equivalent privilege. The network split and generated runtime policy reduce exposure but do not sandbox a compromised agent.
- Live activation requires an operational security review and least-privilege host controls.
- Health checks gate API/Web startup where Compose supports dependency conditions.

For local review, render the configuration without starting services:

```bash
docker compose -f infra/vps/compose.yml --env-file infra/vps/.env.example config
```

During installation, `scripts/install.sh` copies this Compose file to `/opt/deploylite/compose.yml`, writes `/opt/deploylite/.env` with mode `0600`, generates missing secrets once, and preserves existing values on reruns. Do not commit or paste the runtime `.env` file.

## VPS installer runbook

Bootstrap from the reviewed GitHub `main` branch on a clean supported VPS:

```bash
curl -fsSL https://raw.githubusercontent.com/CoreFoundryTech/DeployLite/main/scripts/bootstrap.sh | sudo bash
```

For a stable public IP or hostname, pass it through the environment:

```bash
curl -fsSL https://raw.githubusercontent.com/CoreFoundryTech/DeployLite/main/scripts/bootstrap.sh | sudo DEPLOYLITE_PUBLIC_HOST=<ip-or-host> bash
```

Set `DEPLOYLITE_VERSION=<branch-tag-or-sha>` to download a specific GitHub ref. The bootstrapper downloads a GitHub tarball, extracts it under a temporary directory, preserves `DEPLOYLITE_*` environment variables when invoking the installer, and cleans temporary files on exit. It does not print secret values.

Alternatively, run from a reviewed source checkout:

```bash
sudo DEPLOYLITE_PUBLIC_HOST=203.0.113.10 bash scripts/install.sh
```

The installer supports Ubuntu 20.04/22.04/24.04 and Debian 11/12 on x86_64 or arm64. It requires root or sudo, verifies ports `80` and `3001`, installs/verifies Docker Engine and the Compose plugin through `apt` when missing, starts Postgres/migrations/API/Web through Compose, waits for API/Web health, and prints the final HTTP URL.

After completion, open the printed `http://<host>/` URL and create the first owner account in the browser. No default admin user or password is created.

On failure, the installer reports changed steps with secret redaction, stops newly started containers where safe, and preserves `/opt/deploylite/.env` plus named volumes.

### HTTP-first limits

This slice intentionally uses plain HTTP for reviewability: Web `:80`, API `:3001`, `DEPLOYLITE_SESSION_COOKIE_SECURE=false`, and credentialed CORS only for `DEPLOYLITE_CORS_ORIGIN`. It does not configure Traefik, ACME, domains, HTTPS, firewall rules, backups, upgrades, uninstall/reset, or Dokploy. The first owner/admin is still created only in the browser while the user table is empty; no default admin is seeded or documented.
