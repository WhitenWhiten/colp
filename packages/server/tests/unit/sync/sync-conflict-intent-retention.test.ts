import assert from 'node:assert/strict';
import { test } from 'vitest';
import { Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler,
  type CompiledQuery, type DatabaseConnection, type Driver } from 'kysely';
import { appendOpenSyncConflict } from '../../../src/infrastructure/sync/sync-conflict-postgres.js';
import { decryptPrivatePayload } from '../../../src/infrastructure/sync/sync-conflict-private-payload.js';
import { evaluateSyncNodeUpdate, type TrustedSyncNodeRevision } from '../../../src/modules/sync/sync-node-update.js';
import { syncNodeUpdatePushRequest } from '../../fixtures/phase3/sync-node-update.js';

// Execute the production conflict serializer, capture its SQL
// values, and authenticate/decrypt them with the production reader. This does
// not substitute for PostgreSQL concurrency or constraint integration tests.
test('partial-field conflicts retain independent incoming fields in authenticated private content', async () => {
  const before = 'https://example.test/before';
  const incomingUrl = 'https://example.test/after';
  const base: TrustedSyncNodeRevision = {
    collectionId: 'update-collection-1', resourceId: 'update-node-1', revision: 'update-node-r1',
    kind: 'bookmark', deleted: false,
    payload: { kind: 'bookmark', title: 'Original', url: before, extensions: {} },
  };
  const current: TrustedSyncNodeRevision = { ...base, revision: 'update-node-r2',
    payload: { ...base.payload, title: 'Remote title' } };
  const operation = syncNodeUpdatePushRequest({
    base: { title: 'Original', url: before }, value: { title: 'Local title', url: incomingUrl },
  }).operations[0]!;
  const evaluation = evaluateSyncNodeUpdate(operation, base, current);
  assert.equal(evaluation.status, 'conflict');
  if (evaluation.status !== 'conflict') throw new Error('expected title conflict');
  assert.deepEqual(evaluation.fields, ['title']);
  let saved: Record<string, any> | undefined;
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
        saved.conflicting_fields = JSON.parse(saved.conflicting_fields);
      }
      return { rows: rows as R[], numAffectedRows: 1n };
    },
    async *streamQuery<R>() { yield { rows: [] as R[] }; },
  };
  const driver: Driver = {
    async init() {}, async destroy() {}, async acquireConnection() { return connection; },
    async releaseConnection() {}, async beginTransaction() {}, async commitTransaction() {}, async rollbackTransaction() {},
  };
  const db = new Kysely<any>({ dialect: {
    createAdapter: () => new PostgresAdapter(), createDriver: () => driver,
    createQueryCompiler: () => new PostgresQueryCompiler(), createIntrospector: d => new PostgresIntrospector(d),
  } });
  const encryption = { key: Buffer.alloc(32, 29), keyVersion: 1 };
  const stop = new Error('review_stop_after_conflict_sql');
  try {
    await assert.rejects(appendOpenSyncConflict({
      transaction: { databaseTransaction: db,
        authority: { accountId: 'review-account', collectionId: operation.collectionId!,
          replicaId: operation.replicaId, leaseGeneration: '1' },
        idReservations: { async reserveAll() { return { state: 'reserved' }; } },
      } as any,
      sessionId: 'review-session', operation, code: evaluation.code, conflictingFields: evaluation.fields,
      trustedBase: base, current, conflictPayloadEncryption: encryption,
      faultInjector: { afterPhase(phase) { if (phase === 'conflict') throw stop; } },
    }), error => error === stop);
    assert.ok(saved, 'production conflict insert should be captured');
    const decrypted = decryptPrivatePayload(saved as any, { active: encryption, retained: [] }, 'bookmark', 1n,
      () => { throw new Error('decryption failed'); });
    assert.equal(decrypted.incoming.title, 'Local title');
    assert.equal(decrypted.incoming.url, incomingUrl,
      'the non-conflicting URL was not applied, so it must remain available to conflict resolution');
  } finally { await db.destroy(); }
});
