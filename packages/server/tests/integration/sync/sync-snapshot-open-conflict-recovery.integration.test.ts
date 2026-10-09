import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createPostgresSharedExposureFactsPort, createAttachmentExposurePolicyAdapter,
  runMigrations } from '../../../src/infrastructure/database/index.js';
import { insertTestOperation } from '../../support/ledger-split-writes.js';
import {
  createPostgresSyncBootstrapSnapshotApplication,
  createPostgresSyncConflictResolutionApplication,
  createPostgresSyncPullReadPort,
  createPostgresSyncRecoveryApplication,
} from '../../../src/infrastructure/sync/index.js';
import { encryptPrivatePayload } from '../../../src/infrastructure/sync/sync-conflict-postgres.js';
import { stableJson } from '../../../src/infrastructure/sync/sync-conflict-json.js';
import { materializeNodePayload, RESOURCE_PAYLOAD_SCHEMA_VERSION } from '../../../src/modules/collections/index.js';
import { SyncAckError, createSyncPullCursorKeyring } from '../../../src/modules/sync/index.js';
import { createIsolatedPostgresRuntime, describeWithPostgres,
  type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { seedRecoveryFixture, type RecoveryFixture } from '../../support/sync-recovery-fixture.js';

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

const KEYRING = { active: { key: Buffer.alloc(32, 71), keyVersion: 7 }, retained: [] } as const;
const PULL_LIMIT = 100;

describeWithPostgres('P1-6 snapshot open conflict recovery', () => {
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('p1_6_snapshot_conflicts', { maxConnections: 8 });
    runtimeForApp = isolated;
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());

  test('keeps an open conflict resolvable, skips a dismiss at the cut, and delivers a later dismiss', async () => {
    const fixture = await seedRecoveryFixture(isolated, 'deliver', undefined, false, undefined, '0.2');
    const targetId = await seedBookmark(fixture);
    const keys = cursorKeys();
    try {
      await insertWiredOperation(fixture, 'op-visible', 44);
      await insertOpenConflict(fixture, targetId, 'conflict-open', 'op-open', 46, 'delete_update');
      await insertDismissedConflict(fixture, targetId, 'conflict-dismissed', 'op-dismissed', 48, 'op-dismiss', 50);
      await setCommitOrdinal(fixture.collectionId, 50);
      const snapshot = await snapshotApp(keys).query({
        origin: ORIGIN, credential: fixture.credential, request: { sessionId: fixture.sessionId, limit: PULL_LIMIT },
      });
      assert.equal('conflicts' in snapshot, false);
      const cursor = await isolated.runtime.db.selectFrom('sync_pull_cursor_evidence')
        .select(['tuple_commit_ordinal', 'tuple_stream_kind', 'tuple_stable_id'])
        .where('cursor', '=', snapshot.syncCursor).executeTakeFirstOrThrow();
      assert.equal(cursor.tuple_stable_id, 'conflict-dismissed');
      assert.equal(cursor.tuple_stream_kind, 1);
      assert.equal(BigInt(cursor.tuple_commit_ordinal), 50n);
      const listed = await listAll(keys, fixture, snapshot.snapshotId!);
      assert.deepEqual(listed.map((conflict) => conflict.id), ['conflict-open']);
      assert.equal(listed[0]?.status, 'open');
      assert.equal('base' in (listed[0] ?? {}), false);
      assert.equal('server' in (listed[0] ?? {}), false);
      assert.equal('incoming' in (listed[0] ?? {}), false);
      const before = await pullEvents(keys, fixture, snapshot.syncCursor);
      assert.equal(before.some((event) => mentions(event, 'conflict-open') || mentions(event, 'conflict-dismissed')
        || mentions(event, 'op-visible')), false);
      await isolated.runtime.pool.query(
        `update nodes set deleted_at=current_timestamp, deleted_commit_ordinal=50 where id=$1`, [targetId]);
      const resolved = await resolve(fixture, 'conflict-open');
      assert.equal(resolved.outcome, 'resolved', resolved.error);
      assert.equal(resolved.conflictStatus, 'resolved');
      const after = await pullEvents(keys, fixture, snapshot.syncCursor);
      assert.equal(after.some((event) => mentions(event, 'conflict-open') && mentions(event, 'resolved')), true);
      assert.equal(after.some((event) => mentions(event, 'conflict-dismissed') || mentions(event, 'op-visible')), false);
    } finally { keys.destroy(); }
  }, 60_000);

  test('refuses an old Ack, survives paging and Ack retry, and leaves the conflict open', async () => {
    const fixture = await seedRecoveryFixture(isolated, 'ack', undefined, false, undefined, '0.2');
    const targetId = await seedBookmark(fixture);
    await insertOpenConflict(fixture, targetId, 'conflict-page-a', 'op-page-a', 46);
    await insertOpenConflict(fixture, targetId, 'conflict-page-b', 'op-page-b', 47);
    await insertDismissedConflict(fixture, targetId, 'conflict-cut', 'op-cut-open', 48, 'op-cut', 50);
    await setCommitOrdinal(fixture.collectionId, 50);
    await isolated.runtime.pool.query(`update sync_replicas set status='recovery_required',
      wire_json=jsonb_set(wire_json, '{status}', '"recovery_required"'::jsonb, true) where replica_id=$1`,
    [fixture.replicaId]);
    const keys = cursorKeys();
    try {
      const recovery = createPostgresSyncRecoveryApplication(isolated.runtime.db, {
        ...fixture.options, pullCursorKeyring: keys, recoveryProofRetentionMs: 2_592_000_000,
      });
      const snapshot = await snapshotApp(keys, recovery).query({
        origin: ORIGIN, credential: fixture.credential, request: { sessionId: fixture.sessionId, limit: PULL_LIMIT },
      });
      const capability = snapshot.protocolVersion === '0.2' ? snapshot.recoveryCapability : undefined;
      assert.equal(typeof capability, 'string');
      const ackInput = { origin: ORIGIN,
        credential: fixture.credential, idempotencyKey: 'recover-conflicts', sessionId: fixture.sessionId,
        capability: capability!, requestCursor: snapshot.syncCursor, explicitCapability: true,
        requestFingerprint: 'recover-conflicts',
      };
      await assert.rejects(recovery.bootstrapAcknowledge(ackInput), (error: unknown) =>
        error instanceof SyncAckError && error.code === 'unsupported_version');
      const first = await snapshotApp(keys).listOpenConflicts({ origin: ORIGIN,
        credential: fixture.credential, sessionId: fixture.sessionId, snapshotId: snapshot.snapshotId!, offset: 0, limit: 1,
      });
      const second = await snapshotApp(keys).listOpenConflicts({ origin: ORIGIN,
        credential: fixture.credential, sessionId: fixture.sessionId, snapshotId: snapshot.snapshotId!, offset: 1, limit: 1,
      });
      const restarted = await snapshotApp(keys).listOpenConflicts({ origin: ORIGIN,
        credential: fixture.credential, sessionId: fixture.sessionId, snapshotId: snapshot.snapshotId!, offset: 0, limit: 1,
      });
      assert.deepEqual(restarted.conflicts.map((conflict) => conflict.id), first.conflicts.map((conflict) => conflict.id));
      assert.deepEqual([...first.conflicts, ...second.conflicts].map((conflict) => conflict.id),
        ['conflict-page-a', 'conflict-page-b']);
      assert.equal(second.nextOffset, null);
      await assert.rejects(snapshotApp(keys).confirmOpenConflicts({ origin: ORIGIN,
        credential: fixture.credential, sessionId: fixture.sessionId, snapshotId: snapshot.snapshotId!,
        conflictDigest: '0'.repeat(64),
      }), /scope|digest/iu);
      await snapshotApp(keys).confirmOpenConflicts({ origin: ORIGIN,
        credential: fixture.credential, sessionId: fixture.sessionId, snapshotId: snapshot.snapshotId!,
        conflictDigest: first.conflictDigest,
      });
      const acked = await recovery.bootstrapAcknowledge(ackInput);
      const replay = await recovery.bootstrapAcknowledge(ackInput);
      assert.deepEqual(replay, acked);
      const open = await isolated.runtime.pool.query(
        `select conflict_id from sync_conflicts where collection_id=$1 and status='open' order by conflict_id`,
        [fixture.collectionId]);
      assert.deepEqual(open.rows.map((row) => row.conflict_id), ['conflict-page-a', 'conflict-page-b']);
      const checkpoint = await isolated.runtime.db.selectFrom('sync_replicas')
        .select(['checkpoint_stable_id', 'checkpoint_stream_kind', 'status'])
        .where('replica_id', '=', fixture.replicaId).executeTakeFirstOrThrow();
      assert.equal(checkpoint.status, 'active');
      assert.equal(checkpoint.checkpoint_stable_id, 'conflict-cut');
      assert.equal(checkpoint.checkpoint_stream_kind, 1);
    } finally { keys.destroy(); }
  }, 60_000);

  test('still acks a cut that covered no open conflict without a conflict receipt', async () => {
    const fixture = await seedRecoveryFixture(isolated, 'empty', undefined, false, undefined, '0.2');
    await isolated.runtime.pool.query(`update sync_replicas set status='recovery_required',
      wire_json=jsonb_set(wire_json, '{status}', '"recovery_required"'::jsonb, true) where replica_id=$1`,
    [fixture.replicaId]);
    const keys = cursorKeys();
    try {
      const recovery = createPostgresSyncRecoveryApplication(isolated.runtime.db, {
        ...fixture.options, pullCursorKeyring: keys, recoveryProofRetentionMs: 2_592_000_000,
      });
      const snapshot = await snapshotApp(keys, recovery).query({
        origin: ORIGIN, credential: fixture.credential, request: { sessionId: fixture.sessionId, limit: PULL_LIMIT },
      });
      const page = await snapshotApp(keys).listOpenConflicts({ origin: ORIGIN,
        credential: fixture.credential, sessionId: fixture.sessionId, snapshotId: snapshot.snapshotId!, offset: 0, limit: 50,
      });
      assert.equal(page.conflictCount, 0);
      const capability = snapshot.protocolVersion === '0.2' ? snapshot.recoveryCapability : undefined;
      const acked = await recovery.bootstrapAcknowledge({ origin: ORIGIN,
        credential: fixture.credential, idempotencyKey: 'recover-empty', sessionId: fixture.sessionId,
        capability: capability!, requestCursor: snapshot.syncCursor, explicitCapability: true,
        requestFingerprint: 'recover-empty',
      });
      assert.equal(acked.ackedCursor, snapshot.syncCursor);
    } finally { keys.destroy(); }
  }, 60_000);
});

