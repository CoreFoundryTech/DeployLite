#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_NAME="deploylite"
INSTALL_DIR="${DEPLOYLITE_INSTALL_DIR:-/opt/deploylite}"
REPO_ROOT="${DEPLOYLITE_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
COMPOSE_FILE="${INSTALL_DIR}/compose.yml"
ENV_FILE="${INSTALL_DIR}/.env"
STATE_DIR="${INSTALL_DIR}/.state"
CHANGED_STEPS=()
CREATED_RUNTIME=0

log() { printf '[%s] %s\n' "$1" "$(redact "${2:-}")"; }
info() { log INFO "$1"; }
warn() { log WARN "$1"; }
fail() { log ERROR "$1"; exit "${2:-1}"; }

redact() {
  local value="${1:-}"
  value="$(printf '%s' "$value" | sed -E 's#(postgres://[^:]+:)[^@]+@#\1[REDACTED]@#g')"
  value="$(printf '%s' "$value" | sed -E 's#((PASSWORD|SECRET|TOKEN|COOKIE|DATABASE_URL)[A-Z_]*=)[^[:space:]]+#\1[REDACTED]#Ig')"
  printf '%s' "$value"
}

on_error() {
  local code=$?
  warn "Install failed. Changed steps: ${CHANGED_STEPS[*]:-none}. Preserving ${INSTALL_DIR}/.env and Docker volumes."
  if [[ "$CREATED_RUNTIME" == "1" ]]; then
    warn "Stopping containers created by this run; volumes and config are preserved."
    compose_down_safe || true
  fi
  exit "$code"
}
trap on_error ERR

record_change() { CHANGED_STEPS+=("$1"); }
command_exists() { command -v "$1" >/dev/null 2>&1; }
run() { "$@"; }

as_root() {
  if [[ "${EUID}" -eq 0 ]]; then
    run "$@"
  elif command_exists sudo; then
    run sudo "$@"
  else
    fail "Root or sudo is required. Re-run as root or install sudo." 2
  fi
}

detect_os() {
  [[ -r /etc/os-release ]] || fail "Unsupported host: /etc/os-release is missing." 2
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}:${VERSION_ID:-}" in
    ubuntu:20.04|ubuntu:22.04|ubuntu:24.04|debian:11|debian:12) ;;
    *) fail "Unsupported host: expected Ubuntu 20.04/22.04/24.04 or Debian 11/12." 2 ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64|aarch64|arm64) ;;
    *) fail "Unsupported CPU architecture: $(uname -m). Expected x86_64 or arm64." 2 ;;
  esac
}

port_available() {
  local port="$1"
  if command_exists ss; then
    ! ss -ltn "sport = :${port}" | grep -q ":${port}"
  elif command_exists lsof; then
    ! lsof -iTCP:"${port}" -sTCP:LISTEN -Pn >/dev/null 2>&1
  else
    warn "Cannot verify port ${port}; ss/lsof not installed."
    return 0
  fi
}

preflight() {
  info "Running preflight checks."
  detect_os
  detect_arch
  if [[ "${EUID}" -ne 0 ]] && ! command_exists sudo; then
    fail "Root or sudo is required. Re-run as root or install sudo." 2
  fi
  port_available 80 || fail "Port 80 is already in use. Stop the conflicting service before installing." 2
  port_available 3001 || fail "Port 3001 is already in use. Stop the conflicting service before installing." 2
}

install_docker() {
  if command_exists docker && as_root docker compose version >/dev/null 2>&1; then
    info "Docker Engine and Compose plugin are available."
    return
  fi
  command_exists apt-get || fail "Docker is missing and automatic install requires apt-get." 2
  info "Installing Docker Engine and Compose plugin through Docker's official apt repository."
  install_docker_apt_repository
  as_root apt-get update
  as_root apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  command_exists docker || fail "Docker installation did not provide docker CLI." 2
  as_root docker compose version >/dev/null 2>&1 || fail "Docker Compose plugin is unavailable after install." 2
  record_change "docker-installed-or-updated"
}

install_docker_apt_repository() {
  local codename arch signed_by repo_file
  command_exists curl || as_root apt-get install -y ca-certificates curl gnupg
  command_exists gpg || as_root apt-get install -y gnupg
  # shellcheck disable=SC1091
  . /etc/os-release
  codename="${VERSION_CODENAME:-}"
  [[ -n "$codename" ]] || fail "Could not detect distro codename for Docker apt repository." 2
  case "$(dpkg --print-architecture)" in
    amd64|arm64) arch="$(dpkg --print-architecture)" ;;
    *) fail "Unsupported apt architecture for Docker repository: $(dpkg --print-architecture)." 2 ;;
  esac
  signed_by="/etc/apt/keyrings/docker.asc"
  repo_file="/etc/apt/sources.list.d/docker.list"
  as_root install -m 0755 -d /etc/apt/keyrings
  if [[ ! -s "$signed_by" ]]; then
    curl -fsSL "https://download.docker.com/linux/${ID}/gpg" | as_root tee "$signed_by" >/dev/null
    as_root chmod a+r "$signed_by"
  fi
  printf 'deb [arch=%s signed-by=%s] https://download.docker.com/linux/%s %s stable\n' "$arch" "$signed_by" "${ID}" "$codename" \
    | as_root tee "$repo_file" >/dev/null
}

