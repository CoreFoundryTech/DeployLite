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
  output="$(redact 'DATABASE_URL=postgres://deploylite:super-secret@postgres:5432/deploylite POSTGRES_PASSWORD=hunter2 TOKEN_VALUE=abc DEPLOYLITE_AGENT_ID=00000000-0000-4000-8000-000000000001 DEPLOYLITE_AGENT_BUILDER_REGISTRY_INTEGRITY_KEY=registry-secret')"
  assert_contains "$output" 'DATABASE_URL=[REDACTED]' || return 1
  assert_contains "$output" 'POSTGRES_PASSWORD=[REDACTED]' || return 1
  assert_contains "$output" 'TOKEN_VALUE=[REDACTED]' || return 1
  assert_not_contains "$output" 'super-secret' || return 1
  assert_not_contains "$output" 'hunter2' || return 1
  assert_not_contains "$output" '00000000-0000-4000-8000-000000000001' || return 1
  assert_not_contains "$output" 'registry-secret' || return 1
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
  as_root() { calls+=("$*"); [[ "$*" == apt-get\ install* ]] && docker_ready=1; return 0; }
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
  random_secret() { printf 'generated-secret'; }
  # shellcheck disable=SC2329 # invoked dynamically by ensure_env_value
  random_uuid_v4() { printf '123e4567-e89b-42d3-a456-426614174000'; }
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
  assert_contains "$saved" 'DEPLOYLITE_REPO_ALLOWED_HOSTS=github.com'
  [[ "$(stat -f '%Lp' "$ENV_FILE" 2>/dev/null || stat -c '%a' "$ENV_FILE")" == "600" ]]
  rm -rf "$tmp"
}

test_installed_compose_uses_source_tree_build_context() {
  local tmp rendered agent_block
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
  agent_block="${rendered#*  agent:}"
  agent_block="${agent_block%%$'\n  web:'*}"
  assert_contains "$rendered" 'test -f /var/lib/deploylite/state/agent-ready' || return 1
  assert_contains "$agent_block" 'DEPLOYLITE_REPO_ALLOWED_HOSTS: ${DEPLOYLITE_REPO_ALLOWED_HOSTS:?DEPLOYLITE_REPO_ALLOWED_HOSTS is required}' || return 1
  assert_not_contains "$rendered" 'process.kill(1, 0)' || return 1
  assert_not_contains "$agent_block" 'ports:' || return 1
  rm -rf "$tmp"
}

test_prepare_install_dir_generates_required_agent_values_before_compose_preflight() {
  local tmp compose_values config_values
  tmp="$(mktemp -d)"
  INSTALL_DIR="${tmp}/install"
  COMPOSE_FILE="${INSTALL_DIR}/compose.yml"
  ENV_FILE="${INSTALL_DIR}/.env"
  STATE_DIR="${INSTALL_DIR}/.state"
  DEPLOYLITE_PUBLIC_HOST="198.51.100.10"
  as_root() { "$@"; }
  # shellcheck disable=SC2329 # invoked dynamically by ensure_env_value
  random_uuid_v4() { printf '123e4567-e89b-42d3-a456-426614174000'; }
  # Each generator call receives a unique test marker without using real entropy.
  random_secret() { local marker; marker="$(mktemp)"; rm -f "$marker"; printf 'independent-secret-%s' "${marker##*/}"; }
  prepare_install_dir >/dev/null
  compose_values="$(cat "$ENV_FILE")"
  assert_contains "$compose_values" 'DEPLOYLITE_AGENT_ID=123e4567-e89b-42d3-a456-426614174000' || { rm -rf "$tmp"; return 1; }
  assert_contains "$compose_values" 'DEPLOYLITE_AGENT_TOKEN=independent-secret-' || { rm -rf "$tmp"; return 1; }
  assert_contains "$compose_values" 'DEPLOYLITE_AGENT_BUILDER_REGISTRY_INTEGRITY_KEY=independent-secret-' || { rm -rf "$tmp"; return 1; }
  [[ "$(env_get DEPLOYLITE_AGENT_TOKEN)" != "$(env_get DEPLOYLITE_AGENT_BUILDER_REGISTRY_INTEGRITY_KEY)" ]] || { rm -rf "$tmp"; return 1; }
  compose() {
    if [[ "$*" == "config" ]]; then
      config_values="$(cat "$ENV_FILE")"
      assert_contains "$config_values" 'DEPLOYLITE_AGENT_ID=123e4567-e89b-42d3-a456-426614174000' || return 1
      assert_contains "$config_values" 'DEPLOYLITE_AGENT_TOKEN=independent-secret-' || return 1
      assert_contains "$config_values" 'DEPLOYLITE_AGENT_BUILDER_REGISTRY_INTEGRITY_KEY=independent-secret-' || return 1
      assert_contains "$config_values" 'DEPLOYLITE_REPO_ALLOWED_HOSTS=github.com' || return 1
    fi
  }
  start_runtime
  rm -rf "$tmp"
}

