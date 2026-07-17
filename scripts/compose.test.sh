#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
rendered="$(docker compose -f "$ROOT_DIR/infra/vps/compose.yml" -f "$ROOT_DIR/infra/vps/compose.tls.yml" --env-file "$ROOT_DIR/infra/vps/.env.example" --profile runtime config)"

contains() { [[ "$rendered" == *"$1"* ]] || { printf 'missing: %s\n' "$1"; return 1; }; }
contains 'DEPLOYLITE_CORS_ORIGIN: https://deploylite.invalid'
contains -- '--entrypoints.web.http.redirections.entrypoint.scheme=https'
contains 'source: traefik-acme'
contains 'target: /acme'
contains 'DEPLOYLITE_SESSION_COOKIE_SECURE: "true"'
if [[ "$rendered" == *'"3001:3001"'* || "$rendered" == *'"80:3000"'* ]]; then
  printf 'API or web must not publish host ports\n'
  exit 1
fi
printf 'compose TLS contract passed\n'
