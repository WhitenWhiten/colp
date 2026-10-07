#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: restore.sh colp-backup-<timestamp>.sql.gz" >&2
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
env_file="${script_dir}/.env"

if [[ ! -f "${env_file}" ]]; then
  echo "deploy/.env is missing" >&2
  exit 1
fi

db_user=colp
db_name=colp
colp_server_origin=
while IFS= read -r line || [[ -n ${line} ]]; do
  line=${line%$'\r'}
  line=${line#"${line%%[![:space:]]*}"}
  [[ -z ${line} || ${line} == \#* ]] && continue
  line=${line#export }
  key=${line%%=*}
  value=${line#*=}
  [[ ${key} == "${line}" ]] && continue
  if [[ ${value} == \"*\" ]]; then
    value=${value#\"}
    value=${value%\"}
  elif [[ ${value} == \'*\' ]]; then
    value=${value#\'}
    value=${value%\'}
  fi
  if [[ -n ${value} ]]; then
    case ${key} in
      POSTGRES_USER) db_user=${value} ;;
      POSTGRES_DB) db_name=${value} ;;
      COLP_SERVER_ORIGIN) colp_server_origin=${value} ;;
    esac
  fi
done < "${env_file}"

if [[ -z ${colp_server_origin} ]]; then
  echo "COLP_SERVER_ORIGIN is not set in deploy/.env" >&2
  exit 1
fi

cd "${script_dir}" || exit 1

server_ids=$(docker compose ps -q --status running server)
if [[ -n ${server_ids} ]]; then
  echo "server is running; docker compose stop server first" >&2
  exit 1
fi

docker compose up -d --wait --wait-timeout 120 db

gunzip -c "${backup_file}" | docker compose exec -T db pg_restore -U "${db_user}" -d "${db_name}" --clean --if-exists

docker compose up -d

ready_url="${colp_server_origin%/}/ready"
attempt=0
until curl -fsS "${ready_url}" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [[ ${attempt} -ge 60 ]]; then
    echo "timed out waiting for ${ready_url}" >&2
    exit 1
  fi
  sleep 2
done

echo "Restored ${backup_file}"
echo "Next: curl -fsS ${ready_url}"
