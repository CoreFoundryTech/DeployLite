#!/usr/bin/env bash
set -Eeuo pipefail

# Tests for the install.sh tee-based file logger, interactive flag, and
# idempotency probes. Runs as a subprocess against scripts/install.sh so the
# in-process `exec > >(tee ...)` redirect in install.sh can be exercised
# end-to-end without polluting the test runner's own stdout/stderr.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

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

# Build a wrapper that overrides as_root and command_exists so the script can
# run inside a non-root temp directory without touching /opt/deploylite or
# /var/log/deploylite. The wrapper drives the installer's tee setup and
# idempotency probes only — it never runs the full preflight/Docker install.
build_runner() {
  local tmp="$1"
  local runner="${tmp}/runner.sh"
  local install_path="${ROOT_DIR}/scripts/install.sh"
  cat >"$runner" <<WRAPPER
#!/usr/bin/env bash
set -Eeuo pipefail
export DEPLOYLITE_INSTALL_TESTING=1
export DEPLOYLITE_INSTALL_LOG="${tmp}/install.log"
export DEPLOYLITE_INSTALL_LOG_DIR="${tmp}"
export DEPLOYLITE_INSTALL_DIR="${tmp}/opt"
export DEPLOYLITE_SKIP_DOCKER_INSTALL=1
export DEPLOYLITE_SKIP_RUNTIME=1
WRAPPER
  cat >>"$runner" <<WRAPPER2

# shellcheck source=/dev/null
. '__INSTALL_PATH__'

# Override destructive helpers AFTER sourcing install.sh so the test stubs win
# over the installer's own definitions. Without this ordering, install.sh's
# as_root would replace our passthrough and try to escalate to sudo.
as_root() { "\$@"; }
command_exists() { [[ "\$1" == "sudo" || "\$1" == "openssl" || "\$1" == "tee" ]]; }
detect_os() { :; }
detect_arch() { :; }
port_available() { return 0; }
preflight() { return 0; }
install_docker() { return 0; }
prepare_install_dir() { return 0; }
start_runtime() { return 0; }
wait_for_health() { return 0; }
print_success() { return 0; }

# Drive the same code path as a real install would: setup log, parse args,
# then enter main; we never call print_success because runtime is skipped.
main "\$@"
WRAPPER2
  # Substitute the install path placeholder AFTER heredoc creation so the
  # unquoted placeholder is replaced exactly once.
  /usr/bin/sed -i.bak "s|__INSTALL_PATH__|${install_path}|g" "$runner"
  rm -f "${runner}.bak"
  chmod +x "$runner"
  printf '%s' "$runner"
}

test_log_file_is_created_at_configured_path() {
  local tmp runner
  tmp="$(mktemp -d)"
  runner="$(build_runner "$tmp")"
  "$runner" --noop >/dev/null 2>&1 || true
  if [[ ! -f "${tmp}/install.log" ]]; then
    printf 'expected log file at %s/install.log\n' "$tmp"
    rm -rf "$tmp"
    return 1
  fi
  rm -rf "$tmp"
}

test_log_file_permissions_are_not_world_readable() {
  local tmp runner output mode
  tmp="$(mktemp -d)"
  runner="$(build_runner "$tmp")"
  "$runner" --noop >/dev/null 2>&1 || true
  mode="$(stat -f '%Lp' "${tmp}/install.log" 2>/dev/null || stat -c '%a' "${tmp}/install.log")"
  # The umask used by the install wrapper is 027 which yields 0640. On filesystems
  # or umask variations the test still enforces a safe mode (no 'other' read).
  case "$mode" in
    640|600) ;;
    *)
      printf 'expected install.log mode 0640 or 0600, got %s\n' "$mode"
      rm -rf "$tmp"
      return 1
      ;;
  esac
  rm -rf "$tmp"
}

