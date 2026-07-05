#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export DEPLOYLITE_INSTALL_TESTING=1
# shellcheck source=scripts/install.sh
. "${ROOT_DIR}/scripts/install.sh"

PASS=0
FAIL=0

assert_contains() {
  local haystack="$1" needle="$2"
  [[ "$haystack" == *"$needle"* ]] || { printf 'expected output to contain %s\nactual: %s\n' "$needle" "$haystack"; return 1; }
}

assert_not_contains() {
  local haystack="$1" needle="$2"
  [[ "$haystack" != *"$needle"* ]] || { printf 'expected output not to contain %s\nactual: %s\n' "$needle" "$haystack"; return 1; }
}

run_test() {
  local name="$1"
  shift
  if "$@"; then
    PASS=$((PASS + 1))
    printf 'ok - %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
    printf 'not ok - %s\n' "$name"
  fi
}

test_redaction_masks_database_url_and_secret_assignments() {
  local output
  output="$(redact 'DATABASE_URL=postgres://deploylite:super-secret@postgres:5432/deploylite POSTGRES_PASSWORD=hunter2 TOKEN_VALUE=abc')"
  assert_contains "$output" 'DATABASE_URL=[REDACTED]' || return 1
  assert_contains "$output" 'POSTGRES_PASSWORD=[REDACTED]' || return 1
  assert_contains "$output" 'TOKEN_VALUE=[REDACTED]' || return 1
  assert_not_contains "$output" 'super-secret' || return 1
  assert_not_contains "$output" 'hunter2' || return 1
}

test_unsupported_host_fails_without_mutation() {
  local tmp output status
  tmp="$(mktemp -d)"
  INSTALL_DIR="${tmp}/opt"
  detect_os() { fail 'Unsupported host: expected Ubuntu 20.04/22.04/24.04 or Debian 11/12.' 2; }
  detect_arch() { :; }
  port_available() { :; }
  command_exists() { [[ "$1" == "sudo" ]]; }
  output="$(preflight 2>&1)" && status=0 || status=$?
  [[ "$status" -eq 2 ]]
  assert_contains "$output" 'Unsupported host'
  [[ ! -e "$INSTALL_DIR" ]]
  rm -rf "$tmp"
}

test_occupied_port_fails_actionably() {
  local output status
  detect_os() { :; }
  detect_arch() { :; }
  command_exists() { [[ "$1" == "sudo" ]]; }
  port_available() { [[ "$1" != "80" ]]; }
  output="$(preflight 2>&1)" && status=0 || status=$?
  [[ "$status" -eq 2 ]]
  assert_contains "$output" 'Port 80 is already in use'
}

test_install_docker_uses_apt_when_missing() {
  local calls=() docker_ready=0
  command_exists() { [[ "$1" == "apt-get" ]] || { [[ "$1" == "docker" && "$docker_ready" == "1" ]]; }; }
  docker() { [[ "$1 $2" == "compose version" ]]; }
  as_root() { calls+=("$*"); [[ "$*" == apt-get\ install* ]] && docker_ready=1; return 0; }
  install_docker
  [[ " ${calls[*]} " == *" apt-get update "* ]]
  [[ " ${calls[*]} " == *" apt-get install -y ca-certificates curl gnupg docker.io docker-compose-plugin "* ]]
}

test_prepare_install_dir_preserves_existing_secret() {
  local tmp saved
  tmp="$(mktemp -d)"
  INSTALL_DIR="${tmp}/install"
  COMPOSE_FILE="${INSTALL_DIR}/compose.yml"
  ENV_FILE="${INSTALL_DIR}/.env"
  STATE_DIR="${INSTALL_DIR}/.state"
  mkdir -p "$INSTALL_DIR"
  printf 'POSTGRES_PASSWORD=existing-secret\nDEPLOYLITE_PUBLIC_HOST=old-host\n' >"$ENV_FILE"
  chmod 644 "$ENV_FILE"
  as_root() { "$@"; }
  prepare_install_dir >/dev/null
  saved="$(cat "$ENV_FILE")"
  assert_contains "$saved" 'POSTGRES_PASSWORD=existing-secret'
  [[ "$(stat -f '%Lp' "$ENV_FILE" 2>/dev/null || stat -c '%a' "$ENV_FILE")" == "600" ]]
  rm -rf "$tmp"
}

