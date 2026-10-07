import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

const migrationUrl = new URL('../../../migrations/202607252000_sync_conflicts.ts', import.meta.url);
const portUrl = new URL('../../../src/infrastructure/sync/sync-conflict-postgres.ts', import.meta.url);
const pushUrl = new URL('../../../src/infrastructure/sync/sync-push-postgres.ts', import.meta.url);
const pushCreateUrl = new URL('../../../src/infrastructure/sync/postgres/sync-push-create-update-postgres.ts', import.meta.url);
const runtimeUrl = new URL('../../../src/infrastructure/database/runtime.ts', import.meta.url);
const workerUrl = new URL('../../../src/bootstrap/worker.ts', import.meta.url);

test('P3-17 migration creates Collection-private immutable open Conflict authority', async () => {
  const source = await readFile(migrationUrl, 'utf8');
  for (const required of [
    'sync_conflicts', 'collection_id', 'replica_id', 'session_id', 'operation_id',
    'target_id', 'conflict_type', 'conflicting_fields', 'base_projection',
    'current_projection', 'incoming_projection', 'allowed_resolutions', 'revision',
    'private_payload_ciphertext', 'private_payload_iv', 'private_payload_auth_tag',
    'private_payload_key_version', 'base_revision', 'trusted_base_revision',
    'current_revision', 'commit_ordinal', "status IN ('open','resolved')",
  ]) assert.match(source, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu'), required);
  // Runtime UNIQUE proof: tests/integration/sync/sync-conflicts-unique-postgres.integration.test.ts
  assert.match(source, /UNIQUE\s*\(operation_id\)/iu);
  assert.match(source, /UNIQUE\s*\(collection_id\s*,\s*commit_ordinal\s*,\s*conflict_id\)/iu);
  assert.match(source, /REFERENCES operations\s*\(operation_id\s*,\s*collection_id\)/iu);
  assert.match(source, /forbid_sync_conflict_mutation/iu);
  assert.match(source, /TG_OP = 'UPDATE'.*RAISE EXCEPTION.*immutable/isu);
  assert.match(source, /private_payload_key_version\s+integer\s+NOT NULL\s+CHECK\s*\(private_payload_key_version\s*>\s*0\)/iu);
  assert.match(source, /FOREIGN KEY\s*\(collection_id\s*,\s*target_id\s*,\s*current_revision\)/iu);
  assert.match(source, /REVOKE SELECT\s*\(\s*private_payload_ciphertext/iu);
  assert.doesNotMatch(source, /pending|dismissed/iu);
});

test('P3-17 PostgreSQL port owns bounded redacted projections, deployment crypto, and worker-safe side effects', async () => {
  const [port, pushFacade, pushCreate, runtime, worker] = await Promise.all([
    readFile(portUrl, 'utf8'), readFile(pushUrl, 'utf8'), readFile(pushCreateUrl, 'utf8'),
    readFile(runtimeUrl, 'utf8'), readFile(workerUrl, 'utf8'),
  ]);
  const push = `${pushFacade}\n${pushCreate}`;
  for (const required of [
    "insertInto('sync_conflicts')", 'appendOperationWithPayload', 'appendAuditEvent',
    "insertInto('outbox_events')", "updateTable('collections')", 'conflictingFields',
    'allowedResolutions', 'maxBytes', 'maxDepth', 'maxMembers', 'sha256',
  ]) assert.match(port, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), required);
  assert.doesNotMatch(port, /console\.|logger\.|status:\s*'pending'|status:\s*'dismissed'/iu);
  assert.doesNotMatch(port, /select\(['"]secret_digest['"]\)|sessionSecretDigest/iu);
  assert.match(port, /conflictPayloadEncryption/u);
  assert.match(port, /keyVersion/u);
  assert.match(port, /JSON\.stringify\(fields\)/u);
  assert.match(port, /JSON\.stringify\(allowedResolutions\)/u);
  assert.match(port, /leaseGeneration/u);
  assert.match(push, /status:\s*'conflicted'/u);
  assert.match(push, /appendOpenSyncConflict/u);
  assert.match(push, /conflictBoundary:\s*'persisted_open'/u);
  assert.match(runtime, /sync_conflicts:\s*SyncConflictTable/u);
  assert.match(worker, /createSyncConflictOutboxRoute/u);
  assert.match(worker, /syncConflictEnvelopeRegistration/u);
});
