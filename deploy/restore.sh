#!/usr/bin/env bash
# Replaces the COLP database with a backup from backup.sh, then starts the
# stack and waits until the server is ready.
#
# Restore and revalidate in a separate database before replacing the live name.
# Keep the previous database so a bad archive or failed upgrade cannot erase it.
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

stamp=$(date +%Y%m%dT%H%M%S)_$$
staging_db="colp_restore_${stamp}"
previous_db="colp_before_restore_${stamp}"
cleanup() {
  docker compose exec -T db psql -U "${db_user}" -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS ${staging_db} WITH (FORCE)" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker compose exec -T db psql -U "${db_user}" -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE ${staging_db} OWNER ${db_user}"

# Backups from before 0.1.0 were gzip-wrapped (.sql.gz); current ones are plain .dump.
if [[ ${backup_file} == *.gz ]]; then
  reader=(gunzip -c "${backup_file}")
else
  reader=(cat "${backup_file}")
fi
"${reader[@]}" | docker compose exec -T db pg_restore -U "${db_user}" -d "${staging_db}" \
  --exit-on-error --single-transaction

# Restored rules never resume admission before the Owner revalidates them.
docker compose exec -T db psql -U "${db_user}" -d "${staging_db}" -v ON_ERROR_STOP=1 <<'SQL'
DO $$ BEGIN
  IF to_regclass('automation_settings') IS NOT NULL THEN
    INSERT INTO automation_settings (owner_id, paused, paused_at, paused_by, revision)
      SELECT id, true, now(), 'restore', 1 FROM accounts
      ON CONFLICT (owner_id) DO UPDATE SET paused = true, paused_at = now(),
        paused_by = 'restore', revision = automation_settings.revision + 1;
  END IF;
  IF to_regclass('automation_configuration_epochs') IS NOT NULL THEN
    INSERT INTO automation_configuration_epochs(owner_id, revision)
      SELECT a.id, greatest(coalesce(s.revision,0),coalesce(b.revision,0))+1 FROM accounts a
      LEFT JOIN automation_settings s ON s.owner_id=a.id
      LEFT JOIN (SELECT owner_id,max(settings_revision) AS revision FROM automation_device_bundles GROUP BY owner_id) b ON b.owner_id=a.id
      ON CONFLICT (owner_id) DO UPDATE SET revision=greatest(automation_configuration_epochs.revision,excluded.revision)+1;
  END IF;
  IF to_regclass('automation_job_attempts') IS NOT NULL THEN
    UPDATE automation_job_attempts SET outcome='unknownOutcome' WHERE outcome='leased';
    UPDATE automation_jobs SET state='uncertain',revision=revision+1,
      explanation='Restored external attempt has unknown outcome; reconcile before an explicit retry.' WHERE state='leased';
  END IF;
  IF to_regclass('automation_event_subscriptions') IS NOT NULL THEN
    UPDATE automation_event_subscriptions SET state='revalidation',generation=generation+1,
      secret_ciphertext=NULL,previous_secret_ciphertext=NULL,previous_secret_until=NULL WHERE state IN ('active','verifying');
  END IF;
  IF to_regclass('automation_event_deliveries') IS NOT NULL THEN
    UPDATE automation_event_deliveries SET state='cancelled',generation=generation+1,lease_until=NULL,next_attempt_at=NULL,
      last_error_code='restore_revalidation' WHERE state IN ('pending','retrying','sending');
  END IF;
END $$;
SQL

# Both renames commit together. A failed cutover leaves the original name intact.
docker compose exec -T db psql -U "${db_user}" -d postgres -v ON_ERROR_STOP=1 --single-transaction \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${db_name}' AND pid<>pg_backend_pid()" \
  -c "ALTER DATABASE ${db_name} RENAME TO ${previous_db}" \
  -c "ALTER DATABASE ${staging_db} RENAME TO ${db_name}"
trap - EXIT
echo "Previous database retained as ${previous_db}"

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
