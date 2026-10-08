#!/usr/bin/env bash
# Writes one PostgreSQL custom-format dump (pg_dump -Fc, already compressed)
# of the COLP database to colp-backup-<timestamp>.dump in the caller's
# directory. The file appears only when the dump finished.
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

if [[ ! -f "${script_dir}/.env" ]]; then
  echo "deploy/.env is missing" >&2
  exit 1
fi

# compose.yaml fixes the database role and name.
db_user=colp
db_name=colp

caller_dir=$(pwd)
cd "${script_dir}" || exit 1

stamp=$(date +%Y%m%dT%H%M%S)
outfile="${caller_dir}/colp-backup-${stamp}.dump"
partial="${outfile}.partial"
trap 'rm -f "${partial}"' EXIT

docker compose exec -T db pg_dump -U "${db_user}" -Fc "${db_name}" > "${partial}"
mv "${partial}" "${outfile}"
trap - EXIT

echo "Wrote ${outfile}"
echo "Next: docker compose stop server && ${script_dir}/restore.sh ${outfile}"
