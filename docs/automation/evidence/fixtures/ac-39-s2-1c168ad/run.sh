#!/usr/bin/env bash
set -u
root=/tmp/colp-ac39-canonical-sql
database=colp-ac39-canonical-sql-db
export PATH="$root/node22/bin:$PATH"
export KNOWN_TEST_DATABASE_URL=postgres://postgres:ac39-isolated@127.0.0.1:15439/ac39
collector=''
stopped=0
cleanup() {
  if [[ -n "$collector" ]]; then kill "$collector" 2>/dev/null || true; wait "$collector" 2>/dev/null || true; fi
  if [[ "$(docker inspect --format '{{index .Config.Labels "purpose"}}' "$database" 2>/dev/null)" == ac39-canonical-sql ]]; then
    docker stop --timeout 30 "$database"
    docker rm -v "$database"
  fi
  if [[ "$stopped" == 1 ]]; then
    docker start colp-db-1
    for _ in $(seq 1 30); do
      if docker exec colp-db-1 pg_isready >/dev/null 2>&1; then break; fi
      sleep 1
    done
    docker start colp-server-1 colp-caddy-http-1
  fi
  docker ps --format '{{.Names}} {{.Status}}' > "$root/restored.txt"
}
if docker inspect "$database" >/dev/null 2>&1; then echo 'Refusing to reuse an existing test container'; exit 1; fi
trap cleanup EXIT
trap 'exit 130' INT TERM HUP
stopped=1
docker stop --timeout 45 colp-server-1 colp-caddy-http-1 || exit 1
docker stop --timeout 45 colp-db-1 || exit 1
docker run -d --name "$database" --label purpose=ac39-canonical-sql \
  -e POSTGRES_PASSWORD=ac39-isolated -e POSTGRES_DB=ac39 \
  -p 127.0.0.1:15439:5432 postgres:16 -c max_connections=40 -c shared_buffers=128MB || exit 1
for _ in $(seq 1 30); do
  if docker exec "$database" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
{
  date -u
  echo 'source=1c168ad1561f0150af07e1a68c6c34138f9ac36b'
  node --version
  lscpu | head -20
  free -m
  df -T /tmp
  docker inspect "$database" --format 'image={{.Image}}'
  docker exec "$database" postgres --version
  sha256sum "$root/packages/server/package-lock.json" "$root/packages/server/tests/support/ac39-capacity.ts"
} > "$root/environment.txt"
vmstat -t 1 > "$root/vmstat.txt" &
collector=$!
cd "$root/packages/server" || exit 1
phase() {
  local name=$1
  shift
  env AC39_OUTPUT="$root/$name.jsonl" "$@" \
    timeout --signal=TERM --kill-after=20s 600s xvfb-run -a node --import tsx tests/support/ac39-capacity.ts > "$root/$name.log" 2>&1
  printf '%s exit=%s\n' "$name" "$?" | tee -a "$root/exits.txt"
}
phase control AC39_STAGE=manual AC39_SIZES=100 AC39_ROUNDS=3 AC39_SAVE_COUNT=1 AC39_CANONICAL_SEED=1
phase burst AC39_STAGE=manual AC39_SIZES=100 AC39_ROUNDS=3 AC39_SAVE_COUNT=20 AC39_CANONICAL_SEED=0
phase rules AC39_STAGE=rules AC39_RULE_SIZES=1,50,200,500 AC39_ROUNDS=3
phase queue AC39_STAGE=queue AC39_ROUNDS=1
