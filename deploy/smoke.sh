#!/usr/bin/env bash
set -euo pipefail
origin=\${1:?usage: ./smoke.sh <origin>}
origin=\${origin%/}
health=$(curl --fail --silent --show-error "$origin/health")
ready=$(curl --fail --silent --show-error "$origin/ready")
printf '%s\n' "$health" | grep -q 'version' || { echo '/health has no version' >&2; exit 1; }
printf '%s\n' "$ready" >/dev/null
curl --fail --silent --show-error "$origin/.well-known/collection-protocol" >/dev/null
echo "smoke ok: $origin"
