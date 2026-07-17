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
  command_exists() { [[ "$1" == "sudo" || "$1" == "timeout" ]]; }
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
  command_exists() { [[ "$1" == "sudo" || "$1" == "timeout" ]]; }
  port_available() { [[ "$1" != "80" ]]; }
  output="$(preflight 2>&1)" && status=0 || status=$?
  [[ "$status" -eq 2 ]]
  assert_contains "$output" 'Port 80 is already in use'
}

test_install_docker_uses_docker_apt_repo_when_missing() {
  local calls=() docker_ready=0
  command_exists() {
    case "$1" in
      apt-get|curl|gpg) return 0 ;;
      docker) [[ "$docker_ready" == "1" ]] ;;
      *) return 1 ;;
    esac
  }
  install_docker_apt_repository() { calls+=("install_docker_apt_repository"); }
  as_root() { calls+=("$*"); [[ "$*" == *"apt-get install"* ]] && docker_ready=1; return 0; }
  install_docker
  [[ " ${calls[*]} " == *" install_docker_apt_repository "* ]]
  [[ " ${calls[*]} " == *" apt-get update "* ]]
  [[ " ${calls[*]} " == *" apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin "* ]]
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

test_write_env_generates_runtime_secrets_without_business_configuration() {
  local tmp saved
  tmp="$(mktemp -d)"
  INSTALL_DIR="${tmp}/install"
  ENV_FILE="${INSTALL_DIR}/.env"
  mkdir -p "$INSTALL_DIR"
  as_root() { "$@"; }
  random_secret() { printf 'generated-secret'; }
  write_env
  saved="$(cat "$ENV_FILE")"
  assert_contains "$saved" 'POSTGRES_PASSWORD=generated-secret'
  assert_contains "$saved" 'DEPLOYLITE_SECRET_KEY=generated-secret'
  assert_not_contains "$saved" 'DEPLOYLITE_SESSION_COOKIE_SECURE='
  assert_not_contains "$saved" 'DEPLOYLITE_DOMAIN='
  assert_not_contains "$saved" 'DEPLOYLITE_ACME_EMAIL='
  [[ "$(stat -f '%Lp' "$ENV_FILE" 2>/dev/null || stat -c '%a' "$ENV_FILE")" == "600" ]]
  rm -rf "$tmp"
}

test_base_compose_requires_runtime_profile_and_secure_cookies() {
  local compose
  compose="$(cat "${ROOT_DIR}/infra/vps/compose.yml")"
  assert_contains "$compose" 'profiles: [runtime]' || return 1
  assert_contains "$compose" 'DEPLOYLITE_SESSION_COOKIE_SECURE: "true"' || return 1
  assert_not_contains "$compose" "DEPLOYLITE_SESSION_COOKIE_SECURE: \${DEPLOYLITE_SESSION_COOKIE_SECURE:-false}" || return 1
}