test_write_env_generates_once_with_private_permissions() {
  local tmp saved
  tmp="$(mktemp -d)"
  INSTALL_DIR="${tmp}/install"
  ENV_FILE="${INSTALL_DIR}/.env"
  mkdir -p "$INSTALL_DIR"
  DEPLOYLITE_PUBLIC_HOST="198.51.100.10"
  as_root() { "$@"; }
  random_secret() { printf 'generated-secret'; }
  write_env
  saved="$(cat "$ENV_FILE")"
  assert_contains "$saved" 'DEPLOYLITE_PUBLIC_WEB_ORIGIN=http://198.51.100.10'
  assert_contains "$saved" 'DEPLOYLITE_PUBLIC_API_ORIGIN=http://198.51.100.10:3001'
  assert_contains "$saved" 'POSTGRES_PASSWORD=generated-secret'
  [[ "$(stat -f '%Lp' "$ENV_FILE" 2>/dev/null || stat -c '%a' "$ENV_FILE")" == "600" ]]
  rm -rf "$tmp"
}

test_installed_compose_uses_source_tree_build_context() {
  local tmp rendered
  tmp="$(mktemp -d)"
  INSTALL_DIR="${tmp}/install"
  COMPOSE_FILE="${INSTALL_DIR}/compose.yml"
  mkdir -p "$INSTALL_DIR"
  REPO_ROOT="${ROOT_DIR}"
  as_root() { "$@"; }
  install_compose_file
  rendered="$(cat "$COMPOSE_FILE")"
  assert_contains "$rendered" "context: ${ROOT_DIR}" || return 1
  assert_not_contains "$rendered" 'context: ../..' || return 1
  rm -rf "$tmp"
}

test_failure_cleanup_preserves_config_and_uses_compose_down_only() {
  local tmp output status
  tmp="$(mktemp -d)"
  INSTALL_DIR="${tmp}/install"
  ENV_FILE="${INSTALL_DIR}/.env"
  mkdir -p "$INSTALL_DIR"
  printf 'POSTGRES_PASSWORD=keep-me\n' >"$ENV_FILE"
  CHANGED_STEPS=(env-created runtime-started)
  CREATED_RUNTIME=1
  compose_down_safe() { printf 'compose down called\n'; }
  output="$(on_error 2>&1)" && status=0 || status=$?
  [[ "$status" -ne 0 ]]
  assert_contains "$output" 'compose down called'
  assert_contains "$(cat "$ENV_FILE")" 'POSTGRES_PASSWORD=keep-me'
  rm -rf "$tmp"
}

test_final_url_output_points_to_first_owner_setup() {
  local tmp output
  tmp="$(mktemp -d)"
  INSTALL_DIR="${tmp}/install"
  ENV_FILE="${INSTALL_DIR}/.env"
  mkdir -p "$INSTALL_DIR"
  printf 'DEPLOYLITE_PUBLIC_HOST=203.0.113.55\n' >"$ENV_FILE"
  output="$(print_success)"
  assert_contains "$output" 'DeployLite URL: http://203.0.113.55'
  assert_contains "$output" 'create the first owner account'
  assert_contains "$output" 'No default admin credentials'
  rm -rf "$tmp"
}

run_test 'redaction masks secrets' test_redaction_masks_database_url_and_secret_assignments
run_test 'unsupported host fails before mutation' test_unsupported_host_fails_without_mutation
run_test 'occupied port fails actionably' test_occupied_port_fails_actionably
run_test 'missing Docker triggers apt install path' test_install_docker_uses_apt_when_missing
run_test 'rerun preserves existing secret' test_prepare_install_dir_preserves_existing_secret
run_test 'env generation writes private config' test_write_env_generates_once_with_private_permissions
run_test 'installed compose keeps valid build context' test_installed_compose_uses_source_tree_build_context
run_test 'failure cleanup preserves config' test_failure_cleanup_preserves_config_and_uses_compose_down_only
run_test 'final URL guides first owner setup' test_final_url_output_points_to_first_owner_setup

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
