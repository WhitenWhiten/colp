/**
 * P4A-I12 PostgreSQL integration: Sync bootstrap + pull projection exclusion.
 *
 * With a REAL private blob seeded through the production ledger (unique marker
 * inside the physical generation key rows and stored bytes) plus a visible
 * control collection/node and a control sync operation, every Sync public
 * entry — bootstrap Snapshot (`createPostgresSyncBootstrapSnapshotApplication`)
 * and Pull stream (`createPostgresSyncPullReadPort`) — must:
 *   (a) actually execute (the control resource is visible);
 *   (b) NEVER contain any private marker in output, stored snapshot, cursor
 *       evidence or events;
 *   (c) survive an old stored-snapshot residue: a stale snapshot_json that
 *       (incorrectly) carried a marker is never forwarded by a fresh rebuild.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Snapshot } from '@know-n/colp/types';
import { afterAll, beforeAll, test } from 'vitest';
import { createPostgresSharedExposureFactsPort, createAttachmentExposurePolicyAdapter } from '../../../src/infrastructure/database/index.js';
import { insertTestOperation } from '../../support/ledger-split-writes.js';

import {
  createPostgresSyncBootstrapSnapshotApplication,
  createPostgresSyncPullReadPort,
} from '../../../src/infrastructure/sync/index.js';
import {
  createSyncPullCursorKeyring,
} from '../../../src/modules/sync/index.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import {
  I12_COLLECTION,
  assertMarkerAbsentFromJson,
  controlMarker,
  i12BlobIdentity,
  privateMarker,
  seedAttachedPrivate,
  seedControlCollection,
  seedExpiredBlob,
  seedQuarantinedGeneration,
  seedRetiredGeneration,
  seedStoredPrivate,
  seedSyncSession,
} from '../../support/phase4a-i12-test-helpers.js';
import {
  createI07MigrationRuntime,
  type I07MigrationRuntime,
} from '../../support/phase4a-i07-test-helpers.js';

describeWithPostgres('P4A-I12 Sync bootstrap/pull projection exclusion', () => {
  let isolated: I07MigrationRuntime;
  let controlNodeTitle: string;
  let controlOperationMarker: string;
  const privateMarkers = {
    stored: privateMarker('i12-sync-stored'),
    attached: privateMarker('i12-sync-attached'),
    retiredOld: privateMarker('i12-sync-retired-old'),
    retiredNew: privateMarker('i12-sync-retired-new'),
    expired: privateMarker('i12-sync-expired'),
    quarantined: privateMarker('i12-sync-quarantined'),
  };

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('phase4a_i12_sync', { maxConnections: 12 });
    const seeded = await seedControlCollection(isolated.runtime, {
      collectionId: I12_COLLECTION,
      controlNodeTitle: controlMarker('i12-sync-control-node'),
    });
    controlNodeTitle = seeded.controlNodeTitle;
    controlOperationMarker = controlMarker('i12-sync-control-op');

    let slot = 0;
    const next = () => { slot += 1; return slot; };
    await seedStoredPrivate(isolated.runtime, i12BlobIdentity(next(), privateMarkers.stored));
    await seedAttachedPrivate(isolated.runtime, i12BlobIdentity(next(), privateMarkers.attached));
    await seedRetiredGeneration(
      isolated.runtime,
      i12BlobIdentity(next(), privateMarkers.retiredOld),
      i12BlobIdentity(next(), privateMarkers.retiredNew),
    );
    await seedExpiredBlob(isolated.runtime, i12BlobIdentity(next(), privateMarkers.expired));
    await seedQuarantinedGeneration(isolated.runtime, i12BlobIdentity(next(), privateMarkers.quarantined));
  }, 120_000);

  afterAll(async () => {
    await isolated?.dropSchema();
  });

  async function bootstrapScope(suffix: string = randomUUID()) {
    const session = await seedSyncSession(isolated.runtime, { collectionId: I12_COLLECTION, suffix });
    const pullKeys = createSyncPullCursorKeyring({
      active: { id: `i12-pull-${suffix}`, secret: Buffer.alloc(32, 57).toString('base64') },
      retained: [], ttlMs: 300_000,
    });
    const application = createPostgresSyncBootstrapSnapshotApplication(isolated.runtime, {
      cursorSecret: Buffer.alloc(32, 58), cursorKeyId: 'i12-snapshot-v1', cursorTtlMs: 300_000,
      pullCursorKeyring: pullKeys,
      attachmentExposure: createAttachmentExposurePolicyAdapter(createPostgresSharedExposureFactsPort(isolated.runtime)),
    });
    return { session, pullKeys, application };
  }

  test('Sync bootstrap serves the control collection/node with zero private marker', async () => {
    const scope = await bootstrapScope();
    try {
      const snapshot = asBootstrapSnapshot(await scope.application.query({
        credential: scope.session.credential,
        request: { sessionId: scope.session.sessionId, limit: 100 },
      }));
      assert.equal(snapshot.mode, 'sync');
      assert.equal(snapshot.collection.id, I12_COLLECTION, 'control collection must be served');
      assert.ok(snapshot.nodes.some((node) => node.title === controlNodeTitle), 'control node must be served (link executed)');
      assert.deepEqual(snapshot.attachments, [], 'sync snapshot attachment projection is empty');
      for (const marker of Object.values(privateMarkers)) {
        assertMarkerAbsentFromJson(snapshot, marker, `sync bootstrap snapshot (${marker})`);
      }
      // The stored bootstrap snapshot row must also be marker-free.
      const stored = await isolated.runtime.pool.query<{ snapshot_json: string }>(
        `select snapshot_json::text from sync_bootstrap_snapshots where snapshot_id=$1`,
        [snapshot.snapshotId],
      );
      assert.equal(stored.rowCount, 1);
      for (const marker of Object.values(privateMarkers)) {
        assert.equal(stored.rows[0]!.snapshot_json.includes(marker), false, `stored snapshot_json must not contain ${marker}`);
      }
    } finally {
      scope.pullKeys.destroy();
    }
  });

  test('Sync pull serves a control operation and carries zero private marker in events/evidence', async () => {
    const scope = await bootstrapScope();
    const operationId = `i12-pull-op-${randomUUID()}`;
    await isolated.runtime.pool.query(
      `insert into resource_id_ledger (resource_id, resource_type) values ($1, 'operation')`,
      [operationId],
    );
    await insertTestOperation(isolated.runtime.db, {
      operationId, collectionId: I12_COLLECTION, commitOrdinal: 1n,
      operationType: 'sync.node.update', payloadJson: {},
      actorPrincipalId: scope.session.credential.subject,
      syncWireJson: {
        opId: operationId,
        replicaId: scope.session.replicaId,
        sequence: 1,
        collectionId: I12_COLLECTION,
        type: 'update_node_content',
        targetId: `i12-pull-target-${randomUUID()}`,
        baseRevision: 'target-r1',
        occurredAt: '2026-08-08T12:00:00.000Z',
        payload: { base: { title: 'Root' }, value: { title: controlOperationMarker } },
      },
    });
    const keys = createSyncPullCursorKeyring({
      active: { id: `i12-pull-read-${randomUUID()}`, secret: Buffer.alloc(32, 59).toString('base64') },
      retained: [], ttlMs: 300_000,
    });
    try {
      const port = createPostgresSyncPullReadPort(isolated.runtime.db, keys);
      const page = await port.read({
        credential: scope.session.credential,
        sessionId: scope.session.sessionId,
        collectionId: I12_COLLECTION,
        replicaId: scope.session.replicaId,
        cursor: null,
        limit: 100,
      });
      const serialized = JSON.stringify(page.events);
      assert.equal(serialized.includes(controlOperationMarker), true, 'control operation must be pulled (link executed)');
      for (const marker of Object.values(privateMarkers)) {
        assert.equal(serialized.includes(marker), false, `pull events must never contain ${marker}`);
        assert.equal(JSON.stringify(page).includes(marker), false, `pull page must never contain ${marker}`);
      }
      const evidence = await isolated.runtime.pool.query<{ cursor: string | null }>(
        `select cursor from sync_pull_cursor_evidence where replica_id=$1 order by issued_at`,
        [scope.session.replicaId],
      );
      for (const row of evidence.rows) {
        if (row.cursor !== null) {
          for (const marker of Object.values(privateMarkers)) {
            assert.equal(row.cursor.includes(marker), false, `pull cursor evidence must never contain ${marker}`);
          }
        }
      }
    } finally {
      keys.destroy();
      scope.pullKeys.destroy();
    }
  });

  test('old stored-snapshot residue is never forwarded by a fresh Sync bootstrap rebuild', async () => {
    const first = await bootstrapScope('residue-first');
    let firstSnapshotId: string;
    try {
      const snapshot = asBootstrapSnapshot(await first.application.query({
        credential: first.session.credential,
        request: { sessionId: first.session.sessionId, limit: 100 },
      }));
      firstSnapshotId = snapshot.snapshotId;
      for (const marker of Object.values(privateMarkers)) {
        assertMarkerAbsentFromJson(snapshot, marker, 'first bootstrap snapshot');
      }
    } finally {
      first.pullKeys.destroy();
    }

    // Simulate old residue: a stale stored snapshot row that (incorrectly)
    // carried a private marker from before the exclusion policy. The
    // production snapshot table is immutable (UPDATE/DELETE are rejected by
    // `forbid_sync_bootstrap_snapshot_mutation`), so residue can only exist as
    // a distinct stale row; a fresh rebuild must never forward it.
    const residue = privateMarker('i12-sync-residue');
    const baseRow = await isolated.runtime.pool.query<Record<string, unknown>>(
      `select * from sync_bootstrap_snapshots where snapshot_id=$1`,
      [firstSnapshotId],
    );
    assert.equal(baseRow.rowCount, 1, 'the first stored snapshot row must exist');
    const base = baseRow.rows[0]!;
    const residueSnapshotId = `i12-residue-snapshot-${randomUUID()}`;
    const residueColumns = Object.keys(base);
    const residueValues = residueColumns.map((column) => {
      if (column === 'snapshot_id') return residueSnapshotId;
      if (column === 'policy_revision') return `p1-residue-${randomUUID().slice(0, 8)}`;
      if (column === 'snapshot_json') return JSON.stringify({ residue });
      if (column === 'bootstrap_cursor') return `residue-cursor-${randomUUID()}`;
      if (column === 'cursor_key_id') return 'i12-residue-cursor-v1';
      if (column === 'generated_at') return new Date();
      if (column === 'expires_at') return new Date(Date.now() + 3_600_000);
      // The stale residue row is not a completed snapshot; keep completed_at
      // null so the completion-window check (completed_at >= generated_at)
      // is not violated by the fabricated row.
      if (column === 'completed_at') return null;
      return base[column];
    });
    await isolated.runtime.pool.query('begin');
    try {
      await isolated.runtime.pool.query(
        `insert into resource_id_ledger (resource_id, resource_type) values ($1, 'sync_bootstrap_snapshot') on conflict do nothing`,
        [residueSnapshotId],
      );
      await isolated.runtime.pool.query(
        `insert into sync_bootstrap_snapshots (${residueColumns.join(',')}) values (${residueColumns.map((_, index) => '$' + (index + 1)).join(',')}) on conflict (snapshot_id) do nothing`,
        residueValues,
      );
      await isolated.runtime.pool.query('commit');
    } catch (error) {
      await isolated.runtime.pool.query('rollback');
      throw error;
    }
    const corrupt = await isolated.runtime.pool.query<{ snapshot_json: string }>(
      `select snapshot_json::text from sync_bootstrap_snapshots where snapshot_id=$1`,
      [residueSnapshotId],
    );
    assert.equal(corrupt.rows[0]!.snapshot_json.includes(residue), true, 'stale residue must exist before purge');

    // A fresh session forces a fresh rebuild from authoritative data; the
    // rebuild never reads the attachment body and never forwards residue.
    const second = await bootstrapScope('residue-second');
    try {
      const rebuilt = asBootstrapSnapshot(await second.application.query({
        credential: second.session.credential,
        request: { sessionId: second.session.sessionId, limit: 100 },
      }));
      assert.notEqual(rebuilt.snapshotId, firstSnapshotId, 'fresh rebuild must not reuse the original stored snapshot');
      assert.notEqual(rebuilt.snapshotId, residueSnapshotId, 'fresh rebuild must not reuse the stale residue snapshot');
      assert.ok(rebuilt.nodes.some((node) => node.title === controlNodeTitle), 'control node still served after rebuild');
      const rebuiltJson = JSON.stringify(rebuilt);
      assert.equal(rebuiltJson.includes(residue), false, 'rebuilt snapshot must not forward stale residue');
      for (const marker of Object.values(privateMarkers)) {
        assert.equal(rebuiltJson.includes(marker), false, `rebuilt snapshot must never contain ${marker}`);
      }
    } finally {
      second.pullKeys.destroy();
    }
  });
});


/** The COLP `Snapshot` type carries an index signature that makes union
 * property access `unknown`; the bootstrap application returns a validated
 * `Snapshot | SyncSnapshotV02` whose runtime shape is a snapshot. */
function asBootstrapSnapshot(value: unknown): Snapshot {
  return value as Snapshot;
}
