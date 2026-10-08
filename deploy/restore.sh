#!/usr/bin/env bash
# Replaces the COLP database with a backup from backup.sh, then starts the
# stack and waits until the server is ready.
#
# The database is dropped and recreated first, so tables that a newer
# version's migrations added cannot survive and break the next upgrade.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: restore.sh colp-backup-<timestamp>.dump" >&2
  exit 1
fi

backup_file=$1
if [[ ! -f ${backup_file} ]]; then
  echo "backup file not found: ${backup_file}" >&2
  exit 1
fi

backup_abs=$(cd "$(dirname "${backup_file}")" && pwd || exit 1)
backup_file="${backup_abs}/$(basename "${backup_file}")"

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

if [[ ! -f "${script_dir}/.env" ]]; then
  echo "deploy/.env is missing" >&2
  exit 1
fi

# compose.yaml fixes the database role and name.
db_user=colp
db_name=colp

cd "${script_dir}" || exit 1

server_ids=$(docker compose ps -q --status running server)
if [[ -n ${server_ids} ]]; then
  echo "server is running; docker compose stop server first" >&2
  exit 1
fi

docker compose up -d --wait --wait-timeout 120 db

docker compose exec -T db psql -U "${db_user}" -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS ${db_name} WITH (FORCE)" \
  -c "CREATE DATABASE ${db_name} OWNER ${db_user}"

# Backups from before 0.1.0 were gzip-wrapped (.sql.gz); current ones are plain .dump.
if [[ ${backup_file} == *.gz ]]; then
  reader=(gunzip -c "${backup_file}")
else
  reader=(cat "${backup_file}")
fi
"${reader[@]}" | docker compose exec -T db pg_restore -U "${db_user}" -d "${db_name}" \
  --exit-on-error --single-transaction

docker compose up -d

# Ask the server inside its container, so a tls-internal CA the host does not
# trust, or a public origin the host cannot reach, does not matter here.
attempt=0
until docker compose exec -T server colp-server ready >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [[ ${attempt} -ge 90 ]]; then
    echo "timed out waiting for the server to become ready; see: docker compose logs server" >&2
    exit 1
  fi
  sleep 2
done

echo "Restored ${backup_file}"
echo "Next: open your COLP_SERVER_ORIGIN and sign in with the credentials from the backup"