random_secret() {
  if command_exists openssl; then
    openssl rand -base64 36 | tr -d '\n'
  else
    LC_ALL=C tr -dc 'A-Za-z0-9_-' </dev/urandom | head -c 48
  fi
}

detect_public_host() {
  if [[ -n "${DEPLOYLITE_PUBLIC_HOST:-}" ]]; then
    printf '%s' "$DEPLOYLITE_PUBLIC_HOST"
    return
  fi
  local candidate=""
  if command_exists curl; then
    candidate="$(curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null || true)"
  fi
  [[ -n "$candidate" ]] || candidate="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  [[ -n "$candidate" ]] || fail "Could not detect public host. Set DEPLOYLITE_PUBLIC_HOST=<ip-or-host>." 2
  printf '%s' "$candidate"
}

env_get() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 1
  grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true
}

write_env() {
  local host postgres_password tmp
  host="$(detect_public_host)"
  postgres_password="$(env_get POSTGRES_PASSWORD || true)"
  [[ -n "$postgres_password" ]] || postgres_password="$(random_secret)"
  tmp="$(mktemp)"
  umask 077
  cat >"$tmp" <<EOF
COMPOSE_PROJECT_NAME=deploylite
DEPLOYLITE_PUBLIC_HOST=${host}
DEPLOYLITE_PUBLIC_WEB_ORIGIN=http://${host}
DEPLOYLITE_PUBLIC_API_ORIGIN=http://${host}:3001
POSTGRES_PASSWORD=${postgres_password}
POSTGRES_DB=deploylite
POSTGRES_USER=deploylite
DEPLOYLITE_SESSION_TTL_SECONDS=28800
DEPLOYLITE_SESSION_COOKIE_NAME=deploylite_session
DEPLOYLITE_SESSION_COOKIE_SECURE=false
DEPLOYLITE_BCRYPT_COST=12
EOF
  as_root install -m 600 "$tmp" "$ENV_FILE"
  rm -f "$tmp"
}

prepare_install_dir() {
  info "Preparing ${INSTALL_DIR}."
  as_root mkdir -p "$INSTALL_DIR" "$STATE_DIR"
  as_root chmod 700 "$INSTALL_DIR"
  install_compose_file
  if [[ ! -f "$ENV_FILE" ]]; then
    write_env
    record_change "env-created"
  else
    as_root chmod 600 "$ENV_FILE"
    info "Existing .env found; preserving generated secrets."
  fi
  record_change "runtime-files-installed"
}

install_compose_file() {
  local tmp
  tmp="$(mktemp)"
  sed "s#context: ../..#context: ${REPO_ROOT}#g" "${REPO_ROOT}/infra/vps/compose.yml" >"$tmp"
  as_root install -m 644 "$tmp" "$COMPOSE_FILE"
  rm -f "$tmp"
}

compose() { as_root docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" --project-directory "$INSTALL_DIR" "$@"; }
compose_down_safe() { compose down --remove-orphans; }

start_runtime() {
  info "Rendering Compose configuration."
  compose config >/dev/null
  info "Building and starting DeployLite runtime."
  compose up -d --build postgres
  CREATED_RUNTIME=1
  compose up --build migrate
  compose up -d --build api web
  record_change "runtime-started"
}

wait_for_url() {
  local name="$1" url="$2" attempts="${3:-30}" delay="${4:-5}"
  for ((i = 1; i <= attempts; i += 1)); do
    if curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then
      info "${name} is healthy."
      return 0
    fi
    sleep "$delay"
  done
  fail "${name} did not become healthy at ${url}. Check docker compose logs." 1
}

wait_for_health() {
  wait_for_url "API" "http://127.0.0.1:3001/api/v1/health" 30 5
  wait_for_url "Web" "http://127.0.0.1/" 30 5
}

print_success() {
  local host web api
  host="$(env_get DEPLOYLITE_PUBLIC_HOST)"
  web="http://${host}"
  api="http://${host}:3001"
  info "DeployLite is ready."
  printf '\nDeployLite URL: %s\n' "$web"
  printf 'API URL: %s\n' "$api"
  printf 'Open the DeployLite URL in a browser and create the first owner account from the setup screen.\n'
  printf 'No default admin credentials were created. Keep %s private.\n' "$ENV_FILE"
}

main() {
  preflight
  install_docker
  prepare_install_dir
  start_runtime
  wait_for_health
  print_success
}

if [[ "${DEPLOYLITE_INSTALL_TESTING:-0}" != "1" ]]; then
  main "$@"
fi
