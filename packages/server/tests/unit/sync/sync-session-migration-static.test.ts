import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

const migrationUrl = new URL('../../../migrations/202607251400_sync_sessions.ts', import.meta.url);

test('P3-07 migration owns durable Session, scope, binding, credential, and receipt facts', async () => {
  const source = await readFile(migrationUrl, 'utf8');
  for (const table of [
    'sync_extension_credentials',
    'sync_sessions',
    'sync_session_scopes',
    'sync_session_bindings',
    'sync_session_idempotency_receipts',
  ]) {
    assert.match(source, new RegExp(`CREATE TABLE ${table}\\b`));
  }
  assert.match(source, /REFERENCES account_identities\(issuer, subject, account_id\)/);
  assert.match(source, /REFERENCES accounts\(id, subject_id\)/);
  assert.match(source, /REFERENCES sync_replica_generations\(replica_id, lease_generation, lease_id\)/);
  assert.match(source, /REFERENCES sync_replicas\(replica_id\)/);
  assert.match(source, /PRIMARY KEY \(principal_id, session_scope, idempotency_key\)/);
  assert.match(source, /request_fingerprint text NOT NULL/);
  assert.match(source, /result_ciphertext bytea NOT NULL/);
  assert.match(source, /result_key_version integer NOT NULL/);
  assert.match(source, /secret_digest text NOT NULL/);
  assert.match(source, /capability_digest text NOT NULL/);
  assert.match(source, /status IN \('active','terminated'\)/);
  assert.match(source, /termination_reason IN \(/);
  assert.match(source, /forbid_sync_session_binding_mutation/);
  assert.match(source, /CREATE TRIGGER sync_session_bindings_immutable/);
  assert.match(source, /CREATE TRIGGER sync_session_receipts_immutable/);
  assert.match(source, /CREATE TRIGGER sync_sessions_terminal_immutable/);
  assert.match(source, /forbid_sync_session_authority_mutation/);
  assert.match(source, /CREATE TRIGGER sync_extension_credentials_terminal_revocation/);
  assert.match(source, /enforce_sync_extension_credential_authority/);
});

test('P3-07 is sortable after Replica lifecycle and documents expand-only downgrade limits', async () => {
  const source = await readFile(migrationUrl, 'utf8');
  assert.match(migrationUrl.pathname, /202607251400_sync_sessions\.ts$/);
  assert.match(source, /P3-07 expand/i);
  assert.match(source, /down is a developer-only destructive rollback/i);
  assert.match(source, /DROP TABLE IF EXISTS sync_session_idempotency_receipts/);
  assert.match(source, /DROP TABLE IF EXISTS sync_sessions/);
  assert.doesNotMatch(source, /ALTER TABLE sync_replicas DROP/i);
});