function cursorKeys() {
  return createSyncPullCursorKeyring({
    active: { id: 'p1-6', secret: Buffer.alloc(32, 37).toString('base64') }, retained: [], ttlMs: 300_000,
  });
}

function snapshotApp(keys: ReturnType<typeof cursorKeys>, recovery?: RecoveryFixture['application']) {
  return createPostgresSyncBootstrapSnapshotApplication(isolatedRuntime(), {
    cursorSecret: Buffer.alloc(32, 93), cursorKeyId: 'snapshot-v1', cursorTtlMs: 300_000,
    pullCursorKeyring: keys, recoveryProofRetentionMs: 2_592_000_000,
    ...(recovery ? { recovery } : {}),
    attachmentExposure: createAttachmentExposurePolicyAdapter(
      createPostgresSharedExposureFactsPort(isolatedRuntime())),
  });
}

let isolated: IsolatedPostgresRuntime;
let runtimeForApp: IsolatedPostgresRuntime | undefined;
function isolatedRuntime() {
  if (!runtimeForApp) throw new Error('runtime missing');
  return runtimeForApp.runtime;
}

function mentions(event: { readonly kind: string; readonly conflict?: { readonly id?: string; readonly status?: string };
  readonly operation?: { readonly opId?: string } }, token: string): boolean {
  return JSON.stringify(event).includes(token);
}

