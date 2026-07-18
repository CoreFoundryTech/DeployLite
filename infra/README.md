# DeployLite Infrastructure

This directory contains local-development infrastructure and the first reviewable VPS runtime contract used by `scripts/bootstrap.sh` and `scripts/install.sh`.

- No production Traefik, ACME, DNS, or certificate mutation is performed here.
- No Docker socket path or host shell command is required by these templates.
- Future infrastructure changes must stay behind explicit review and real environment configuration.

## Local PostgreSQL

`infra/local/postgres.yml` is the deterministic local PostgreSQL fixture used by the onboarding runbook and opt-in DB integration checks.

## VPS installer contract

The installer installs Docker prerequisites, generates installation-local internal secrets in `/opt/deploylite/.env` with mode `0600`, and starts only the `bootstrap` control-plane profile. It does not prompt for a domain, ACME email, or functional runtime configuration.

- `postgres` uses `postgres:16-alpine` with a durable named volume.
- `migrate` runs the existing hand-authored SQL migrations once before the API starts.
- Traefik is the sole host listener on ports `80` and `443`; API and web have no host ports.
- The `bootstrap` profile is TLS-only: HTTP redirects to HTTPS and ACME state persists in `traefik-acme`.
- Traefik is pinned to `v3.6.7`. Its Docker v28.3.3 client uses Docker API `1.51`, so the Docker provider can discover the labeled API and web routers on Docker 29 (API `>=1.40`) instead of failing with the obsolete API `1.24` client error. This is observed Docker 29 compatibility only, not proof of support, lifecycle, provenance, supply-chain integrity, or upgrade readiness; see the [platform support policy](../docs/support-policy.md).
- API CORS and the web API URLs derive from `https://${DEPLOYLITE_PUBLIC_HOST}`.
- Health checks gate API/Web startup where Compose supports dependency conditions.

For local review, render the installer-safe base and Traefik overlay without starting services or enabling the runtime profile:

```bash
docker compose -f infra/vps/compose.yml -f infra/vps/compose.tls.yml config --no-interpolate
```

`deploylite.com` is the non-prompt, installation-specific bootstrap host. DNS for that host must resolve to the VPS before installation so ACME can provision TLS. ACME contact email is optional to Traefik and is not prompted. After the first owner signs in over HTTPS, the owner must set the operational contact and functional runtime configuration through the web surface. The generated database password and encryption key are internal control-plane secrets, never printed, and are not deployment configuration. No deployment or agent execution is started; runtime activation remains an explicit capability-gated admin action.

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

The installer supports Ubuntu 20.04/22.04/24.04 and Debian 11/12 on x86_64 or arm64. It requires root or sudo, verifies ports `80` and `443`, installs/verifies Docker Engine and the Compose plugin through `apt`, copies both Compose files, generates restricted internal secrets, validates the merged `bootstrap` profile, then starts it with a 120-second health-check bound. The first-owner page is routed only through Traefik HTTPS; API, web, and Postgres have no host ports.

This contract does not configure a custom public domain, ACME identity, firewall, backups, upgrades, uninstall/reset, Dokploy, or a deployment agent/server Docker socket.
