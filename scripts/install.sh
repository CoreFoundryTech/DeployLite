#!/usr/bin/env bash
set -Eeuo pipefail

INSTALL_DIR="${DEPLOYLITE_INSTALL_DIR:-/opt/deploylite}"
REPO_ROOT="${DEPLOYLITE_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
COMPOSE_FILE="${INSTALL_DIR}/compose.yml"
ENV_FILE="${INSTALL_DIR}/.env"
STATE_DIR="${INSTALL_DIR}/.state"
DEFAULT_LOG_FILE="/var/log/deploylite/install.log"
INSTALL_LOG="${DEPLOYLITE_INSTALL_LOG:-$DEFAULT_LOG_FILE}"
INSTALL_LOG_DIR="${DEPLOYLITE_INSTALL_LOG_DIR:-$(dirname "$INSTALL_LOG")}"
INTERACTIVE=0
NOOP=0
CHANGED_STEPS=()
CREATED_RUNTIME=0

log() { printf '[%s] %s\n' "$1" "$(redact "${2:-}")"; }
info() { log INFO "$1"; }
# warn/fail write to stderr so command substitutions like
# `host="$(detect_public_host)"` cannot accidentally capture the error
# message and treat it as a successful value. info stays on stdout
# because it is the normal "this worked" channel and the installer's
# `exec > >(tee ...)` redirect is the one that copies it to the log.
warn() { printf '[%s] %s\n' "$1" "$(redact "${2:-}")" >&2; }
fail() { printf '[%s] %s\n' "$1" "$(redact "${2:-}")" >&2; exit "${2:-1}"; }

redact() {
  local value="${1:-}"
  value="$(printf '%s' "$value" | sed -E 's#(postgres://[^:]+:)[^@]+@#\1[REDACTED]@#g')"
  value="$(printf '%s' "$value" | sed -E 's#((PASSWORD|SECRET|TOKEN|COOKIE|DATABASE_URL)[A-Z_]*=)[^[:space:]]+#\1[REDACTED]#Ig')"
  value="$(printf '%s' "$value" | sed -E 's#(DEPLOYLITE_AGENT_(ID|TOKEN|BUILDER_REGISTRY_INTEGRITY_KEY|BUILDER_REGISTRY_PREVIOUS_INTEGRITY_KEY)=)[^[:space:]]+#\1[REDACTED]#Ig')"
  printf '%s' "$value"
}

# Stream-level redaction. Reads bytes from stdin and writes redacted bytes
# to stdout. Used as a coproc filter so that EVERY line — including raw
# command stdout/stderr that never touches log() — is rewritten before it
# reaches the tee that writes the install log. Keep the patterns here in
# sync with the value-based redact() above; the log() call sites apply the
# same rewrites a second time, which is idempotent.
redact_stream() {
  sed -u -E \
    -e 's#(postgres://[^:]+:)[^@]+@#\1[REDACTED]@#g' \
    -e 's#((PASSWORD|SECRET|TOKEN|COOKIE|DATABASE_URL)[A-Z_]*=)[^[:space:]]+#\1[REDACTED]#Ig' \
    -e 's#(DEPLOYLITE_AGENT_(ID|TOKEN|BUILDER_REGISTRY_INTEGRITY_KEY|BUILDER_REGISTRY_PREVIOUS_INTEGRITY_KEY)=)[^[:space:]]+#\1[REDACTED]#Ig'
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

print_usage() {
  cat <<'USAGE'
Usage: install.sh [options]

Options:
  --interactive, -i   Prompt for install values (TUI when available, read fallback).
  --help, -h          Show this help and exit.

Environment:
  DEPLOYLITE_PUBLIC_HOST=<ip-or-host>  Public host for the runtime.
  DEPLOYLITE_INSTALL_DIR=<path>        Install directory (default: /opt/deploylite).
  DEPLOYLITE_INSTALL_LOG=<path>        Install log file (default: /var/log/deploylite/install.log).
  DEPLOYLITE_INSTALL_LOG_DIR=<path>    Install log directory (default: parent of DEPLOYLITE_INSTALL_LOG).

Logs:
  The installer tees stdout and stderr to the install log with redaction applied
  to every line, including database URLs, password assignments, and secret tokens.
  Default path: /var/log/deploylite/install.log
USAGE
}

parse_args() {
  while (( $# > 0 )); do
    case "$1" in
      --interactive|-i) INTERACTIVE=1; shift ;;
      --noop) NOOP=1; shift ;;
      --help|-h) print_usage; exit 0 ;;
      --)
        shift
        while (( $# > 0 )); do
          fail "Unknown argument: $1. Use --interactive or --help." 2
        done
        ;;
      *) fail "Unknown argument: $1. Use --interactive or --help." 2 ;;
    esac
  done
}

