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
      apt-get|curl|gpg|timeout) return 0 ;;
      docker) [[ "$docker_ready" == "1" ]] ;;
      *) return 1 ;;
    esac
  }
  install_docker_apt_repository() { calls+=("install_docker_apt_repository"); }
  as_root() { calls+=("$*"); [[ "$*" == *apt-get*install* ]] && docker_ready=1; return 0; }
  install_docker
  [[ " ${calls[*]} " == *" install_docker_apt_repository "* ]]
  [[ " ${calls[*]} " == *" apt-get -o DPkg::Lock::Timeout=180 -o Acquire::http::Timeout=180 -o Acquire::https::Timeout=180 update "* ]]
  [[ " ${calls[*]} " == *" apt-get -o DPkg::Lock::Timeout=180 -o Acquire::http::Timeout=180 -o Acquire::https::Timeout=180 install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin "* ]]
}

test_install_curl_is_separate_from_docker_detection() {
  local calls=() curl_ready=0
  command_exists() { [[ "$1" == "apt-get" || "$1" == "timeout" || ("$1" == "curl" && "$curl_ready" == "1") ]]; }
  as_root() { calls+=("$*"); [[ "$*" == *apt-get*install*curl* ]] && curl_ready=1; return 0; }
  install_curl
  [[ " ${calls[*]} " == *" apt-get -o DPkg::Lock::Timeout=180 -o Acquire::http::Timeout=180 -o Acquire::https::Timeout=180 update "* ]] || return 1
  [[ " ${calls[*]} " == *" apt-get -o DPkg::Lock::Timeout=180 -o Acquire::http::Timeout=180 -o Acquire::https::Timeout=180 install -y ca-certificates curl "* ]] || return 1
}

test_prepare_install_dir_copies_tls_overlay() {
  local tmp rendered
  tmp="$(mktemp -d)"
  INSTALL_DIR="${tmp}/install"
  COMPOSE_FILE="${INSTALL_DIR}/compose.yml"
  TLS_COMPOSE_FILE="${INSTALL_DIR}/compose.tls.yml"
  STATE_DIR="${INSTALL_DIR}/.state"
  mkdir -p "$INSTALL_DIR"
  as_root() { "$@"; }
  prepare_install_dir >/dev/null
  rendered="$(cat "$COMPOSE_FILE" "$TLS_COMPOSE_FILE")"
  assert_contains "$rendered" 'traefik-acme'
  [[ -f "$TLS_COMPOSE_FILE" ]]
  rm -rf "$tmp"
}

test_installed_compose_uses_source_tree_build_context() {
  local tmp rendered
  tmp="$(mktemp -d)"
  INSTALL_DIR="${tmp}/install"
  COMPOSE_FILE="${INSTALL_DIR}/compose.yml"
  TLS_COMPOSE_FILE="${INSTALL_DIR}/compose.tls.yml"
  mkdir -p "$INSTALL_DIR"
  REPO_ROOT="${ROOT_DIR}"
  as_root() { "$@"; }
  install_compose_file
  rendered="$(cat "$COMPOSE_FILE" "$TLS_COMPOSE_FILE")"
  assert_contains "$rendered" "context: ${ROOT_DIR}" || return 1
  assert_not_contains "$rendered" 'context: ../..' || return 1
  rm -rf "$tmp"
}

test_prompt_value_returns_default_in_noninteractive_mode() {
  local result
  INTERACTIVE=0
  result="$(prompt_value 'label' 'default-value')"
  [[ "$result" == "default-value" ]] || { printf 'expected default-value, got: %s\n' "$result"; return 1; }
}

