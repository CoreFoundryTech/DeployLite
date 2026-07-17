#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
base_rendered="$(docker compose -f "$ROOT_DIR/infra/vps/compose.yml" config --no-interpolate)"
rendered="$(docker compose -f "$ROOT_DIR/infra/vps/compose.yml" -f "$ROOT_DIR/infra/vps/compose.tls.yml" config --no-interpolate)"

contains() { [[ "$rendered" == *"$1"* ]] || { printf 'missing: %s\n' "$1"; return 1; }; }
[[ "$base_rendered" == *'traefik:v3.1'* ]] || { printf 'base Compose must render Traefik without runtime configuration\n'; exit 1; }
contains "DEPLOYLITE_CORS_ORIGIN: https://\${DEPLOYLITE_PUBLIC_HOST:-deploylite.invalid}"
contains -- '--entrypoints.web.http.redirections.entrypoint.scheme=https'
contains 'source: traefik-acme'
contains 'target: /acme'
contains 'DEPLOYLITE_SESSION_COOKIE_SECURE: "true"'
if [[ "$rendered" == *'"3001:3001"'* || "$rendered" == *'"80:3000"'* ]]; then
  printf 'API or web must not publish host ports\n'
  exit 1
fi
printf 'compose TLS contract passed\n'
