#!/usr/bin/env bash
set -Eeuo pipefail

INSTALL_DIR="${DEPLOYLITE_INSTALL_DIR:-/opt/deploylite}"
REPO_ROOT="${DEPLOYLITE_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
COMPOSE_FILE="${INSTALL_DIR}/compose.yml"
TLS_COMPOSE_FILE="${INSTALL_DIR}/compose.tls.yml"
STATE_DIR="${INSTALL_DIR}/.state"
DEFAULT_LOG_FILE="/var/log/deploylite/install.log"
INSTALL_LOG="${DEPLOYLITE_INSTALL_LOG:-$DEFAULT_LOG_FILE}"
INSTALL_LOG_DIR="${DEPLOYLITE_INSTALL_LOG_DIR:-$(dirname "$INSTALL_LOG")}"
INTERACTIVE=1
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
    -e 's#((PASSWORD|SECRET|TOKEN|COOKIE|DATABASE_URL)[A-Z_]*=)[^[:space:]]+#\1[REDACTED]#Ig'
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
  --non-interactive   Skip the prerequisite confirmation TUI.
  --help, -h          Show this help and exit.

Environment:
  DEPLOYLITE_PUBLIC_HOST=<hostname>    Future HTTPS host; not persisted by this installer.
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
       --non-interactive) INTERACTIVE=0; shift ;;
      --noop) NOOP=1; shift ;;
      --help|-h) print_usage; exit 0 ;;
      --)
        shift
        while (( $# > 0 )); do
        fail "Unknown argument: $1. Use --non-interactive or --help." 2
        done
        ;;
      *) fail "Unknown argument: $1. Use --non-interactive or --help." 2 ;;
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
  port_available 443 || fail "Port 443 is already in use. Stop the conflicting service before installing." 2
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

random_secret() {
  if command_exists openssl; then
    openssl rand -hex 32 | tr -d '\n'
  else
    LC_ALL=C tr -dc 'A-Za-z0-9_-' </dev/urandom | head -c 48
  fi
}

prepare_install_dir() {
  if [[ -d "$INSTALL_DIR" && -f "$COMPOSE_FILE" && -f "$TLS_COMPOSE_FILE" ]]; then
    info "Existing install at ${INSTALL_DIR} detected; preserving state."
  fi
  info "Preparing ${INSTALL_DIR}."
  as_root mkdir -p "$INSTALL_DIR" "$STATE_DIR"
  as_root chmod 700 "$INSTALL_DIR"
  install_compose_file
  record_change "compose-files-installed"
}

install_compose_file() {
  local tmp tls_tmp
  tmp="$(mktemp)"
  tls_tmp="$(mktemp)"
  sed "s#context: ../..#context: ${REPO_ROOT}#g" "${REPO_ROOT}/infra/vps/compose.yml" >"$tmp"
  sed "s#context: ../..#context: ${REPO_ROOT}#g" "${REPO_ROOT}/infra/vps/compose.tls.yml" >"$tls_tmp"
  as_root install -m 644 "$tmp" "$COMPOSE_FILE"
  as_root install -m 644 "$tls_tmp" "$TLS_COMPOSE_FILE"
  rm -f "$tmp" "$tls_tmp"
}

compose() { as_root docker compose -f "$COMPOSE_FILE" -f "$TLS_COMPOSE_FILE" --project-directory "$INSTALL_DIR" "$@"; }
compose_down_safe() { compose down --remove-orphans; }

validate_compose() {
  info "Validating merged Compose configuration."
  compose --profile runtime config >/dev/null
}

main() {
  parse_args "$@"
  install_log_setup
  if [[ "${INTERACTIVE}" == "1" ]]; then
    [[ "$(prompt_value 'Install Docker prerequisites and Compose templates?' 'yes')" == "yes" ]] || fail "Installation cancelled." 1
    info "Interactive prerequisite confirmation accepted."
  else
    info "Running in explicit non-interactive mode."
  fi
  if [[ "${NOOP}" == "1" ]]; then
    info "Noop mode: skipping preflight, Docker install, and runtime."
    return 0
  fi
  preflight
  install_docker
  prepare_install_dir
  validate_compose
  info "Prerequisites and Compose templates are ready. Domain and ACME configuration remain web-owned."
}

if [[ "${DEPLOYLITE_INSTALL_TESTING:-0}" != "1" ]]; then
  main "$@"
fi
