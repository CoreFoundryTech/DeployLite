#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export DEPLOYLITE_BOOTSTRAP_TESTING=1
# shellcheck source=scripts/bootstrap.sh
. "${ROOT_DIR}/scripts/bootstrap.sh"

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

test_tarball_url_defaults_to_main() {
  DEPLOYLITE_REPO="CoreFoundryTech/DeployLite"
  DEPLOYLITE_VERSION="main"
  [[ "$(tarball_url)" == "https://codeload.github.com/CoreFoundryTech/DeployLite/tar.gz/main" ]]
}

test_invalid_repo_fails_actionably() {
  local output status
  DEPLOYLITE_REPO="https://github.com/CoreFoundryTech/DeployLite"
  DEPLOYLITE_VERSION="main"
  output="$(validate_config 2>&1)" && status=0 || status=$?
  [[ "$status" -eq 2 ]]
  assert_contains "$output" "Invalid DEPLOYLITE_REPO"
}

test_download_uses_curl_without_printing_secret_values() {
  local tmp output
  tmp="$(mktemp -d)"
  TARBALL_PATH="${tmp}/deploylite.tar.gz"
  command_exists() { [[ "$1" == "curl" ]]; }
  curl() { printf 'fake archive' >"$4"; }
  DEPLOYLITE_SECRET_TOKEN="super-secret-value"
  output="$(download_tarball "https://example.invalid/archive.tar.gz" 2>&1)"
  [[ -f "$TARBALL_PATH" ]]
  assert_not_contains "$output" "super-secret-value"
  rm -rf "$tmp"
}

test_extract_finds_installer_without_network_or_real_tar() {
  local tmp
  tmp="$(mktemp -d)"
  TMP_ROOT="$tmp"
  TARBALL_PATH="${tmp}/deploylite.tar.gz"
  mkdir -p "$TMP_ROOT/source"
  printf 'fake archive' >"$TARBALL_PATH"
  tar() { mkdir -p "$TMP_ROOT/source/DeployLite-main/scripts"; printf '#!/usr/bin/env bash\n' >"$TMP_ROOT/source/DeployLite-main/scripts/install.sh"; }
  extract_source
  [[ "$SOURCE_DIR" == "$TMP_ROOT/source/DeployLite-main" ]]
  rm -rf "$tmp"
}

test_run_installer_preserves_deploylite_env_and_args() {
  local tmp captured
  tmp="$(mktemp -d)"
  SOURCE_DIR="$tmp/DeployLite-main"
  mkdir -p "$SOURCE_DIR/scripts"
  cat >"$SOURCE_DIR/scripts/install.sh" <<'SCRIPT'
#!/usr/bin/env bash
printf 'public_host=%s\n' "${DEPLOYLITE_PUBLIC_HOST:-}"
printf 'secret_present=%s\n' "${DEPLOYLITE_SECRET_TOKEN:+yes}"
printf 'args=%s\n' "$*"
SCRIPT
  chmod +x "$SOURCE_DIR/scripts/install.sh"
  # shellcheck disable=SC2034
  DEPLOYLITE_PUBLIC_HOST="203.0.113.10"
  # shellcheck disable=SC2034
  DEPLOYLITE_SECRET_TOKEN="super-secret-value"
  captured="$(run_installer --dry-run)"
  assert_contains "$captured" "public_host=203.0.113.10" || return 1
  assert_contains "$captured" "secret_present=yes" || return 1
  assert_contains "$captured" "args=--dry-run" || return 1
  assert_not_contains "$captured" "super-secret-value" || return 1
  rm -rf "$tmp"
}

test_cleanup_removes_temp_root() {
  local tmp
  tmp="$(mktemp -d)"
  TMP_ROOT="$tmp"
  cleanup
  [[ ! -e "$tmp" ]]
}

run_test 'tarball URL defaults to main' test_tarball_url_defaults_to_main
run_test 'invalid repo fails actionably' test_invalid_repo_fails_actionably
run_test 'download uses curl without secret output' test_download_uses_curl_without_printing_secret_values
run_test 'extract finds installer with mocked tar' test_extract_finds_installer_without_network_or_real_tar
run_test 'installer receives DEPLOYLITE env and args' test_run_installer_preserves_deploylite_env_and_args
run_test 'cleanup removes temp root' test_cleanup_removes_temp_root

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
