import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

const migrationUrl = new URL('../../../migrations/202610011200_sync_pull_page_evidence.ts', import.meta.url);
const composeUrl = new URL('../../../../devops/docker-compose.yml', import.meta.url);
const pullPersistenceClusterUrls = [
  new URL('../../../src/infrastructure/sync/postgres/sync-pull-postgres.ts', import.meta.url),
  new URL('../../../src/infrastructure/sync/postgres/sync-pull-authority-postgres.ts', import.meta.url),
  new URL('../../../src/infrastructure/sync/postgres/sync-pull-cursor-codec-postgres.ts', import.meta.url),
  new URL('../../../src/infrastructure/sync/postgres/sync-pull-cursor-evidence.ts', import.meta.url),
  new URL('../../../src/infrastructure/sync/postgres/sync-pull-recovery-postgres.ts', import.meta.url),
  new URL('../../../src/infrastructure/sync/postgres/sync-pull-page-evidence-postgres.ts', import.meta.url),
];

function stripBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

test('SYNC-Q-011 page evidence migration creates one envelope table and expiry-first cleanup index', async () => {
  const source = await readFile(migrationUrl, 'utf8');
  assert.match(source, /CREATE TABLE sync_pull_page_evidence/i);
  assert.match(source, /next_cursor_digest text NOT NULL CHECK \(length\(next_cursor_digest\) = 64\)/i);
  assert.match(source, /CREATE INDEX sync_pull_page_evidence_cleanup_idx/i);
  assert.match(source, /ON sync_pull_page_evidence\s*\(\s*page_expires_at,\s*replica_id\s*\)/i);
  assert.match(source, /protocol_version IN \('0\.1','0\.2'\)/i);
  assert.match(source, /DROP TABLE IF EXISTS sync_pull_page_evidence/i);
  assert.doesNotMatch(source, /DROP TABLE sync_pull_cursor_evidence/i);
  assert.doesNotMatch(stripBlockComments(source), /CREATE INDEX CONCURRENTLY/i);
  assert.match(source, /Kysely runs PostgreSQL migrations in one transaction/i);
});

test('Pull read path no longer runs request-entry evidence cleanup DML', async () => {
  const source = (await Promise.all(pullPersistenceClusterUrls.map((url) => readFile(url, 'utf8')))).join('\n');
  assert.doesNotMatch(source, /cleanupExpiredCursorAuthority/u);
  assert.doesNotMatch(source, /DELETE FROM sync_pull_cursor_evidence/u);
  assert.doesNotMatch(source, /DELETE FROM sync_pull_cursor_recovery_proofs/u);
  assert.doesNotMatch(source, /DELETE FROM sync_pull_cursor_lineage/u);
});

test('Compose enables evidence maintenance by default after SYNC-Q-011', async () => {
  const compose = await readFile(composeUrl, 'utf8');
  assert.match(compose, /SYNC_EVIDENCE_MAINTENANCE_ENABLED: "\$\{SYNC_EVIDENCE_MAINTENANCE_ENABLED:-true\}"/u);
});