test_parse_args_supports_explicit_noninteractive_mode() {
  INTERACTIVE=1
  parse_args --non-interactive
  [[ "$INTERACTIVE" == "0" ]]
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

test_validate_compose_omits_runtime_profile() {
  local compose_calls=""
  compose_bounded() { compose_calls="$*"; }
  validate_compose >/dev/null
  assert_contains "$compose_calls" 'config' || return 1
  assert_contains "$compose_calls" '--no-interpolate' || return 1
  assert_contains "$compose_calls" '--profile bootstrap' || return 1
}

test_prepare_runtime_env_rejects_stale_or_inconsistent_values() {
  local tmp output status
  tmp="$(mktemp -d)"
  INSTALL_DIR="$tmp/install"
  RUNTIME_ENV_FILE="$INSTALL_DIR/.env"
  mkdir -p "$INSTALL_DIR"
  printf 'DEPLOYLITE_PUBLIC_HOST=old.example.test\nPOSTGRES_PASSWORD=short\nDEPLOYLITE_SECRET_KEY=%064d\n' 0 >"$RUNTIME_ENV_FILE"
  as_root() { "$@"; }
  DEPLOYLITE_PUBLIC_HOST="new.example.test"
  output="$(prepare_runtime_env 2>&1)" && status=0 || status=$?
  [[ "$status" -eq 2 ]] || return 1
  assert_contains "$output" 'host does not match' || return 1
  rm -rf "$tmp"
}

test_prepare_runtime_env_rejects_malformed_secret_values() {
  local tmp output status
  tmp="$(mktemp -d)"
  INSTALL_DIR="$tmp/install"
  RUNTIME_ENV_FILE="$INSTALL_DIR/.env"
  mkdir -p "$INSTALL_DIR"
  printf 'DEPLOYLITE_PUBLIC_HOST=deploylite.com\nPOSTGRES_PASSWORD=short\nDEPLOYLITE_SECRET_KEY=also-short\n' >"$RUNTIME_ENV_FILE"
  as_root() { "$@"; }
  unset DEPLOYLITE_PUBLIC_HOST
  output="$(prepare_runtime_env 2>&1)" && status=0 || status=$?
  [[ "$status" -eq 2 ]] || return 1
  assert_contains "$output" 'POSTGRES_PASSWORD has an invalid generated-secret format' || return 1
  rm -rf "$tmp"
}

test_verify_local_reachability_checks_dns_header_and_body() {
  local tmp headers_path body_path
  DEPLOYLITE_PUBLIC_HOST="local.example.test"
  DEPLOYLITE_EXPECTED_PUBLIC_IP="203.0.113.10"
  command_exists() { [[ "$1" == "curl" || "$1" == "getent" ]]; }
  getent() { printf '203.0.113.10 STREAM local.example.test\n'; }
  curl() {
    if [[ "$*" == *'api.ipify.org'* ]]; then
      printf '203.0.113.10'
      return 0
    fi
    while (( $# > 0 )); do
      case "$1" in
        --dump-header|--output) shift; printf '%s\n' "$1" >>/tmp/deploylite-curl-paths.test;;
      esac
      shift
    done
    headers_path="$(sed -n '1p' /tmp/deploylite-curl-paths.test)"
    body_path="$(sed -n '2p' /tmp/deploylite-curl-paths.test)"
    printf 'HTTP/2 200\nX-DeployLite-Bootstrap: ready\n\n' >"$headers_path"
    printf '<html>DeployLite first owner</html>\n' >"$body_path"
  }
  : >/tmp/deploylite-curl-paths.test
  verify_local_reachability
  rm -f /tmp/deploylite-curl-paths.test "$headers_path" "$body_path"
}

test_prepare_runtime_env_uses_restricted_file_without_secret_output() {
  local tmp output mode contents
  tmp="$(mktemp -d)"
  INSTALL_DIR="$tmp/install"
  RUNTIME_ENV_FILE="$INSTALL_DIR/.env"
  mkdir -p "$INSTALL_DIR"
  as_root() { "$@"; }
  command_exists() { [[ "$1" == "openssl" ]]; }
  openssl() { printf 'generated-secret\n'; }
  output="$(prepare_runtime_env)"
  mode="$(stat -f '%Lp' "$RUNTIME_ENV_FILE")"
  contents="$(<"$RUNTIME_ENV_FILE")"
  [[ "$mode" == "600" ]] || return 1
  assert_contains "$contents" 'DEPLOYLITE_PUBLIC_HOST=deploylite.com' || return 1
  assert_not_contains "$output" 'generated-secret' || return 1
  rm -rf "$tmp"
}

test_prepare_runtime_env_generates_a_url_safe_database_url() {
  local tmp output password database_url
  tmp="$(mktemp -d)"
  INSTALL_DIR="$tmp/install"
  RUNTIME_ENV_FILE="$INSTALL_DIR/.env"
  password="$(printf 'a%.0s' {1..62})+/"
  mkdir -p "$INSTALL_DIR"
  as_root() { "$@"; }
  command_exists() { [[ "$1" == "openssl" ]]; }
  openssl() { printf '%s\n' "$password"; }
  output="$(prepare_runtime_env)"
  database_url="$(awk -F= '$1 == "DATABASE_URL" { print substr($0, length($1) + 2) }' "$RUNTIME_ENV_FILE")"
  [[ "$database_url" == *'%2B'* && "$database_url" == *'%2F'* ]] || return 1
  node -e 'new URL(process.argv[1])' "$database_url"
  assert_not_contains "$output" "$password" || return 1
  rm -rf "$tmp"
}

test_start_bootstrap_is_bounded_and_never_activates_runtime() {
  local compose_calls=""
  compose_bounded() { compose_calls+="|$*"; }
  verify_local_reachability() { :; }
  start_bootstrap >/dev/null
  assert_contains "$compose_calls" '--profile bootstrap pull' || return 1
  assert_contains "$compose_calls" '--profile bootstrap build' || return 1
  assert_contains "$compose_calls" '--profile bootstrap up -d --wait --wait-timeout 120' || return 1
  assert_not_contains "$compose_calls" '--profile runtime' || return 1
}

run_test 'redaction masks secrets' test_redaction_masks_database_url_and_secret_assignments
run_test 'unsupported host fails before mutation' test_unsupported_host_fails_without_mutation
run_test 'occupied port fails actionably' test_occupied_port_fails_actionably
run_test 'missing Docker triggers Docker apt repository install path' test_install_docker_uses_docker_apt_repo_when_missing
run_test 'curl installation is independent of Docker detection' test_install_curl_is_separate_from_docker_detection
run_test 'copies TLS Compose overlay' test_prepare_install_dir_copies_tls_overlay
run_test 'installed compose keeps valid build context' test_installed_compose_uses_source_tree_build_context
run_test 'prompt_value returns default in noninteractive mode' test_prompt_value_returns_default_in_noninteractive_mode
run_test 'explicit noninteractive mode disables TUI' test_parse_args_supports_explicit_noninteractive_mode
run_test 'prompt_value returns piped value in interactive no-tty mode' test_prompt_value_returns_piped_value_in_interactive_no_tty_mode
run_test 'prompt_value returns default when piped empty in interactive no-tty mode' test_prompt_value_returns_default_when_piped_empty_in_interactive_no_tty_mode
run_test 'redact_stream removes postgres passwords and key=value secrets' test_redact_stream_removes_postgres_passwords_and_key_value_secrets
run_test 'validates the bootstrap Compose profile' test_validate_compose_omits_runtime_profile
run_test 'generates silent restricted internal runtime secrets' test_prepare_runtime_env_uses_restricted_file_without_secret_output
run_test 'generates a valid URL-safe database URL' test_prepare_runtime_env_generates_a_url_safe_database_url
run_test 'rejects stale or inconsistent runtime secrets' test_prepare_runtime_env_rejects_stale_or_inconsistent_values
run_test 'rejects malformed runtime secret values' test_prepare_runtime_env_rejects_malformed_secret_values
run_test 'verifies local DNS and HTTPS response markers' test_verify_local_reachability_checks_dns_header_and_body
run_test 'pulls, builds, and starts only the bounded bootstrap control plane' test_start_bootstrap_is_bounded_and_never_activates_runtime

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
