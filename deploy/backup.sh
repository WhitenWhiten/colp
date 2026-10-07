#!/usr/bin/env bash
set -euo pipefail

deploy_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$deploy_dir"
[[ -f .env ]] || { echo "deploy/.env is required; copy .env.example to .env" >&2; exit 2; }
# shellcheck disable=SC1091
source .env
: "\${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required in .env}"
file="colp-backup-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
docker compose exec -T db pg_dump -U "\${POSTGRES_USER:-colp}" -d "\${POSTGRES_DB:-colp}" | gzip -9 > "$file"
echo "created $deploy_dir/$file"
echo "To restore: stop the server, then run ./restore.sh $file"