# Create the install log directory and file, then redirect stdout and stderr
# through `tee` so the terminal and the log file see the same redacted stream.
# Idempotent: re-running appends to the existing log instead of truncating.
# Repairs unsafe permissions on a pre-existing log file (e.g., mode 0666 left
# behind by an earlier installer version) by downgrading to the safe 0640
# target whenever the current user has permission to do so.
install_log_setup() {
  local log_file="${INSTALL_LOG}"
  local log_dir="${INSTALL_LOG_DIR}"
  if [[ ! -d "$log_dir" ]]; then
    if ! as_root mkdir -p "$log_dir" 2>/dev/null; then
      warn "Could not create log directory ${log_dir}. Continuing without file log."
      return 0
    fi
  fi
  info "log directory ready at ${log_dir}"
  if ! ( umask 027; as_root touch "$log_file" ) 2>/dev/null; then
    warn "Could not create log file ${log_file}. Continuing without file log."
    return 0
  fi
  if ! as_root test -w "$log_file"; then
    warn "Log file ${log_file} is not writable. Continuing without file log."
    return 0
  fi
  # Repair unsafe permissions on a pre-existing log file. The umask only
  # affects newly created files, so an older install log with mode 0666 or
  # anything world-readable would otherwise stay world-readable forever.
  # The warning is written to BOTH the log file (for post-mortem review)
  # and stderr (for the operator's terminal). We can't just call warn()
  # because the tee that copies stdout to the log file has not been
  # started yet at this point in the function.
  if [[ -f "$log_file" ]]; then
    local current_mode=""
    current_mode="$(stat -c '%a' "$log_file" 2>/dev/null || stat -f '%Lp' "$log_file" 2>/dev/null || echo "")"
    case "$current_mode" in
      600|640) ;;
      "")
        printf '[%s] %s\n' "WARN" "Could not stat ${log_file} to verify mode; leaving permissions untouched." | as_root tee -a "$log_file" >&2
        ;;
      *)
        if as_root chmod 0640 "$log_file" 2>/dev/null; then
          printf '[%s] %s\n' "WARN" "Repaired unsafe log file mode ${current_mode} -> 0640 on ${log_file}." | as_root tee -a "$log_file" >&2
        else
          printf '[%s] %s\n' "WARN" "Could not repair unsafe log file mode ${current_mode} on ${log_file}; leaving permissions untouched." | as_root tee -a "$log_file" >&2
        fi
        ;;
    esac
  fi
  if [[ "${DEPLOYLITE_INSTALL_TESTING:-0}" == "1" && "${DEPLOYLITE_INSTALL_SKIP_TEE:-0}" == "1" ]]; then
    info "Install log: ${log_file} (tee disabled in test mode)"
    return 0
  fi
  # `exec` replaces the shell's stdout and stderr so the redirect survives
  # every subsequent function call. The byte stream passes through
  # redact_stream() — a sed-based filter that rewrites postgres URLs and
  # KEY=VALUE secret patterns on every line — before tee writes them to
  # the log file. The terminal also sees the redacted stream, which is
  # the safe default for an installer. log() redacts again at the value
  # level, which is idempotent. `trap '' PIPE` keeps the sed filter from
  # dying with SIGPIPE when the downstream tee closes, which would
  # otherwise trip `set -o pipefail`.
  if exec > >(
    trap '' PIPE
    redact_stream | as_root tee -a "$log_file"
  ) 2>&1; then
    info "Install log: ${log_file}"
  else
    warn "Could not redirect stdout to tee for ${log_file}."
  fi
  return 0
}