test_tls_overlay_keeps_websecure_routes() {
  local overlay
  overlay="$(cat "${ROOT_DIR}/infra/vps/compose.tls.yml")"
  assert_contains "$overlay" 'deploylite-api-tls.entrypoints=websecure' || return 1
  assert_contains "$overlay" 'deploylite-web-tls.entrypoints=websecure' || return 1
  assert_contains "$overlay" 'certificatesresolvers.letsencrypt.acme' || return 1
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

test_success_output_defers_business_configuration_to_web() {
  local tmp output
  tmp="$(mktemp -d)"
  INSTALL_DIR="${tmp}/install"
  ENV_FILE="${INSTALL_DIR}/.env"
  mkdir -p "$INSTALL_DIR"
  output="$(print_success)"
  assert_contains "$output" 'No application, domain, or ACME configuration was requested.'
  rm -rf "$tmp"
}

test_prompt_value_returns_default_in_noninteractive_mode() {
  local result
  INTERACTIVE=0
  result="$(prompt_value 'label' 'default-value')"
  [[ "$result" == "default-value" ]] || { printf 'expected default-value, got: %s\n' "$result"; return 1; }
}

test_prompt_value_returns_piped_value_in_interactive_no_tty_mode() {
  local result
  INTERACTIVE=1
  # No tty (heredoc), so the function falls through to the non-tty
  # stdin branch and reads the next line. The default is still
  # reported as a fallback if the piped line is empty.
  result="$(prompt_value 'label' 'default-value' <<<'piped-value')"
  [[ "$result" == "piped-value" ]] || { printf 'expected piped-value, got: %s\n' "$result"; return 1; }
}

test_prompt_value_returns_default_when_piped_empty_in_interactive_no_tty_mode() {
  local result
  INTERACTIVE=1
  result="$(prompt_value 'label' 'default-value' <<<'')"
  [[ "$result" == "default-value" ]] || { printf 'expected default-value, got: %s\n' "$result"; return 1; }
}

test_redact_stream_removes_postgres_passwords_and_key_value_secrets() {
  local output
  # The stream-level filter applies the same two-pass rewrite as the
  # value-based redact(): the postgres URL pass redacts the password
  # segment, then the KEY=VALUE pass redacts the entire DATABASE_URL
  # value. The end state must have [REDACTED] markers and no raw
  # secrets. The exact replacement shape matches the value-based
  # redact() so a single redaction contract covers both call sites.
  output="$(printf 'DATABASE_URL=postgres://deploylite:top-secret@postgres:5432/deploylite\nPOSTGRES_PASSWORD=hunter2\nTOKEN_VALUE=xyz\nplain line\n' | redact_stream)"
  assert_contains "$output" 'DATABASE_URL=[REDACTED]' || { printf 'missing redacted DB URL: %s\n' "$output"; return 1; }
  assert_contains "$output" 'POSTGRES_PASSWORD=[REDACTED]' || { printf 'missing redacted POSTGRES_PASSWORD: %s\n' "$output"; return 1; }
  assert_contains "$output" 'TOKEN_VALUE=[REDACTED]' || { printf 'missing redacted TOKEN_VALUE: %s\n' "$output"; return 1; }
  assert_not_contains "$output" 'top-secret' || { printf 'raw postgres password leaked: %s\n' "$output"; return 1; }
  assert_not_contains "$output" 'hunter2' || { printf 'raw POSTGRES_PASSWORD leaked: %s\n' "$output"; return 1; }
  assert_contains "$output" 'plain line' || { printf 'plain line lost in stream: %s\n' "$output"; return 1; }
}

run_test 'redaction masks secrets' test_redaction_masks_database_url_and_secret_assignments
run_test 'unsupported host fails before mutation' test_unsupported_host_fails_without_mutation
run_test 'occupied port fails actionably' test_occupied_port_fails_actionably
run_test 'missing Docker triggers Docker apt repository install path' test_install_docker_uses_docker_apt_repo_when_missing
run_test 'rerun preserves existing secret' test_prepare_install_dir_preserves_existing_secret
run_test 'env generation writes only runtime secrets' test_write_env_generates_runtime_secrets_without_business_configuration
run_test 'base compose gates runtime and secure cookies' test_base_compose_requires_runtime_profile_and_secure_cookies
run_test 'TLS overlay retains secure routes' test_tls_overlay_keeps_websecure_routes
run_test 'installed compose keeps valid build context' test_installed_compose_uses_source_tree_build_context
run_test 'failure cleanup preserves config' test_failure_cleanup_preserves_config_and_uses_compose_down_only
run_test 'success output defers business configuration to web' test_success_output_defers_business_configuration_to_web
run_test 'prompt_value returns default in noninteractive mode' test_prompt_value_returns_default_in_noninteractive_mode
run_test 'prompt_value returns piped value in interactive no-tty mode' test_prompt_value_returns_piped_value_in_interactive_no_tty_mode
run_test 'prompt_value returns default when piped empty in interactive no-tty mode' test_prompt_value_returns_default_when_piped_empty_in_interactive_no_tty_mode
run_test 'redact_stream removes postgres passwords and key=value secrets' test_redact_stream_removes_postgres_passwords_and_key_value_secrets

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
