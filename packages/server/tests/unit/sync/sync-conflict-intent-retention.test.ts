import assert from 'node:assert/strict';
import { test } from 'vitest';
import { Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler,
  type CompiledQuery, type DatabaseConnection, type Driver } from 'kysely';
import { appendOpenSyncConflict } from '../../../src/infrastructure/sync/sync-conflict-postgres.js';
import { decryptPrivatePayload } from '../../../src/infrastructure/sync/sync-conflict-private-payload.js';
import type { DatabaseSchema } from '../../../src/infrastructure/database/runtime.js';
import { evaluateSyncNodeUpdate, type TrustedSyncNodeRevision } from '../../../src/modules/sync/sync-node-update.js';
import { syncNodeUpdatePushRequest } from '../../fixtures/phase3/sync-node-update.js';

// Execute the production conflict serializer, capture its SQL
// values, and authenticate/decrypt them with the production reader. This does
// not substitute for PostgreSQL concurrency or constraint integration tests.
test.each([false, true])('conflicts retain the complete authenticated incoming edit (deleted=%s)', async deleted => {
  const before = 'https://example.test/before';
  const incomingUrl = 'https://example.test/after';
  const base: TrustedSyncNodeRevision = {
    collectionId: 'update-collection-1', resourceId: 'update-node-1', revision: 'update-node-r1',
    kind: 'bookmark', deleted: false,
    payload: { kind: 'bookmark', title: 'Original', url: before, extensions: {} },
  };
  const current: TrustedSyncNodeRevision = { ...base, deleted, revision: 'update-node-r2',
    payload: { ...base.payload, title: 'Remote title' } };
  const operation = syncNodeUpdatePushRequest({
    base: { title: 'Original', url: before }, value: { title: 'Local title', url: incomingUrl },
  }).operations[0]!;
  const evaluation = evaluateSyncNodeUpdate(operation, base, current);
  assert.equal(evaluation.status, 'conflict');
  if (evaluation.status !== 'conflict') throw new Error('expected title conflict');
  assert.deepEqual(evaluation.fields, deleted ? ['deletedAt'] : ['title']);
  let saved: Record<string, unknown> | undefined;
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery) {
      let rows: unknown[] = [];
      if (query.sql.startsWith('select "operation_id" from "sync_sequence_operation_claims"')) {
        rows = [{ operation_id: operation.opId }];
      } else if (query.sql.startsWith('select "resource_type" from "resource_id_ledger"')) {
        rows = [{ resource_type: 'operation' }];
      } else if (query.sql.startsWith('update "collections"')) {
        rows = [{ commit_ordinal: 1n }];
      } else if (query.sql.includes('select current_timestamp as now')) {
        rows = [{ now: new Date('2026-10-17T00:00:00Z') }];
      } else if (query.sql.startsWith('insert into "sync_conflicts"')) {
        const columns = query.sql.match(/^insert into "sync_conflicts" \(([^)]+)\)/)![1]!
          .split(',').map(column => column.trim().replaceAll('"', ''));
        saved = Object.fromEntries(columns.map((column, index) => [column, query.parameters[index]]));
        assert.ok(typeof saved.conflicting_fields === 'string');
        saved.conflicting_fields = JSON.parse(saved.conflicting_fields) as unknown;
      }
      return { rows: rows as R[], numAffectedRows: 1n };
    },
    async *streamQuery<R>() { yield { rows: [] as R[] }; },
  };
  const driver: Driver = {
    async init() {}, async destroy() {}, async acquireConnection() { return connection; },
    async releaseConnection() {}, async beginTransaction() {}, async commitTransaction() {}, async rollbackTransaction() {},
  };
  const db = new Kysely<DatabaseSchema>({ dialect: {
    createAdapter: () => new PostgresAdapter(), createDriver: () => driver,
    createQueryCompiler: () => new PostgresQueryCompiler(), createIntrospector: d => new PostgresIntrospector(d),
  } });
  const encryption = { key: Buffer.alloc(32, 29), keyVersion: 1 };
  const stop = new Error('review_stop_after_conflict_sql');
  const unexpected = async (): Promise<never> => { throw new Error('unexpected sequence coordinator call'); };
  try {
    await assert.rejects(db.transaction().execute(databaseTransaction => appendOpenSyncConflict({
      transaction: { databaseTransaction,
        authority: { accountId: 'review-account', collectionId: operation.collectionId!,
          replicaId: operation.replicaId, leaseGeneration: '1' },
        idReservations: { async reserveAll() { return { state: 'reserved' }; } },
        operationClaims: { load: unexpected, save: unexpected },
        reuseAudits: { append: unexpected, load: unexpected },
        receipts: { load: unexpected, save: unexpected },
        loadLaneState: unexpected, saveLaneState: unexpected, readReceipt: unexpected,
        claimOperation: unexpected, finalizeReceipt: unexpected,
      },
      sessionId: 'review-session', operation, code: evaluation.code, conflictingFields: evaluation.fields,
      trustedBase: base, current, conflictPayloadEncryption: encryption,
      faultInjector: { afterPhase(phase) { if (phase === 'conflict') throw stop; } },
    })), error => error === stop);
    assert.ok(saved, 'production conflict insert should be captured');
    assert.deepEqual(saved.conflicting_fields, deleted ? ['/deletedAt', '/title', '/url'] : ['/title']);
    // The SQL driver returns named values from the schema-typed production
    // INSERT. Only the database boundary needs this row assertion; the real
    // reader authenticates every identity and retained-content byte below.
    const row = saved as unknown as Parameters<typeof decryptPrivatePayload>[0];
    const decrypted = decryptPrivatePayload(row, { active: encryption, retained: [] }, 'bookmark', 1n,
      () => { throw new Error('decryption failed'); });
    assert.equal(decrypted.incoming.title, 'Local title');
    assert.equal(decrypted.incoming.url, incomingUrl,
      'the non-conflicting URL was not applied, so it must remain available to conflict resolution');
  } finally { await db.destroy(); }
});
