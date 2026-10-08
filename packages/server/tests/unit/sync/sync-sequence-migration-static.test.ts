import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';

const MIGRATION = new URL('../../../migrations/202607251600_sync_sequence_lanes.ts', import.meta.url);
const PORT = new URL('../../../src/infrastructure/sync/sync-sequence-postgres.ts', import.meta.url);
const AUTHORITY_LOCK = new URL('../../../src/infrastructure/sync/sync-sequence-authority-lock.ts', import.meta.url);

describe('P3-10 Sequence lane expand migration static contract', () => {
  test('owns durable lanes, lifetime claims, immutable receipts, and explicit retention', async () => {
    const source = await readFile(MIGRATION, 'utf8');
    for (const marker of [
      'sync_sequence_lanes', 'sync_sequence_operation_claims', 'sync_sequence_receipts',
      'next_sequence', 'sequence_scope', 'canonical_digest', 'result_json', 'result_digest',
      'session_id', 'lease_generation', 'server_batch_id', 'media_type', 'endpoint_identity',
      'replica_lifetime', 'retained_through_retirement',
    ]) assert.match(source, new RegExp(marker));
    assert.match(source, /PRIMARY KEY \(replica_id, sequence_scope\)/);
    assert.match(source, /UNIQUE \(replica_id, sequence_scope, sequence_number\)/);
    assert.match(source, /operation_id text PRIMARY KEY/);
    assert.match(source, /forbid_sync_sequence_claim_mutation/);
    assert.match(source, /enforce_sync_sequence_receipt_transition/);
    assert.match(source, /enforce_sync_sequence_lane_transition/);
    assert.match(source, /BEFORE INSERT OR UPDATE OR DELETE ON sync_sequence_receipts/);
    assert.match(source, /P3-10 expand/i);
    assert.match(source, /down is a developer-only destructive rollback/i);
  });

  test('does not mount Push transport, an evaluator, Conflict, or a client queue', async () => {
    const source = await readFile(MIGRATION, 'utf8');
    assert.doesNotMatch(source, /Fastify|registerSyncPush|CREATE TABLE sync_conflict|indexeddb/i);
  });

  test('adapts the public COLP Sequence owner with explicit transaction claim/read/finalize APIs only', async () => {
    const source = await readFile(PORT, 'utf8');
    assert.match(source, /createSyncHost\(\{ owner: 'sequence'/);
    assert.match(source, /host\.sequence\(/);
    assert.match(source, /operationIdReservationOwner: 'sequence'/);
    for (const operation of ['claimOperation', 'readReceipt', 'finalizeReceipt']) {
      assert.match(source, new RegExp(operation));
    }
    assert.doesNotMatch(source, /coordinatePushTransaction|createCanonicalMutation|Fastify|registerSyncPush/);
  });

  test('fail-closes lockAuthority when transactional authority is omitted', async () => {
    const source = await readFile(AUTHORITY_LOCK, 'utf8');
    assert.match(source, /transactionalAuthority === undefined/);
    assert.match(source, /authorization_denied/);
    assert.doesNotMatch(source, /for update of session, replica/);
  });
});
