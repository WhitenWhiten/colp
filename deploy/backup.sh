#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
env_file="${script_dir}/.env"

if [[ ! -f "${env_file}" ]]; then
  echo "deploy/.env is missing" >&2
  exit 1
fi

db_user=colp
db_name=colp
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
    esac
  fi
done < "${env_file}"

caller_dir=$(pwd)
cd "${script_dir}" || exit 1

stamp=$(date +%Y%m%dT%H%M%S)
outfile="${caller_dir}/colp-backup-${stamp}.sql.gz"

docker compose exec -T db pg_dump -U "${db_user}" -Fc "${db_name}" | gzip > "${outfile}"

echo "Wrote ${outfile}"
echo "Next: docker compose stop server && ${script_dir}/restore.sh ${outfile}"
