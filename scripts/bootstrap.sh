#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

readonly DEFAULT_REPO="CoreFoundryTech/DeployLite"
readonly DEFAULT_VERSION="main"

DEPLOYLITE_REPO="${DEPLOYLITE_REPO:-$DEFAULT_REPO}"
DEPLOYLITE_VERSION="${DEPLOYLITE_VERSION:-$DEFAULT_VERSION}"

TMP_ROOT=""
TARBALL_PATH=""
SOURCE_DIR=""

log() { printf '[%s] %s\n' "$1" "${2:-}"; }
info() { log INFO "$1"; }
fail() { log ERROR "$1"; exit "${2:-1}"; }

cleanup() {
  if [[ -n "$TMP_ROOT" && -d "$TMP_ROOT" ]]; then
    rm -rf "$TMP_ROOT"
  fi
}
trap cleanup EXIT

on_error() {
  local code=$?
  log ERROR "Bootstrap failed. Temporary files were cleaned up. No secrets were printed."
  exit "$code"
}
trap on_error ERR

command_exists() { command -v "$1" >/dev/null 2>&1; }

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    fail "Root execution is required. Re-run with: curl -fsSL <bootstrap-url> | sudo DEPLOYLITE_PUBLIC_HOST=<ip-or-host> bash" 2
  fi
}

require_dependency() {
  local name="$1"
  command_exists "$name" || fail "Missing required dependency: ${name}. Install it and retry." 2
}

validate_config() {
  [[ "$DEPLOYLITE_REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "Invalid DEPLOYLITE_REPO. Expected owner/repo." 2
  [[ "$DEPLOYLITE_VERSION" =~ ^[A-Za-z0-9._/@+-]+$ ]] || fail "Invalid DEPLOYLITE_VERSION/ref. Use a branch, tag, or commit ref." 2
}

preflight() {
  require_root
  validate_config
  if ! command_exists curl && ! command_exists wget; then
    fail "Missing required dependency: curl or wget. Install one and retry." 2
  fi
  require_dependency tar
  require_dependency mktemp
}

tarball_url() {
  printf 'https://codeload.github.com/%s/tar.gz/%s' "$DEPLOYLITE_REPO" "$DEPLOYLITE_VERSION"
}

download_tarball() {
  local url="$1"
  if command_exists curl; then
    curl -fsSL "$url" -o "$TARBALL_PATH"
  else
    wget -qO "$TARBALL_PATH" "$url"
  fi
}

extract_source() {
  tar -xzf "$TARBALL_PATH" -C "$TMP_ROOT/source"
  SOURCE_DIR="$(find "$TMP_ROOT/source" -mindepth 1 -maxdepth 1 -type d | sort | head -n 1)"
  [[ -n "$SOURCE_DIR" ]] || fail "Downloaded archive did not contain a source directory." 1
  [[ -x "$SOURCE_DIR/scripts/install.sh" || -f "$SOURCE_DIR/scripts/install.sh" ]] || fail "Downloaded archive is missing scripts/install.sh." 1
}

export_deploylite_environment() {
  local name
  while IFS= read -r name; do
    [[ "$name" =~ ^DEPLOYLITE_[A-Za-z0-9_]*$ ]] || continue
    # shellcheck disable=SC2163
    export "$name"
  done < <(compgen -v DEPLOYLITE_ || true)
}

run_installer() {
  export_deploylite_environment
  bash "$SOURCE_DIR/scripts/install.sh" "$@"
}

main() {
  preflight
  TMP_ROOT="$(mktemp -d)"
  mkdir -p "$TMP_ROOT/source"
  TARBALL_PATH="$TMP_ROOT/deploylite.tar.gz"

  info "Downloading DeployLite source archive."
  download_tarball "$(tarball_url)"
  info "Extracting DeployLite source archive."
  extract_source
  info "Starting DeployLite installer from downloaded source."
  run_installer "$@"
}

if [[ "${DEPLOYLITE_BOOTSTRAP_TESTING:-0}" != "1" ]]; then
  main "$@"
fi