# Render an interactive prompt. Prefers whiptail when available; otherwise
# falls back to plain read so `--interactive` works on minimal VPS images
# and on systems without a tty (where read reads from a pipe).
prompt_value() {
  local label="$1" default_value="${2:-}" response=""
  if [[ "${INTERACTIVE}" != "1" ]]; then
    printf '%s' "$default_value"
    return 0
  fi
  if command_exists whiptail && [[ -t 0 ]]; then
    response="$(whiptail --inputbox "$label" 8 60 "$default_value" --title "DeployLite install" 3>&1 1>&2 2>&3 || true)"
    if [[ -n "$response" ]]; then
      printf '%s' "$response"
      return 0
    fi
  fi
  if [[ -t 0 ]]; then
    local ans
    read -r -p "${label} [${default_value}]: " ans || true
    printf '%s' "${ans:-$default_value}"
  else
    # Non-tty stdin: read whatever line was piped in. This keeps
    # `printf 'value\n' | bash install.sh --interactive` working in tests
    # and in piped automation that still wants a confirmation.
    local ans
    IFS= read -r ans || true
    printf '%s' "${ans:-$default_value}"
  fi
}

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
    if ss -ltn "sport = :${port}" | grep -q ":${port}"; then
      return 1
    fi
    return 0
  fi
  if command_exists lsof; then
    if lsof -iTCP:"${port}" -sTCP:LISTEN -Pn >/dev/null 2>&1; then
      return 1
    fi
    return 0
  fi
  warn "Cannot verify port ${port}; ss/lsof not installed."
  return 0
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
  if [[ "${DEPLOYLITE_SKIP_DOCKER_INSTALL:-0}" == "1" ]]; then
    info "Skipping Docker install (DEPLOYLITE_SKIP_DOCKER_INSTALL=1)."
    return 0
  fi
  if command_exists docker && as_root docker compose version >/dev/null 2>&1; then
    info "Docker Engine and Compose plugin already installed; skipping apt install."
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

random_hex() {
  local bytes="$1" value=""
  if command_exists openssl; then
    value="$(openssl rand -hex "$bytes" 2>/dev/null)" || fail "Could not generate installer secrets with OpenSSL." 1
  elif [[ -r /dev/urandom ]] && command_exists od; then
    value="$(od -An -N "$bytes" -tx1 /dev/urandom 2>/dev/null | tr -d '[:space:]')" || fail "Could not read secure system entropy for installer secrets." 1
  else
    fail "Secure entropy tooling is unavailable; install OpenSSL or provide readable /dev/urandom with od." 1
  fi
  [[ "$value" =~ ^[0-9a-fA-F]+$ ]] && [[ "${#value}" -eq $((bytes * 2)) ]] \
    || fail "Secure entropy generation returned an invalid value." 1
  printf '%s' "$value"
}

random_secret() {
  random_hex 32
}

default_repository_allowed_hosts() {
  printf '%s' 'github.com'
}

