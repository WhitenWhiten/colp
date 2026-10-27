import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { PostgresSyncEvidenceMaintenanceCoordinator } from '../../../src/infrastructure/sync/index.js';
import { createIsolatedPostgresRuntime, describeWithPostgres,
  type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { seedRecoveryFixture } from '../../support/sync-recovery-fixture.js';

interface SeededSnapshot {
  readonly snapshotId: string;
  readonly capabilityDigest: string | null;
  readonly pageCount: number;
}

describeWithPostgres('bootstrap Snapshot evidence retention', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('snapshot_evidence_retention', { maxConnections: 8 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 60_000);

  afterAll(async () => isolated?.close());

  function coordinator(batchSize = 10) {
    return new PostgresSyncEvidenceMaintenanceCoordinator(isolated.runtime.db, {
      workerId: `snapshot-retention-${randomUUID()}`, batchSize, leaseDurationMs: 30_000,
    });
  }

  async function count(snapshotId: string, table:
    'sync_bootstrap_snapshots' | 'sync_bootstrap_snapshot_pages'
    | 'sync_bootstrap_snapshot_nodes' | 'sync_recovery_capabilities'
    | 'sync_recovery_ack_receipts'): Promise<number> {
    const result = await isolated.runtime.pool.query<{ count: number }>(
      `select count(*)::int as count from ${table} where snapshot_id=$1`, [snapshotId]);
    return result.rows[0]?.count ?? 0;
  }

  async function seedSnapshot(label: string, options: {
    readonly ageMinutes: number;
    readonly pages?: number;
    readonly capability?: 'none' | 'expired' | 'live';
    readonly receipt?: boolean;
  }): Promise<SeededSnapshot> {
    const fixture = await seedRecoveryFixture(isolated, label, undefined, false);
    const root = await isolated.runtime.pool.query<{ root_node_id: string }>(
      'select root_node_id from collections where id=$1', [fixture.collectionId]);
    const rootId = root.rows[0]?.root_node_id;
    assert.ok(rootId, 'fixture collection root is missing');
    const expiresAt = new Date(Date.now() - options.ageMinutes * 60_000);
    const generatedAt = new Date(expiresAt.getTime() - 10 * 60_000);
    const snapshotId = fixture.snapshotId;
    const pages = options.pages ?? 1;
    await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id,resource_type)
      values ($1,'sync_bootstrap_snapshot') on conflict do nothing`, [snapshotId]);
    await isolated.runtime.pool.query(`insert into sync_bootstrap_snapshots
      (snapshot_id,session_id,account_id,collection_id,replica_id,lease_generation,policy_revision,
       content_revision,binding_mode,binding_root_node_id,snapshot_json,bootstrap_cursor,cursor_key_id,
       storage_version,node_count,generated_at,expires_at)
      values ($1,$2,$3,$4,$5,$6,'policy-r1','content-r43','whole-profile',$7,$8,$9,'v1',2,3,$10,$11)`,
    [snapshotId, fixture.sessionId, fixture.accountId, fixture.collectionId, fixture.replicaId,
      BigInt(fixture.oldGeneration), rootId,
      { collection: { id: fixture.collectionId }, nodes: [], nodeCount: 0 },
      `boot_retention_${label}`, generatedAt, expiresAt]);
    for (let index = 0; index < 3; index += 1) {
      await isolated.runtime.pool.query(`insert into sync_bootstrap_snapshot_nodes
        (snapshot_id,node_index,node_json,children_revision) values ($1,$2,$3,null)`,
      [snapshotId, index, { id: `retention-node-${label}-${index}` }]);
    }
    for (let index = 0; index < pages; index += 1) {
      await isolated.runtime.pool.query(`insert into sync_bootstrap_snapshot_pages
        (snapshot_id,session_id,replica_id,old_lease_generation,page_sequence,page_start_offset,
         page_end_offset,complete,response_digest)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [snapshotId, fixture.sessionId, fixture.replicaId, BigInt(fixture.oldGeneration), index + 1,
        index * 100, (index + 1) * 100, index + 1 === pages, `retention-page-${label}-${index}`]);
    }
    if ((options.capability ?? 'none') === 'none') return { snapshotId, capabilityDigest: null, pageCount: pages };
    const expired = options.capability === 'expired';
    const capabilityDigest = createHash('sha256').update(`retention-capability-${label}`).digest('hex');
    const issuedAt = new Date(Date.now() + (expired ? -120 : -10) * 60_000);
    const capabilityExpiry = new Date(Date.now() + (expired ? -60 : 60) * 60_000);
    await isolated.runtime.pool.query(`insert into sync_recovery_capabilities
      (capability_digest,session_id,account_id,replica_id,collection_id,old_lease_generation,
       purge_commit_ordinal,purge_stream_kind,purge_stable_id,snapshot_id,snapshot_revision,
       snapshot_page_count,snapshot_node_count,snapshot_cursor,purpose,version,key_version,
       issued_at,expires_at,consumed_at)
      values ($1,$2,$3,$4,$5,$6,0,0,'',$7,'content-r43',$8,0,$9,
        'sync-recovery-bootstrap-ack',1,'v1',$10,$11,null)`,
    [capabilityDigest, fixture.sessionId, fixture.accountId, fixture.replicaId, fixture.collectionId,
      BigInt(fixture.oldGeneration), snapshotId, pages, `boot_retention_${label}`, issuedAt, capabilityExpiry]);
    if (options.receipt) {
      await isolated.runtime.pool.query(`insert into sync_recovery_ack_receipts
        (replica_id,idempotency_key,principal_id,request_digest,capability_digest,session_id,
         collection_id,snapshot_id,snapshot_revision,old_lease_generation,new_lease_generation,
         new_lease_id,result_json,result_digest,completed_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8,'content-r43',$9,$10,$11,$12,$13,$14)`,
      [fixture.replicaId, `retention-ack-${label}`, fixture.accountId, `request-${label}`,
        capabilityDigest, fixture.sessionId, fixture.collectionId, snapshotId,
        BigInt(fixture.oldGeneration), BigInt(fixture.oldGeneration) + 1n,
        `retention-lease-${label}`, {}, `result-${label}`, new Date(Date.now() - 30 * 60_000)]);
    }
    return { snapshotId, capabilityDigest, pageCount: pages };
  }

  test('expiry-fenced evidence is reclaimed while live and receipt-pinned authority stays', async () => {
    const expired = await seedSnapshot('expired', { ageMinutes: 60, pages: 2, capability: 'expired' });
    const live = await seedSnapshot('live', { ageMinutes: -60, pages: 1, capability: 'live' });
    const pinned = await seedSnapshot('pinned', { ageMinutes: 60, pages: 2, capability: 'expired', receipt: true });

    const result = await coordinator().runBatch();
    assert.equal(result.errors, 0);
    assert.equal(await count(expired.snapshotId, 'sync_bootstrap_snapshots'), 0);
    assert.equal(await count(expired.snapshotId, 'sync_bootstrap_snapshot_pages'), 0);
    assert.equal(await count(expired.snapshotId, 'sync_bootstrap_snapshot_nodes'), 0);
    assert.equal(await count(expired.snapshotId, 'sync_recovery_capabilities'), 0);

    assert.equal(await count(live.snapshotId, 'sync_bootstrap_snapshots'), 1);
    assert.equal(await count(live.snapshotId, 'sync_bootstrap_snapshot_pages'), 1);
    assert.equal(await count(live.snapshotId, 'sync_bootstrap_snapshot_nodes'), 3);
    assert.equal(await count(live.snapshotId, 'sync_recovery_capabilities'), 1);

    assert.equal(await count(pinned.snapshotId, 'sync_bootstrap_snapshots'), 1);
    assert.equal(await count(pinned.snapshotId, 'sync_bootstrap_snapshot_pages'), 0);
    assert.equal(await count(pinned.snapshotId, 'sync_bootstrap_snapshot_nodes'), 0);
    assert.equal(await count(pinned.snapshotId, 'sync_recovery_capabilities'), 1);
    assert.equal(await count(pinned.snapshotId, 'sync_recovery_ack_receipts'), 1);
  });

  test('page evidence and capability deletes still require their own expiry fence', async () => {
    const live = await seedSnapshot('guard-live', { ageMinutes: -60, pages: 1, capability: 'live' });
    await assert.rejects(isolated.runtime.pool.query(
      'delete from sync_bootstrap_snapshot_pages where snapshot_id=$1', [live.snapshotId]),
    /page evidence is immutable/u);
    await assert.rejects(isolated.runtime.pool.query(
      'delete from sync_recovery_capabilities where snapshot_id=$1', [live.snapshotId]),
    /capability claim is immutable/u);

    const expired = await seedSnapshot('guard-expired', { ageMinutes: 60, pages: 1, capability: 'expired' });
    await isolated.runtime.pool.query(
      'delete from sync_bootstrap_snapshot_pages where snapshot_id=$1', [expired.snapshotId]);
    await isolated.runtime.pool.query(
      'delete from sync_recovery_capabilities where snapshot_id=$1', [expired.snapshotId]);
    await isolated.runtime.pool.query(
      'delete from sync_bootstrap_snapshots where snapshot_id=$1', [expired.snapshotId]);
  });

  test('reclaims oldest expired Snapshots first within the batch bound', async () => {
    const older = await seedSnapshot('older', { ageMinutes: 120, pages: 1 });
    const newer = await seedSnapshot('newer', { ageMinutes: 60, pages: 1 });

    const first = await coordinator(1).runBatch();
    assert.equal(first.attempted, 1);
    assert.equal(await count(older.snapshotId, 'sync_bootstrap_snapshots'), 0);
    assert.equal(await count(newer.snapshotId, 'sync_bootstrap_snapshots'), 1);

    const second = await coordinator(1).runBatch();
    assert.equal(second.attempted, 1);
    assert.equal(await count(newer.snapshotId, 'sync_bootstrap_snapshots'), 0);
  });
});