async function pullEvents(keys: ReturnType<typeof cursorKeys>, fixture: RecoveryFixture, cursor: string) {
  const port = createPostgresSyncPullReadPort(isolated.runtime.db, keys);
  const events = [];
  let next: string | null = cursor;
  for (let page = 0; page < 10 && next; page += 1) {
    const result = await port.read({ origin: ORIGIN,
      credential: fixture.credential, sessionId: fixture.sessionId, collectionId: fixture.collectionId,
      replicaId: fixture.replicaId, cursor: next, limit: PULL_LIMIT,
    });
    events.push(...result.events);
    next = result.hasMore ? result.nextCursor : null;
  }
  return events;
}

async function listAll(keys: ReturnType<typeof cursorKeys>, fixture: RecoveryFixture, snapshotId: string) {
  const conflicts = [];
  let offset = 0;
  for (let page = 0; page < 10; page += 1) {
    const result = await snapshotApp(keys).listOpenConflicts({ origin: ORIGIN,
      credential: fixture.credential, sessionId: fixture.sessionId, snapshotId, offset, limit: 1,
    });
    conflicts.push(...result.conflicts);
    if (result.nextOffset === null) return conflicts;
    offset = result.nextOffset;
  }
  throw new Error('conflict pages did not end');
}

async function seedBookmark(fixture: RecoveryFixture): Promise<string> {
  const targetId = `target-${fixture.replicaId}`.replace(/[^A-Za-z0-9._~-]/gu, '').slice(0, 48);
  const now = new Date('2026-07-26T12:00:00.000Z');
  const payload = materializeNodePayload({
    id: targetId, collectionId: fixture.collectionId, parentId: (await isolated.runtime.db.selectFrom('collections')
      .select('root_node_id').where('id', '=', fixture.collectionId).executeTakeFirstOrThrow()).root_node_id,
    kind: 'bookmark', isRoot: false, title: 'Target', url: 'https://example.test/', description: null, tags: [],
    visibility: 'inherit', positionToken: 'A', resourceRevision: 'target-r1', childrenRevision: 'target-children-r1',
    createdAt: now, updatedAt: now, deletedAt: null, deletedCommitOrdinal: null,
  });
  if (!payload.ok) throw new Error('bookmark payload failed');
  await isolated.runtime.pool.query(
    "insert into resource_id_ledger(resource_id,resource_type) values ($1,'node')", [targetId]);
  await isolated.runtime.pool.query(`insert into nodes
    (id,collection_id,parent_id,kind,is_root,title,url,visibility,position_token,resource_revision,
     children_revision,created_at,updated_at,payload_json,payload_schema_version,payload_authority_status)
    values ($1,$2,$3,'bookmark',false,'Target','https://example.test/','inherit','A','target-r1',
      'target-children-r1',$4,$4,$5,$6,'backfilled')`,
  [targetId, fixture.collectionId, (await isolated.runtime.db.selectFrom('collections').select('root_node_id')
    .where('id', '=', fixture.collectionId).executeTakeFirstOrThrow()).root_node_id,
  now, payload.payload, RESOURCE_PAYLOAD_SCHEMA_VERSION]);
  await isolated.runtime.pool.query(`insert into sync_node_revision_history
    (collection_id,resource_id,revision,kind,payload_json,commit_ordinal,operation_id)
    values ($1,$2,'target-r1','bookmark',$3,0,null)`,
  [fixture.collectionId, targetId, payload.payload]);
  return targetId;
}

