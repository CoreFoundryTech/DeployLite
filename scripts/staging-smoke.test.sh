#!/usr/bin/env bash
set -Eeuo pipefail

root="$(git -C "$(dirname -- "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
script="$root/scripts/staging-smoke.sh"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
secret='fixture-secret-must-not-appear'

assert() { "$@" || { printf 'assertion failed: %s\n' "$*" >&2; exit 1; }; }
run_blocked() {
  local output status
  set +e; output="$($@ 2>&1)"; status=$?; set -e
  [[ $status -eq 3 && "$output" == *'BLOCKED:'* && "$output" != *"$secret"* ]]
}

assert run_blocked env -i PATH="$PATH" bash "$script"
assert run_blocked env -i PATH="$PATH" STAGING_APPROVED_TARGET=production.example.test STAGING_TARGET=production.example.test STAGING_ALLOWED_SUFFIX=.example.test bash "$script"
assert run_blocked env -i PATH="$PATH" STAGING_APPROVED_TARGET=staging.example.test STAGING_TARGET=staging.example.test STAGING_ALLOWED_SUFFIX=.example.test SSH_PRIVATE_KEY="$secret" bash "$script"

mkdir "$work/bin"
cat > "$work/bin/getent" <<'EOF'
#!/usr/bin/env bash
printf '203.0.113.10 STREAM staging.example.test\n'
EOF
cat > "$work/bin/ssh" <<'EOF'
#!/usr/bin/env bash
[[ " $* " == *' StrictHostKeyChecking=yes '* ]] || exit 2
printf 'sentinel ok\n'
EOF
cat > "$work/bin/curl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$STAGING_SMOKE_TOKEN"
if [[ " $* " == *' --head '* ]]; then printf 'server: traefik\n'; else printf 'health ok\n'; fi
EOF
chmod +x "$work/bin/"*

base=(env "PATH=$work/bin:$PATH" "TMPDIR=$work" STAGING_APPROVED_TARGET=staging.example.test STAGING_TARGET=staging.example.test STAGING_ALLOWED_SUFFIX=.example.test STAGING_SSH_PRIVATE_KEY="$secret" STAGING_SSH_HOST_KEY='staging.example.test ssh-ed25519 AAAAfixture' STAGING_SMOKE_TOKEN="$secret")
ready_output="$("${base[@]}" bash "$script")"
[[ "$ready_output" == *'READY:'* && "$ready_output" != *"$secret"* ]]
evidence="$work/evidence.json"
output="$("${base[@]}" bash "$script" --execute --evidence "$evidence")"
[[ "$output" == *'PASS:'* && "$output" != *"$secret"* ]]
[[ "$(<"$evidence")" == *'"status":"pass"'* && "$(<"$evidence")" != *"$secret"* ]]
[[ -z "$(command ls -A "$work" | grep 'staging-smoke\.' || true)" ]]

assert "${base[@]}" bash "$script"
assert "${base[@]}" bash -c "cd '$root' && bash scripts/staging-smoke.sh"
assert "${base[@]}" bash -c "git -C '$root' rev-parse --show-toplevel >/dev/null && bash '$script'"
cp "$script" "$work/outside.sh"
assert run_blocked env -i PATH="$PATH" bash "$work/outside.sh"
printf '%s\n' 'Staging smoke contract tests passed.'
