#!/usr/bin/env bash
set -euo pipefail

deploy_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$deploy_dir"
[[ -f .env ]] || { echo "deploy/.env is required; copy .env.example to .env" >&2; exit 2; }
[[ $# -eq 1 && -f $1 ]] || { echo "usage: ./restore.sh <colp-backup.sql.gz>" >&2; exit 2; }
if docker compose ps --status running --services | grep -qx server; then
  echo "stop the server first: docker compose stop server" >&2
  exit 3
fi
# shellcheck disable=SC1091
source .env
: "\${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required in .env}"
docker compose up -d db
until docker compose exec -T db pg_isready -U "\${POSTGRES_USER:-colp}" -d "\${POSTGRES_DB:-colp}" >/dev/null 2>&1; do sleep 2; done
gunzip -c "$1" | docker compose exec -T db psql -U "\${POSTGRES_USER:-colp}" -d "\${POSTGRES_DB:-colp}"
docker compose up -d server
echo "restore completed; verify readiness with curl -fsS \"\${COLP_SERVER_ORIGIN%/}/ready\""