async function insertWiredOperation(fixture: RecoveryFixture, operationId: string, ordinal: number): Promise<void> {
  await isolated.runtime.pool.query(
    "insert into resource_id_ledger(resource_id,resource_type) values ($1,'operation')", [operationId]);
  await insertTestOperation(isolated.runtime.db, {
    operationId, collectionId: fixture.collectionId, commitOrdinal: BigInt(ordinal),
    operationType: 'sync.node.update', payloadJson: { action: 'update' },
    syncWireJson: { opId: operationId, collectionId: fixture.collectionId, type: 'update_node_content' },
    actorPrincipalId: fixture.accountId,
  });
}

async function insertOpenConflict(fixture: RecoveryFixture, targetId: string, conflictId: string,
  operationId: string, ordinal: number, type: 'concurrent_field_update' | 'delete_update' = 'concurrent_field_update'): Promise<void> {
  await isolated.runtime.pool.query(
    "insert into resource_id_ledger(resource_id,resource_type) values ($1,'operation'),($2,'event')",
    [operationId, conflictId]);
  await insertTestOperation(isolated.runtime.db, {
    operationId, collectionId: fixture.collectionId, commitOrdinal: BigInt(ordinal),
    operationType: 'sync.node.update.conflicted', payloadJson: { action: 'conflict' },
    actorPrincipalId: fixture.accountId,
  });
  const binding = await isolated.runtime.pool.query(
    'select lease_generation::text as lease_generation from sync_session_bindings where session_id=$1',
    [fixture.sessionId]);
  const invalid = (): never => { throw new Error('conflict json invalid'); };
  const plaintext = stableJson({
    base: { title: 'Target' }, current: { title: 'Target' }, incoming: { title: 'Incoming' }, nodeKind: 'bookmark',
  }, invalid);
  const encrypted = encryptPrivatePayload(plaintext, KEYRING.active, {
    collectionId: fixture.collectionId, replicaId: fixture.replicaId,
    leaseGeneration: binding.rows[0].lease_generation, sessionId: fixture.sessionId, operationId,
    targetId, conflictId, commitOrdinal: String(ordinal), conflictType: 'concurrent_field_update',
    conflictingFields: stableJson(['/title'], invalid), nodeKind: 'bookmark', baseRevision: 'target-r1',
    currentRevision: 'target-r1', keyVersion: '7',
  });
  const menu = type === 'delete_update' ? ['server'] : ['server', 'incoming', 'custom'];
  const pullWire = {
    id: conflictId, collectionId: fixture.collectionId, targetId, type, field: '/title',
    incomingOpId: operationId, createdAt: '2026-10-03T00:00:00.000Z', status: 'open',
    allowedResolutions: menu, revision: 'conflict-r1',
  };
  await isolated.runtime.pool.query(`insert into sync_conflicts
    (conflict_id,collection_id,replica_id,session_id,operation_id,target_id,base_revision,current_revision,
     conflict_type,conflicting_fields,base_projection,current_projection,incoming_projection,
     private_payload_ciphertext,private_payload_iv,private_payload_auth_tag,private_payload_key_version,
     private_payload_digest,allowed_resolutions,pull_wire_json,status,revision,commit_ordinal)
    values ($1,$2,$3,$4,$5,$6,'target-r1','target-r1',$13,'["/title"]',
     '{"fields":["/title"]}','{"fields":["/title"]}','{"fields":["/title"]}',$7,$8,$9,7,$10,
     $14,$11,'open','conflict-r1',$12)`,
  [conflictId, fixture.collectionId, fixture.replicaId, fixture.sessionId, operationId, targetId,
    encrypted.ciphertext, encrypted.iv, encrypted.authTag, encrypted.digest, pullWire, ordinal, type,
    JSON.stringify(menu)]);
}

