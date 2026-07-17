# DeployLite Infrastructure

This directory contains local-development infrastructure and the first reviewable VPS runtime contract used by `scripts/bootstrap.sh` and `scripts/install.sh`.

- No production Traefik, ACME, DNS, or certificate mutation is performed here.
- No Docker socket path or host shell command is required by these templates.
- Future infrastructure changes must stay behind explicit review and real environment configuration.

## Local PostgreSQL

`infra/local/postgres.yml` is the deterministic local PostgreSQL fixture used by the onboarding runbook and opt-in DB integration checks.

## VPS runtime preview

`infra/vps/compose.yml` defines the prerequisite and runtime configuration used by the installer:

- `postgres`, `migrate`, `api`, and `web` are in the explicit `runtime` Compose profile; the base file alone does not start the public application.
- `postgres` uses `postgres:16-alpine` with a durable named volume when the runtime profile is enabled.
- `migrate` runs the existing hand-authored SQL migrations once before the API starts.
- `traefik` is the only published service (`:80` and `:443`); API and Web remain on the internal network.
- `api` is routed at `Host(deploylite.com) && PathPrefix(/api)`.
- `web` is routed at `Host(deploylite.com)`.
- `traefik-acme` is a persistent named volume reserved for ACME state.
- Health checks gate API/Web startup where Compose supports dependency conditions.

For local review, render the configuration without starting services:

```bash
docker compose -f infra/vps/compose.yml --env-file infra/vps/.env.example config
```

During installation, `scripts/install.sh` copies this Compose file to `/opt/deploylite/compose.yml`, writes `/opt/deploylite/.env` with mode `0600`, generates missing secrets once, and preserves existing values on reruns. Do not commit or paste the runtime `.env` file.

## VPS installer runbook

Bootstrap requires an immutable, reviewed 40-character Git commit SHA. It intentionally rejects mutable branches and tags and makes no signed-release provenance claim:

```bash
curl -fsSL https://raw.githubusercontent.com/CoreFoundryTech/DeployLite/<commit-sha>/scripts/bootstrap.sh | sudo DEPLOYLITE_VERSION=<commit-sha> bash
```

Set the same `DEPLOYLITE_VERSION=<40-character-commit-sha>` used in the bootstrap URL. The bootstrapper downloads that GitHub tarball, extracts it under a temporary directory, preserves `DEPLOYLITE_*` environment variables when invoking the installer, and cleans temporary files on exit. It does not print secret values.

Alternatively, run from a reviewed source checkout:

```bash
sudo bash scripts/install.sh
```

The installer defaults to an interactive prerequisite-only TUI; use `--noninteractive` for automation. It supports Ubuntu 20.04/22.04/24.04 and Debian 11/12 on x86_64 or arm64, verifies ports `80` and `443`, installs/verifies Docker Engine and the Compose plugin through `apt` with bounded timeouts, creates private runtime secrets once, and renders the deployment definition. It does not start application services or request a domain, application settings, or ACME email.

Functional configuration is web-owned. `DEPLOYLITE_DOMAIN` defaults to `deploylite.com` in Compose so the runtime has a deterministic route without an installer prompt. The current blocker for TLS is a web-owned `DEPLOYLITE_ACME_EMAIL` setting and DNS for that domain. The base file is prerequisite-only: it must not be used to start the application runtime. Authentication cookies are always marked `Secure`, so an HTTP-only deployment cannot establish an authenticated session.

On failure, the installer reports changed steps with secret redaction, stops newly started containers where safe, and preserves `/opt/deploylite/.env` plus named volumes.

### TLS activation

Once the web-owned settings provide `DEPLOYLITE_DOMAIN`, `DEPLOYLITE_ACME_EMAIL`, and working public DNS, start with both files and the explicit runtime profile: `docker compose --profile runtime -f compose.yml -f compose.tls.yml --env-file .env up -d`. The TLS overlay configures Traefik's Let's Encrypt HTTP-01 ACME resolver and persistent `/acme/acme.json` storage. It is deliberately not enabled by bootstrap because no installer prompt may collect business configuration. Session cookies are always `Secure`.

This boundary does not configure firewall rules, backups, upgrades, uninstall/reset, Dokploy, or a deployment agent/server Docker socket. The first owner/admin is still created only in the browser while the user table is empty; no default admin is seeded or documented.
