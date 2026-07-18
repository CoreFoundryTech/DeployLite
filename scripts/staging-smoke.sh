#!/usr/bin/env bash
set -Eeuo pipefail
set +x

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if ! root="$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null)"; then
  printf '%s\n' 'BLOCKED: staging smoke must run from scripts inside the checkout.' >&2
  exit 3
fi
if [[ "$script_dir/staging-smoke.sh" != "$root/scripts/staging-smoke.sh" ]]; then
  printf '%s\n' 'BLOCKED: staging smoke must run from scripts inside the checkout.' >&2
  exit 3
fi

execute=false
evidence_file=""
while (($#)); do
  case "$1" in
    --execute) execute=true ;;
    --evidence) evidence_file="${2:-}"; shift ;;
    *) printf 'BLOCKED: unknown argument %s\n' "$1" >&2; exit 3 ;;
  esac
  shift
done

blocked() { printf 'BLOCKED: %s\n' "$1" >&2; exit 3; }
require() { [[ -n "${!1:-}" ]] || blocked "$1 is required for an approved non-production smoke."; }

require STAGING_APPROVED_TARGET
require STAGING_TARGET
require STAGING_ALLOWED_SUFFIX
if [[ "$STAGING_TARGET" != "$STAGING_APPROVED_TARGET" ]]; then
  blocked 'STAGING_TARGET must exactly match STAGING_APPROVED_TARGET.'
fi
if ! [[ "$STAGING_TARGET" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$ ]] || \
  ! [[ "$STAGING_TARGET" =~ (^|\.)(staging|nonprod|non-production)(\.|$) ]] || \
  [[ "$STAGING_TARGET" =~ (^|\.)(prod|production)(\.|$) ]] || \
  [[ "$STAGING_TARGET" != *"$STAGING_ALLOWED_SUFFIX" ]]; then
  blocked 'STAGING_TARGET is not an approved non-production target.'
fi
if [[ -n "${SSH_PRIVATE_KEY:-}" || -n "${SSH_HOST_KEY:-}" ]]; then
  blocked 'generic SSH secrets are prohibited; provide scoped STAGING_* secrets only.'
fi
require STAGING_SSH_PRIVATE_KEY
require STAGING_SSH_HOST_KEY
require STAGING_SMOKE_TOKEN

tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/staging-smoke.XXXXXX")"
cleanup() { rm -rf -- "$tmpdir"; }
trap cleanup EXIT
evidence_file="${evidence_file:-${RUNNER_TEMP:-$tmpdir}/staging-smoke-evidence.json}"
case "$evidence_file" in "$root"/*|"${RUNNER_TEMP:-$tmpdir}"/*|"$tmpdir"/*|"${TMPDIR:-/tmp}"/*) ;; *) blocked 'evidence path must stay in the checkout or runner temp directory.' ;; esac

redact() {
  sed -E \
    -e "s|${STAGING_SSH_PRIVATE_KEY//|/\\|}|[REDACTED]|g" \
    -e "s|${STAGING_SSH_HOST_KEY//|/\\|}|[REDACTED]|g" \
    -e "s|${STAGING_SMOKE_TOKEN//|/\\|}|[REDACTED]|g"
}
record() {
  local status="$1"
  mkdir -p "$(dirname -- "$evidence_file")"
  printf '{"alphaPosture":"alpha-early-access","target":"%s","status":"%s","executed":%s,"cleanup":"scheduled","timestamp":"%s"}\n' \
    "$STAGING_TARGET" "$status" "$execute" "$(date -u +%FT%TZ)" > "$evidence_file"
}
fail() { record fail; printf '%s\n' "FAILED: $1" >&2; exit 1; }

if ! $execute; then
  record ready
  printf '%s\n' 'READY: approved non-production target and scoped secrets validated; DNS/TLS/health were not invoked.'
  exit 0
fi

printf '%s\n' "$STAGING_SSH_PRIVATE_KEY" > "$tmpdir/id_ed25519"
printf '%s\n' "$STAGING_SSH_HOST_KEY" > "$tmpdir/known_hosts"
chmod 600 "$tmpdir/id_ed25519" "$tmpdir/known_hosts"

ip="$(getent ahostsv4 "$STAGING_TARGET" | awk 'NR==1 { print $1 }')"
[[ -n "$ip" ]] || fail 'DNS resolution returned no IPv4 address.'
ssh -i "$tmpdir/id_ed25519" -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$tmpdir/known_hosts" \
  "${STAGING_SSH_USER:-deploylite}@${STAGING_TARGET}" "test \"\$(cat /etc/deploylite-smoke-target)\" = \"$STAGING_TARGET\"" \
  > >(redact) 2> >(redact >&2) || fail 'non-production sentinel check failed.'
curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-time 20 \
  -H "Authorization: Bearer $STAGING_SMOKE_TOKEN" "https://$STAGING_TARGET/health" \
  > >(redact) 2> >(redact >&2) || fail 'TLS health check failed.'
curl --fail --silent --show-error --head --proto '=https' --tlsv1.2 --max-time 20 \
  -H "Authorization: Bearer $STAGING_SMOKE_TOKEN" "https://$STAGING_TARGET/" \
  | redact | grep -qi '^server: traefik' || fail 'routing check did not identify Traefik.'
record pass
printf '%s\n' 'PASS: non-production DNS, pinned-host-key sentinel, TLS health, and routing checks passed; temporary credentials removed.'