async function insertDismissedConflict(fixture: RecoveryFixture, targetId: string, conflictId: string,
  operationId: string, conflictOrdinal: number, resolutionId: string, resolutionOrdinal: number): Promise<void> {
  await insertOpenConflict(fixture, targetId, conflictId, operationId, conflictOrdinal);
  await isolated.runtime.pool.query(
    "insert into resource_id_ledger(resource_id,resource_type) values ($1,'operation')", [resolutionId]);
  await insertTestOperation(isolated.runtime.db, {
    operationId: resolutionId, collectionId: fixture.collectionId, commitOrdinal: BigInt(resolutionOrdinal),
    operationType: 'sync.conflict.dismissed', payloadJson: { action: 'dismiss', conflictId },
    actorPrincipalId: fixture.accountId,
  });
  const resolvedWire = {
    id: conflictId, collectionId: fixture.collectionId, targetId, type: 'concurrent_field_update', field: '/title',
    incomingOpId: operationId, createdAt: '2026-10-03T00:00:00.000Z', status: 'resolved',
    allowedResolutions: ['server', 'incoming', 'custom'], revision: 'conflict-r2',
  };
  await isolated.runtime.pool.query(`update sync_conflicts set status='resolved', revision='conflict-r2',
    resolved_by_operation_id=$2, resolved_by_principal_id=$3, resolution='server', resolved_at=current_timestamp,
    resolution_result_json=$4 where conflict_id=$1`,
  [conflictId, resolutionId, fixture.accountId, { conflict: resolvedWire }]);
}

async function setCommitOrdinal(collectionId: string, ordinal: number): Promise<void> {
  await isolated.runtime.pool.query(`update collections set commit_ordinal=$2::bigint,
    payload_json=jsonb_set(payload_json, '{commitOrdinal}', to_jsonb($3::text), true) where id=$1`,
  [collectionId, ordinal, String(ordinal)]);
}

async function resolve(fixture: RecoveryFixture, conflictId: string) {
  const application = createPostgresSyncConflictResolutionApplication(isolated.runtime.db,
    { verify: async () => ({ authorizationScopes: ['sync:push'] }) } as never,
    { conflictPayloadKeyring: KEYRING, managedBookmarkWrites: false });
  let outcome: 'resolved' | 'refused' = 'resolved';
  let error = '';
  try {
    await application.resolve({ origin: ORIGIN,
      credential: fixture.credential, sessionId: fixture.sessionId, replicaId: fixture.replicaId,
      collectionId: fixture.collectionId, conflictId, idempotencyKey: `resolve-${conflictId}`,
      ifMatch: ['"conflict-r1"'], request: { resolution: 'server', baseConflictRevision: 'conflict-r1' },
    } as never);
  } catch (thrown) {
    outcome = 'refused';
    error = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown);
  }
  const row = (await isolated.runtime.pool.query(
    'select status from sync_conflicts where conflict_id=$1', [conflictId])).rows[0];
  return { outcome, error, conflictStatus: row?.status ?? 'missing' };
}
