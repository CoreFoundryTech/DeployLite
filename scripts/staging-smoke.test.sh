#!/usr/bin/env bash
set -Eeuo pipefail

root="$(git -C "$(dirname -- "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
script="$root/scripts/staging-smoke.sh"
workflow="$root/.github/workflows/staging-smoke.yml"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
private_key=$'-----BEGIN FIXTURE KEY-----\nfixture/key|must-not-appear\n-----END FIXTURE KEY-----'
host_key=$'staging.example.test ssh-ed25519 AAAAfixture\nfixture-host-key|must-not-appear'
token='fixture-token|must-not-appear'

assert() { "$@" || { printf 'assertion failed: %s\n' "$*" >&2; exit 1; }; }
run_blocked() {
  local output status
  set +e; output="$($@ 2>&1)"; status=$?; set -e
  [[ $status -eq 3 && "$output" == *'BLOCKED:'* && "$output" != *"$token"* ]]
}

assert run_blocked env -i PATH="$PATH" bash "$script"
assert run_blocked env -i PATH="$PATH" STAGING_APPROVED_TARGET=production.example.test STAGING_TARGET=production.example.test STAGING_ALLOWED_SUFFIX=.example.test bash "$script"
assert run_blocked env -i PATH="$PATH" STAGING_APPROVED_TARGET=staging.example.test STAGING_TARGET=staging.example.test STAGING_ALLOWED_SUFFIX=.example.test SSH_PRIVATE_KEY="$token" bash "$script"

mkdir "$work/bin"
cat > "$work/bin/getent" <<'EOF'
#!/usr/bin/env bash
printf 'resolved\n' >> "$GETENT_COUNT_FILE"
printf '203.0.113.10 STREAM staging.example.test\n'
EOF
cat > "$work/bin/ssh" <<'EOF'
#!/usr/bin/env bash
[[ " $* " == *' StrictHostKeyChecking=yes '* ]] || exit 2
[[ " $* " == *' HostKeyAlias=staging.example.test '* ]] || exit 2
[[ " $* " == *' ConnectTimeout=10 '* ]] || exit 2
[[ "$*" == *'deploylite@203.0.113.10'* ]] || exit 2
printf 'sentinel ok\n'
EOF
cat > "$work/bin/curl" <<'EOF'
#!/usr/bin/env bash
[[ " $* " == *' --resolve staging.example.test:443:203.0.113.10 '* ]] || exit 2
printf '%s\n%s\n%s\n' "$STAGING_SSH_PRIVATE_KEY" "$STAGING_SSH_HOST_KEY" "$STAGING_SMOKE_TOKEN"
if [[ " $* " == *' --head '* ]]; then printf 'server: traefik\n'; else printf 'health ok\n'; fi
EOF
cat > "$work/bin/timeout" <<'EOF'
#!/usr/bin/env bash
[[ "$1" == '--foreground' && "$2" == '30s' ]] || exit 2
shift 2
exec "$@"
EOF
chmod +x "$work/bin/"*

base=(env "PATH=$work/bin:$PATH" "TMPDIR=$work" "GETENT_COUNT_FILE=$work/getent-count" STAGING_APPROVED_TARGET=staging.example.test STAGING_TARGET=staging.example.test STAGING_ALLOWED_SUFFIX=.example.test STAGING_SSH_PRIVATE_KEY="$private_key" STAGING_SSH_HOST_KEY="$host_key" STAGING_SMOKE_TOKEN="$token")
ready_output="$("${base[@]}" bash "$script")"
[[ "$ready_output" == *'READY:'* && "$ready_output" != *"$private_key"* && "$ready_output" != *"$host_key"* && "$ready_output" != *"$token"* ]]
evidence="$work/evidence.json"
output="$("${base[@]}" bash "$script" --execute --evidence "$evidence")"
[[ "$output" == *'PASS:'* && "$output" != *"$private_key"* && "$output" != *"$host_key"* && "$output" != *"$token"* ]]
[[ "$(<"$evidence")" == *'"status":"pass"'* && "$(<"$evidence")" != *"$private_key"* && "$(<"$evidence")" != *"$host_key"* && "$(<"$evidence")" != *"$token"* ]]
[[ "$(wc -l < "$work/getent-count")" -eq 1 ]]
[[ -z "$(command ls -A "$work" | grep 'staging-smoke\.' || true)" ]]

grep -Fq 'STAGING_EVIDENCE_FILE: ${{ runner.temp }}/staging-smoke-evidence.json' "$workflow"
grep -Fq 'timeout --foreground 30s ssh' "$script"
grep -Fq 'timeout --foreground 30s curl' "$script"

assert "${base[@]}" bash "$script"
assert "${base[@]}" bash -c "cd '$root' && bash scripts/staging-smoke.sh"
assert "${base[@]}" bash -c "git -C '$root' rev-parse --show-toplevel >/dev/null && bash '$script'"
cp "$script" "$work/outside.sh"
assert run_blocked env -i PATH="$PATH" bash "$work/outside.sh"
printf '%s\n' 'Staging smoke contract tests passed.'
