# DeployLite Infrastructure

This directory contains local-development infrastructure and the first reviewable VPS runtime contract used by `scripts/bootstrap.sh` and `scripts/install.sh`.

- No production Traefik, ACME, DNS, or certificate mutation is performed here.
- No Docker socket path or host shell command is required by these templates.
- Future infrastructure changes must stay behind explicit review and real environment configuration.

## Local PostgreSQL

`infra/local/postgres.yml` is the deterministic local PostgreSQL fixture used by the onboarding runbook and opt-in DB integration checks.

## VPS installer contract

The installer installs Docker prerequisites and copies `compose.yml` plus `compose.tls.yml`; it does not start DeployLite or ask for a domain or ACME email.

- `postgres` uses `postgres:16-alpine` with a durable named volume.
- `migrate` runs the existing hand-authored SQL migrations once before the API starts.
- Traefik is the sole host listener on ports `80` and `443`; API and web have no host ports.
- The `runtime` profile is TLS-only: HTTP redirects to HTTPS and ACME state persists in `traefik-acme`.
- API CORS and the web API URLs derive from `https://${DEPLOYLITE_PUBLIC_HOST}`.
- Health checks gate API/Web startup where Compose supports dependency conditions.

For local review, render the installer-safe base and Traefik overlay without starting services or enabling the runtime profile:

```bash
docker compose -f infra/vps/compose.yml -f infra/vps/compose.tls.yml config --no-interpolate
```

Functional domain, ACME email, and runtime secrets (including `POSTGRES_PASSWORD`) are web-owned configuration. The installer intentionally does not generate, request, or persist them, and it never enables the `runtime` profile. Configure those values through the web-owned configuration flow before enabling runtime later; `.env.example` is render-only and invalid for public use.

## VPS installer runbook

Bootstrap from an audited immutable GitHub commit SHA on a clean supported VPS:

```bash
curl -fsSL https://raw.githubusercontent.com/CoreFoundryTech/DeployLite/<sha>/scripts/bootstrap.sh | sudo DEPLOYLITE_VERSION=<40-char-sha> bash
```

Skip the default prerequisite confirmation TUI only for automation:

```bash
curl -fsSL https://raw.githubusercontent.com/CoreFoundryTech/DeployLite/<sha>/scripts/bootstrap.sh | sudo DEPLOYLITE_VERSION=<40-char-sha> bash -s -- --non-interactive
```

`DEPLOYLITE_VERSION` must be a 40-character commit SHA. The bootstrapper uses bounded downloads, a private temporary directory, and validates that the extracted tree contains the installer.

Alternatively, run from a reviewed source checkout:

```bash
sudo bash scripts/install.sh
```

The installer supports Ubuntu 20.04/22.04/24.04 and Debian 11/12 on x86_64 or arm64. It requires root or sudo, verifies ports `80` and `443`, installs/verifies Docker Engine and the Compose plugin through `apt`, copies both Compose files, and validates their merged base/Traefik configuration without the runtime profile. It does not start application services.

This contract does not configure a public domain, ACME identity, firewall, backups, upgrades, uninstall/reset, Dokploy, or a deployment agent/server Docker socket.