test_prepare_install_dir_preserves_existing_agent_values_on_rerun() {
  local tmp saved
  tmp="$(mktemp -d)"
  INSTALL_DIR="${tmp}/install"
  COMPOSE_FILE="${INSTALL_DIR}/compose.yml"
  ENV_FILE="${INSTALL_DIR}/.env"
  STATE_DIR="${INSTALL_DIR}/.state"
  mkdir -p "$INSTALL_DIR"
  cat >"$ENV_FILE" <<'EOF'
POSTGRES_PASSWORD=existing-postgres
DEPLOYLITE_SECRET_KEY=existing-api-key
DEPLOYLITE_AGENT_ID=123e4567-e89b-42d3-a456-426614174000
DEPLOYLITE_AGENT_TOKEN=existing-agent-token
DEPLOYLITE_AGENT_BUILDER_REGISTRY_INTEGRITY_KEY=existing-registry-key
EOF
  as_root() { "$@"; }
  random_secret() { printf 'must-not-be-generated'; }
  # shellcheck disable=SC2329 # invoked dynamically by ensure_env_value
  random_uuid_v4() { printf 'must-not-be-generated'; }
  prepare_install_dir >/dev/null
  saved="$(cat "$ENV_FILE")"
  assert_contains "$saved" 'DEPLOYLITE_AGENT_TOKEN=existing-agent-token' || { rm -rf "$tmp"; return 1; }
  assert_contains "$saved" 'DEPLOYLITE_AGENT_BUILDER_REGISTRY_INTEGRITY_KEY=existing-registry-key' || { rm -rf "$tmp"; return 1; }
  assert_contains "$saved" 'DEPLOYLITE_REPO_ALLOWED_HOSTS=github.com' || { rm -rf "$tmp"; return 1; }
  assert_not_contains "$saved" 'must-not-be-generated' || { rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
}

test_runtime_starts_agent_after_config_preflight() {
  local calls=() tmp_runtime
  compose() {
    calls+=("$*")
    if [[ "$*" == "config" ]]; then
      assert_contains "$(cat "$ENV_FILE")" 'DEPLOYLITE_AGENT_ID=123e4567-e89b-42d3-a456-426614174000' || return 1
    fi
  }
  tmp_runtime="$(mktemp -d)"
  ENV_FILE="${tmp_runtime}/.env"
  printf 'DEPLOYLITE_AGENT_ID=123e4567-e89b-42d3-a456-426614174000\n' >"$ENV_FILE"
  start_runtime
  [[ "${calls[0]}" == "config" ]] || { rm -rf "$tmp_runtime"; return 1; }
  [[ " ${calls[*]} " == *" up -d --build api web agent "* ]] || { rm -rf "$tmp_runtime"; return 1; }
  rm -rf "$tmp_runtime"
}

test_missing_or_empty_repository_allowlist_fails_during_compose_preflight() {
  local rendered agent_block
  rendered="$(cat "${ROOT_DIR}/infra/vps/compose.yml")"
  agent_block="${rendered#*  agent:}"
  agent_block="${agent_block%%$'\n  web:'*}"
  assert_contains "$agent_block" 'DEPLOYLITE_REPO_ALLOWED_HOSTS: ${DEPLOYLITE_REPO_ALLOWED_HOSTS:?DEPLOYLITE_REPO_ALLOWED_HOSTS is required}' || return 1
  [[ "${agent_block%%healthcheck:*}" == *'DEPLOYLITE_REPO_ALLOWED_HOSTS:'* ]] || return 1
}

test_agent_health_failure_is_nonzero_and_redacts_diagnostics() {
  local output status calls_file
  calls_file="$(mktemp)"
  wait_for_url() { :; }
  compose() {
    printf '%s\n' "$*" >>"$calls_file"
    if [[ "$*" == logs* ]]; then
      printf 'DEPLOYLITE_AGENT_TOKEN=agent-token-value DEPLOYLITE_AGENT_BUILDER_REGISTRY_INTEGRITY_KEY=registry-key-value\n'
      return 0
    fi
    return 1
  }
  output="$(wait_for_health 2>&1)" && status=0 || status=$?
  [[ "$status" -ne 0 ]] || return 1
  assert_contains "$output" 'Agent startup failed' || return 1
  assert_contains "$output" '[REDACTED]' || return 1
  assert_not_contains "$output" 'agent-token-value' || return 1
  assert_not_contains "$output" 'registry-key-value' || return 1
  grep -Fqx 'up -d --wait --wait-timeout 150 agent' "$calls_file" || { rm -f "$calls_file"; return 1; }
  rm -f "$calls_file"
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

test_write_env_uses_prompted_public_host_in_interactive_mode() {
  local tmp saved
  tmp="$(mktemp -d)"
  INSTALL_DIR="${tmp}/install"
  ENV_FILE="${INSTALL_DIR}/.env"
  mkdir -p "$INSTALL_DIR"
  # Provide a default via env so detect_public_host_inner returns it.
  DEPLOYLITE_PUBLIC_HOST="198.51.100.10"
  INTERACTIVE=1
  as_root() { "$@"; }
  random_secret() { printf 'generated-secret'; }
  # Pipe an override value; the function must use it in the env file.
  write_env <<<'203.0.113.99'
  saved="$(cat "$ENV_FILE")"
  assert_contains "$saved" 'DEPLOYLITE_PUBLIC_HOST=203.0.113.99' || { printf 'expected prompted host, got: %s\n' "$saved"; rm -rf "$tmp"; return 1; }
  assert_contains "$saved" 'DEPLOYLITE_PUBLIC_WEB_ORIGIN=http://203.0.113.99' || { printf 'expected web origin, got: %s\n' "$saved"; rm -rf "$tmp"; return 1; }
  assert_contains "$saved" 'DEPLOYLITE_PUBLIC_API_ORIGIN=http://203.0.113.99:3001' || { printf 'expected api origin, got: %s\n' "$saved"; rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
}

test_write_env_in_interactive_mode_uses_empty_default_when_detection_fails() {
  local tmp saved
  tmp="$(mktemp -d)"
  INSTALL_DIR="${tmp}/install"
  ENV_FILE="${INSTALL_DIR}/.env"
  mkdir -p "$INSTALL_DIR"
  unset DEPLOYLITE_PUBLIC_HOST
  INTERACTIVE=1
  as_root() { "$@"; }
  random_secret() { printf 'generated-secret'; }
  # Stub detect_public_host_inner to return empty (no network, no env).
  detect_public_host_inner() { :; }
  # Provide a value via the prompt.
  write_env <<<'198.51.100.42'
  saved="$(cat "$ENV_FILE")"
  assert_contains "$saved" 'DEPLOYLITE_PUBLIC_HOST=198.51.100.42' || { printf 'expected prompted host with empty default, got: %s\n' "$saved"; rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
}

test_write_env_in_noninteractive_mode_hard_fails_when_no_host() {
  local tmp status fail_called=0
  tmp="$(mktemp -d)"
  INSTALL_DIR="${tmp}/install"
  ENV_FILE="${INSTALL_DIR}/.env"
  mkdir -p "$INSTALL_DIR"
  unset DEPLOYLITE_PUBLIC_HOST
  INTERACTIVE=0
  as_root() { "$@"; }
  random_secret() { printf 'generated-secret'; }
  # Stub detect_public_host to return empty (simulating a host that
  # cannot be detected) WITHOUT calling the real fail() — that would
  # exit the test runner. The hard-fail path in write_env must then
  # call fail() itself. We stub fail() to record the call and return
  # a non-zero status instead of exiting; the real fail() would call
  # exit, which is the behavior we are exercising the guard for.
  detect_public_host() { :; }
  fail() { fail_called=1; return 2; }
  set +e
  write_env >/dev/null 2>&1
  status=$?
  set -e
  [[ "$fail_called" -eq 1 ]] || { printf 'expected fail() to be called when no host available, got status=%s fail_called=%s\n' "$status" "$fail_called"; rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
}

run_test 'redaction masks secrets' test_redaction_masks_database_url_and_secret_assignments
run_test 'unsupported host fails before mutation' test_unsupported_host_fails_without_mutation
run_test 'occupied port fails actionably' test_occupied_port_fails_actionably
run_test 'missing Docker triggers Docker apt repository install path' test_install_docker_uses_docker_apt_repo_when_missing
run_test 'rerun preserves existing secret' test_prepare_install_dir_preserves_existing_secret
run_test 'env generation writes private config' test_write_env_generates_once_with_private_permissions
run_test 'installed compose keeps valid build context' test_installed_compose_uses_source_tree_build_context
run_test 'fresh install generates agent values before compose preflight' test_prepare_install_dir_generates_required_agent_values_before_compose_preflight
run_test 'rerun preserves existing agent values' test_prepare_install_dir_preserves_existing_agent_values_on_rerun
run_test 'runtime starts agent after config preflight' test_runtime_starts_agent_after_config_preflight
run_test 'missing repository allowlist fails before agent readiness' test_missing_or_empty_repository_allowlist_fails_during_compose_preflight
run_test 'agent health failure is surfaced with redacted diagnostics' test_agent_health_failure_is_nonzero_and_redacts_diagnostics
run_test 'failure cleanup preserves config' test_failure_cleanup_preserves_config_and_uses_compose_down_only
run_test 'final URL guides first owner setup' test_final_url_output_points_to_first_owner_setup
run_test 'prompt_value returns default in noninteractive mode' test_prompt_value_returns_default_in_noninteractive_mode
run_test 'prompt_value returns piped value in interactive no-tty mode' test_prompt_value_returns_piped_value_in_interactive_no_tty_mode
run_test 'prompt_value returns default when piped empty in interactive no-tty mode' test_prompt_value_returns_default_when_piped_empty_in_interactive_no_tty_mode
run_test 'redact_stream removes postgres passwords and key=value secrets' test_redact_stream_removes_postgres_passwords_and_key_value_secrets
run_test 'write_env uses prompted public host in interactive mode' test_write_env_uses_prompted_public_host_in_interactive_mode
run_test 'write_env in interactive mode uses empty default when detection fails' test_write_env_in_interactive_mode_uses_empty_default_when_detection_fails
run_test 'write_env in noninteractive mode hard-fails when no host' test_write_env_in_noninteractive_mode_hard_fails_when_no_host

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