random_uuid_v4() {
  local value variant
  value="$(random_hex 16)"
  variant=$(( (16#${value:16:1} & 3) | 8 ))
  printf '%s-%s-4%s-%x%s-%s' \
    "${value:0:8}" "${value:8:4}" "${value:13:3}" "$variant" "${value:17:3}" "${value:20:12}"
}

detect_public_host_inner() {
  # Best-effort public host detection. Returns the detected value on
  # stdout (which may be empty) and never calls fail/exit, so callers
  # that want to offer a default without aborting the installer can use
  # it. detect_public_host wraps this with the hard-fail behavior.
  if [[ -n "${DEPLOYLITE_PUBLIC_HOST:-}" ]]; then
    printf '%s' "$DEPLOYLITE_PUBLIC_HOST"
    return 0
  fi
  local candidate=""
  if command_exists curl; then
    candidate="$(curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null || true)"
  fi
  [[ -n "$candidate" ]] || candidate="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  printf '%s' "$candidate"
}

detect_public_host() {
  local host
  host="$(detect_public_host_inner)"
  [[ -n "$host" ]] || fail "Could not detect public host. Set DEPLOYLITE_PUBLIC_HOST=<ip-or-host>." 2
  printf '%s' "$host"
}

env_get() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 1
  grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true
}

write_env() {
  local host postgres_password secret_key tmp detected interactive_host
  if [[ "${INTERACTIVE}" == "1" ]]; then
    # Offer a sensible default to the prompt without aborting the
    # installer on detection failure. The detect helper caps its own
    # network call (curl --max-time 3) so an unreachable ipify endpoint
    # cannot stall the installer. The user can accept the detected
    # value by pressing enter or override it. In non-interactive mode
    # this branch is skipped entirely and the hard-fail path runs.
    detected="$(detect_public_host_inner)"
    interactive_host="$(prompt_value 'Public host (IP or hostname) for the runtime' "$detected")"
    host="${interactive_host:-$detected}"
  else
    host="$(detect_public_host)"
  fi
  [[ -n "${host:-}" ]] || fail "Could not determine the public host. Set DEPLOYLITE_PUBLIC_HOST=<ip-or-host> and retry." 2
  postgres_password="$(env_get POSTGRES_PASSWORD || true)"
  [[ -n "$postgres_password" ]] || postgres_password="$(random_secret)"
  secret_key="$(env_get DEPLOYLITE_SECRET_KEY || true)"
  [[ -n "$secret_key" ]] || secret_key="$(random_secret)"
  tmp="$(mktemp)"
  umask 077
  cat >"$tmp" <<EOF
COMPOSE_PROJECT_NAME=deploylite
DEPLOYLITE_PUBLIC_HOST=${host}
DEPLOYLITE_PUBLIC_WEB_ORIGIN=http://${host}
DEPLOYLITE_PUBLIC_API_ORIGIN=http://${host}:3001
POSTGRES_PASSWORD=${postgres_password}
DEPLOYLITE_SECRET_KEY=${secret_key}
POSTGRES_DB=deploylite
POSTGRES_USER=deploylite
DEPLOYLITE_SESSION_TTL_SECONDS=28800
DEPLOYLITE_SESSION_COOKIE_NAME=deploylite_session
DEPLOYLITE_SESSION_COOKIE_SECURE=false
DEPLOYLITE_BCRYPT_COST=12
DEPLOYLITE_REPO_ALLOWED_HOSTS=github.com
EOF
  as_root install -m 600 "$tmp" "$ENV_FILE"
  rm -f "$tmp"
  if [[ "${INTERACTIVE}" == "1" ]]; then
    info "Public host confirmed: ${host}"
  fi
}

ensure_env_value() {
  local key="$1" generator="$2" value
  value="$(env_get "$key" || true)"
  [[ -n "$value" ]] && return 0
  value="$($generator)"
  [[ -n "$value" ]] || fail "Could not generate required ${key} without exposing its value." 1
  ( umask 077; printf '%s=%s\n' "$key" "$value" ) | as_root tee -a "$ENV_FILE" >/dev/null
  as_root chmod 600 "$ENV_FILE"
}

ensure_compose_secrets() {
  # Keep each secret independent. Values are never logged or passed as command arguments.
  ensure_env_value DEPLOYLITE_SECRET_KEY random_secret
  ensure_env_value DEPLOYLITE_AGENT_ID random_uuid_v4
  ensure_env_value DEPLOYLITE_AGENT_TOKEN random_secret
  ensure_env_value DEPLOYLITE_AGENT_BUILDER_REGISTRY_INTEGRITY_KEY random_secret
  ensure_env_value DEPLOYLITE_REPO_ALLOWED_HOSTS default_repository_allowed_hosts
}

prepare_install_dir() {
  if [[ -d "$INSTALL_DIR" && -f "$COMPOSE_FILE" && -f "$ENV_FILE" ]]; then
    info "Existing install at ${INSTALL_DIR} detected; preserving state."
  fi
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
  ensure_compose_secrets
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
  compose up -d --build api web agent
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
  if ! compose up -d --wait --wait-timeout 150 agent; then
    warn "Agent did not become healthy. Redacted agent diagnostics follow."
    compose logs --tail 100 agent 2>&1 | redact_stream >&2 || true
    fail "Agent startup failed. Check redacted Docker Compose diagnostics." 1
  fi
  info "Agent is healthy."
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
  parse_args "$@"
  install_log_setup
  if [[ "${INTERACTIVE}" == "1" ]]; then
    info "Interactive mode: prompts enabled (TUI when available, read fallback)."
  else
    info "Running in non-interactive mode; use --interactive to enable prompts."
  fi
  if [[ "${NOOP}" == "1" ]]; then
    info "Noop mode: skipping preflight, Docker install, and runtime."
    return 0
  fi
  preflight
  install_docker
  if [[ "${DEPLOYLITE_SKIP_RUNTIME:-0}" == "1" ]]; then
    info "Skipping runtime install (DEPLOYLITE_SKIP_RUNTIME=1)."
    return 0
  fi
  prepare_install_dir
  start_runtime
  wait_for_health
  print_success
}

if [[ "${DEPLOYLITE_INSTALL_TESTING:-0}" != "1" ]]; then
  main "$@"
fi