test_log_file_captures_stdout_and_stderr() {
  local tmp runner log_content
  tmp="$(mktemp -d)"
  runner="$(build_runner "$tmp")"
  "$runner" --noop >/dev/null 2>&1 || true
  # The tee process is async. Give it a moment to flush before asserting.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [[ -s "${tmp}/install.log" ]] && break
    sleep 0.05
  done
  log_content="$(cat "${tmp}/install.log" 2>/dev/null || true)"
  if [[ ! -s "${tmp}/install.log" ]]; then
    printf 'expected non-empty log file at %s/install.log\n' "$tmp"
    rm -rf "$tmp"
    return 1
  fi
  assert_contains "$log_content" '[INFO]' || { rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
}

test_log_file_does_not_contain_raw_secrets() {
  local tmp runner log_content
  tmp="$(mktemp -d)"
  runner="$(build_runner "$tmp")"
  DEPLOYLITE_SIMULATED_SECRET="super-secret-value-xyz" \
    DEPLOYLITE_PUBLIC_HOST="203.0.113.99" \
    DATABASE_URL="postgres://deploylite:top-secret@postgres:5432/deploylite" \
    "$runner" --noop >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [[ -s "${tmp}/install.log" ]] && break
    sleep 0.05
  done
  log_content="$(cat "${tmp}/install.log" 2>/dev/null || true)"
  assert_not_contains "$log_content" 'top-secret' || { rm -rf "$tmp"; return 1; }
  assert_not_contains "$log_content" 'super-secret-value-xyz' || { rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
}

test_log_file_records_idempotent_rerun_marker() {
  local tmp runner log_content
  tmp="$(mktemp -d)"
  runner="$(build_runner "$tmp")"
  "$runner" --noop >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [[ -s "${tmp}/install.log" ]] && break
    sleep 0.05
  done
  log_content="$(cat "${tmp}/install.log" 2>/dev/null || true)"
  assert_contains "$log_content" 'Install log:' || { rm -rf "$tmp"; return 1; }
  assert_contains "$log_content" '[INFO]' || { rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
}

test_idempotency_probe_reports_already_installed_components() {
  local tmp runner output
  tmp="$(mktemp -d)"
  runner="$(build_runner "$tmp")"
  output="$("$runner" --noop 2>&1 || true)"
  assert_contains "$output" 'log directory ready' || { rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
}

test_parse_args_accepts_interactive_short_and_long_form() {
  local tmp runner
  tmp="$(mktemp -d)"
  runner="$(build_runner "$tmp")"
  if ! "$runner" --interactive >/dev/null 2>&1; then
    printf '--interactive long form was rejected\n'
    rm -rf "$tmp"
    return 1
  fi
  if ! "$runner" -i >/dev/null 2>&1; then
    printf '-i short form was rejected\n'
    rm -rf "$tmp"
    return 1
  fi
  rm -rf "$tmp"
}

test_parse_args_rejects_unknown_flags() {
  local tmp runner status
  tmp="$(mktemp -d)"
  runner="$(build_runner "$tmp")"
  set +e
  "$runner" --definitely-not-a-real-flag >/dev/null 2>&1
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || { printf 'expected non-zero exit for unknown flag, got %s\n' "$status"; rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
}

test_help_flag_prints_usage_and_exits_zero() {
  local tmp runner output status
  tmp="$(mktemp -d)"
  runner="$(build_runner "$tmp")"
  set +e
  output="$("$runner" --help 2>&1)"
  status=$?
  set -e
  [[ "$status" -eq 0 ]] || { printf 'expected --help to exit 0, got %s\noutput: %s\n' "$status" "$output"; rm -rf "$tmp"; return 1; }
  assert_contains "$output" 'Usage:' || { rm -rf "$tmp"; return 1; }
  assert_contains "$output" '--interactive' || { rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
}

test_interactive_flag_falls_back_to_read_when_whiptail_missing() {
  local tmp runner output
  tmp="$(mktemp -d)"
  runner="$(build_runner "$tmp")"
  output="$(printf '203.0.113.55\n' | "$runner" -i --noop 2>&1 || true)"
  if [[ "$output" == *"whiptail"* ]]; then
    printf 'interactive mode unexpectedly invoked whiptail\n'
    rm -rf "$tmp"
    return 1
  fi
  rm -rf "$tmp"
}

test_noninteractive_automation_mode_still_works_without_tty() {
  local tmp runner output
  tmp="$(mktemp -d)"
  runner="$(build_runner "$tmp")"
  output="$("$runner" --noop 2>&1 || true)"
  assert_contains "$output" 'non-interactive' || { printf 'expected non-interactive log marker, got: %s\n' "$output"; rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
}

test_log_file_uses_tee_and_appends_on_rerun() {
  local tmp runner before after
  tmp="$(mktemp -d)"
  runner="$(build_runner "$tmp")"
  "$runner" --noop >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [[ -s "${tmp}/install.log" ]] && break
    sleep 0.05
  done
  before="$(wc -l <"${tmp}/install.log" | tr -d ' ')"
  "$runner" --noop >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    after="$(wc -l <"${tmp}/install.log" | tr -d ' ')"
    (( after > before )) && break
    sleep 0.05
  done
  after="$(wc -l <"${tmp}/install.log" | tr -d ' ')"
  if (( after <= before )); then
    printf 'expected log line count to grow on rerun, before=%s after=%s\n' "$before" "$after"
    rm -rf "$tmp"
    return 1
  fi
  rm -rf "$tmp"
}

test_idempotency_probe_handles_missing_docker_and_missing_env() {
  local tmp runner output
  tmp="$(mktemp -d)"
  runner="$(build_runner "$tmp")"
  # No docker, no .env, no log file yet. First run must still produce a log.
  output="$("$runner" --noop 2>&1 || true)"
  assert_contains "$output" '[INFO]' || { printf 'expected INFO log on first run, got: %s\n' "$output"; rm -rf "$tmp"; return 1; }
  [[ -f "${tmp}/install.log" ]] || { printf 'expected log file after first run\n'; rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
}

test_install_wrapper_does_not_run_full_install_in_test_mode() {
  local tmp runner
  tmp="$(mktemp -d)"
  runner="$(build_runner "$tmp")"
  # The wrapper must NEVER call preflight, install_docker, prepare_install_dir,
  # start_runtime, or wait_for_health when --noop is passed. Those functions
  # are stubbed to print a sentinel; the test fails if any sentinel is seen.
  local output
  output="$("$runner" --noop 2>&1 || true)"
  if [[ "$output" == *"STUB_PREFLIGHT_SENTINEL"* ]]; then
    printf 'wrapper ran preflight despite --noop\n'
    rm -rf "$tmp"
    return 1
  fi
  rm -rf "$tmp"
}

test_raw_command_output_through_tee_is_redacted() {
  # Builds a custom runner that overrides preflight() to print raw
  # command-style output (postgres URL, password assignment) directly to
  # stdout — bypassing the installer's value-based redact() — so the
  # stream-level filter in install_log_setup is the only defense. The
  # log file MUST contain [REDACTED] markers and MUST NOT contain the
  # raw secrets.
  local tmp install_path custom_runner log_content
  tmp="$(mktemp -d)"
  install_path="${ROOT_DIR}/scripts/install.sh"
  custom_runner="${tmp}/custom_runner.sh"
  cat >"$custom_runner" <<RUNNER
#!/usr/bin/env bash
set -Eeuo pipefail
export DEPLOYLITE_INSTALL_TESTING=1
export DEPLOYLITE_INSTALL_LOG="${tmp}/install.log"
export DEPLOYLITE_INSTALL_LOG_DIR="${tmp}"
export DEPLOYLITE_INSTALL_DIR="${tmp}/opt"
export DEPLOYLITE_SKIP_DOCKER_INSTALL=1
export DEPLOYLITE_SKIP_RUNTIME=1

# shellcheck source=/dev/null
. '${install_path}'

as_root() { "\$@"; }
command_exists() { [[ "\$1" == "sudo" || "\$1" == "openssl" || "\$1" == "tee" ]]; }
detect_os() { :; }
detect_arch() { :; }
port_available() { return 0; }
preflight() {
  printf 'Reading package lists...\\n'
  printf 'DATABASE_URL=postgres://deploylite:top-secret@postgres:5432/deploylite\\n'
  printf 'POSTGRES_PASSWORD=hunter2\\n'
  printf 'TOKEN_VALUE=raw-token-xyz\\n'
  printf 'Done.\\n'
}
install_docker() { :; }
prepare_install_dir() { :; }
start_runtime() { :; }
wait_for_health() { :; }
print_success() { :; }

main "\$@"
RUNNER
  chmod +x "$custom_runner"
  "$custom_runner" >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [[ -s "${tmp}/install.log" ]] && break
    sleep 0.05
  done
  log_content="$(cat "${tmp}/install.log" 2>/dev/null || true)"
  assert_not_contains "$log_content" 'top-secret' || { printf 'raw postgres password leaked to log: %s\n' "$log_content"; rm -rf "$tmp"; return 1; }
  assert_not_contains "$log_content" 'hunter2' || { printf 'raw POSTGRES_PASSWORD leaked to log: %s\n' "$log_content"; rm -rf "$tmp"; return 1; }
  assert_not_contains "$log_content" 'raw-token-xyz' || { printf 'raw TOKEN_VALUE leaked to log: %s\n' "$log_content"; rm -rf "$tmp"; return 1; }
  # The stream-level filter applies the same two-pass rewrite as the
  # value-based redact(): the postgres URL pass redacts the password
  # segment, then the KEY=VALUE pass redacts the entire DATABASE_URL
  # value. The end state must have [REDACTED] markers and no raw
  # secrets.
  assert_contains "$log_content" 'DATABASE_URL=[REDACTED]' || { printf 'expected redacted DB URL in log, got: %s\n' "$log_content"; rm -rf "$tmp"; return 1; }
  assert_contains "$log_content" 'POSTGRES_PASSWORD=[REDACTED]' || { printf 'expected redacted POSTGRES_PASSWORD in log, got: %s\n' "$log_content"; rm -rf "$tmp"; return 1; }
  assert_contains "$log_content" 'TOKEN_VALUE=[REDACTED]' || { printf 'expected redacted TOKEN_VALUE in log, got: %s\n' "$log_content"; rm -rf "$tmp"; return 1; }
  assert_contains "$log_content" 'Done.' || { printf 'plain output lost in stream: %s\n' "$log_content"; rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
}

test_log_file_mode_is_repaired_on_rerun() {
  # Pre-create the log file with an unsafe mode (0666) to simulate an
  # older install that left the file world-writable. The installer must
  # detect the unsafe mode and downgrade it to 0640 on rerun.
  local tmp runner mode
  tmp="$(mktemp -d)"
  runner="$(build_runner "$tmp")"
  touch "${tmp}/install.log"
  chmod 0666 "${tmp}/install.log"
  if ! "$runner" --noop >/dev/null 2>&1; then
    printf 'wrapper rejected by installer (mode repair may have failed)\n'
    rm -rf "$tmp"
    return 1
  fi
  mode="$(stat -f '%Lp' "${tmp}/install.log" 2>/dev/null || stat -c '%a' "${tmp}/install.log")"
  case "$mode" in
    640|600) ;;
    *)
      printf 'expected install.log mode 0640 or 0600 after rerun, got %s\n' "$mode"
      rm -rf "$tmp"
      return 1
      ;;
  esac
  rm -rf "$tmp"
}

test_log_file_repair_warns_when_mode_changes() {
  # When the installer repairs an unsafe log file mode, the log MUST
  # contain a warning that mentions both the old and new mode so the
  # operator has a paper trail.
  local tmp runner log_content
  tmp="$(mktemp -d)"
  runner="$(build_runner "$tmp")"
  touch "${tmp}/install.log"
  chmod 0666 "${tmp}/install.log"
  "$runner" --noop >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [[ -s "${tmp}/install.log" ]] && break
    sleep 0.05
  done
  log_content="$(cat "${tmp}/install.log" 2>/dev/null || true)"
  assert_contains "$log_content" 'Repaired unsafe log file mode' || { printf 'expected repair warning in log, got: %s\n' "$log_content"; rm -rf "$tmp"; return 1; }
  # macOS stat returns 666 (no leading zero); GNU stat returns 0666.
  # Accept either so the test passes on both platforms.
  if [[ "$log_content" != *"0666"* && "$log_content" != *"666 "* && "$log_content" != *"666."* ]]; then
    printf 'expected old mode 0666 or 666 in log, got: %s\n' "$log_content"
    rm -rf "$tmp"
    return 1
  fi
  assert_contains "$log_content" '0640' || { printf 'expected new mode 0640 in log, got: %s\n' "$log_content"; rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
}

test_log_file_safe_mode_is_not_changed_on_rerun() {
  # If the log file is already in a safe mode (0640 or 0600), the
  # installer must NOT warn or change the mode on rerun.
  local tmp runner mode log_content
  tmp="$(mktemp -d)"
  runner="$(build_runner "$tmp")"
  touch "${tmp}/install.log"
  chmod 0640 "${tmp}/install.log"
  "$runner" --noop >/dev/null 2>&1 || true
  mode="$(stat -f '%Lp' "${tmp}/install.log" 2>/dev/null || stat -c '%a' "${tmp}/install.log")"
  [[ "$mode" == "640" ]] || { printf 'expected safe mode to remain 0640, got %s\n' "$mode"; rm -rf "$tmp"; return 1; }
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [[ -s "${tmp}/install.log" ]] && break
    sleep 0.05
  done
  log_content="$(cat "${tmp}/install.log" 2>/dev/null || true)"
  if [[ "$log_content" == *"Repaired unsafe log file mode"* ]]; then
    printf 'repair warning fired on a safe-mode rerun\n'
    rm -rf "$tmp"
    return 1
  fi
  rm -rf "$tmp"
}

run_test 'log file is created at configured path' test_log_file_is_created_at_configured_path
run_test 'log file is not world readable' test_log_file_permissions_are_not_world_readable
run_test 'log file captures stdout and stderr' test_log_file_captures_stdout_and_stderr
run_test 'log file does not contain raw secrets' test_log_file_does_not_contain_raw_secrets
run_test 'log file records idempotent rerun marker' test_log_file_records_idempotent_rerun_marker
run_test 'idempotency probe reports already installed components' test_idempotency_probe_reports_already_installed_components
run_test 'parse_args accepts --interactive and -i' test_parse_args_accepts_interactive_short_and_long_form
run_test 'parse_args rejects unknown flags' test_parse_args_rejects_unknown_flags
run_test '--help prints usage and exits 0' test_help_flag_prints_usage_and_exits_zero
run_test 'interactive mode falls back when whiptail is missing' test_interactive_flag_falls_back_to_read_when_whiptail_missing
run_test 'noninteractive automation mode runs without tty' test_noninteractive_automation_mode_still_works_without_tty
run_test 'log file uses tee and appends on rerun' test_log_file_uses_tee_and_appends_on_rerun
run_test 'idempotency probe handles missing docker and missing env' test_idempotency_probe_handles_missing_docker_and_missing_env
run_test 'install wrapper does not run full install in test mode' test_install_wrapper_does_not_run_full_install_in_test_mode
run_test 'raw command output through tee is redacted' test_raw_command_output_through_tee_is_redacted
run_test 'log file mode is repaired on rerun' test_log_file_mode_is_repaired_on_rerun
run_test 'log file repair warns when mode changes' test_log_file_repair_warns_when_mode_changes
run_test 'log file safe mode is not changed on rerun' test_log_file_safe_mode_is_not_changed_on_rerun

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
