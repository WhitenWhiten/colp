import { sql } from 'kysely';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import type { Operation } from '@know-n/colp/types';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { insertTestOperation } from '../../support/ledger-split-writes.js';
import {
  createPostgresReplicaRetirementApplication,
  createPostgresReplicaStore,
  createPostgresSyncAckApplication,
  createPostgresSyncPullReadPort,
  createPostgresSyncPushApplication,
  createPostgresSyncSessionIssuer,
} from '../../../src/infrastructure/sync/index.js';
import type { SyncPullAuthorityPhase } from '../../../src/infrastructure/sync/postgres/sync-pull-postgres.js';
import { createSyncPullCursorKeyring, SyncPullReadError } from '../../../src/modules/sync/index.js';
import { RESOURCE_PAYLOAD_SCHEMA_VERSION, materializeCollectionPayload, materializeNodePayload } from '../../../src/modules/collections/index.js';
import { syncNodeUpdatePushRequest } from '../../fixtures/phase3/sync-node-update.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const ISSUER = 'https://issuer.example';
const ACCOUNT = 'R07NDQ0NDQ0NDQ0NDQ0NDQ';
const SUBJECT = 'r07-subject';
const MEMBER_ACCOUNT = 'R07M3MB3R00000000000Q';
const MEMBER_SUBJECT = 'r07-member-subject';
const COLLECTION = 'R07xcXFxcXFxcXFxcXFxcQ';
const ROOT = 'R07root00000000000000Q';
const TARGET = 'R07target000000000000Q';
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

describeWithPostgres('R07 Pull authority late-lock races', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('r07_pull_authority_race', { maxConnections: 16 });
    await runMigrations(isolated.runtime.db, 'latest');
    const now = new Date('2026-07-26T06:00:00Z');
    const collection = materializeCollectionPayload({
      id: COLLECTION, ownerSubjectId: SUBJECT, title: COLLECTION, summary: null,
      kind: 'bookmarks', visibility: 'private', rootNodeId: ROOT,
      resourceRevision: 'collection-r1', contentRevision: 'content-r1', policyRevision: 'policy-r1',
      commitOrdinal: 0n, createdAt: now, updatedAt: now, deletedAt: null,
    });
    const root = materializeNodePayload({
      id: ROOT, collectionId: COLLECTION, parentId: null, kind: 'folder', isRoot: true, title: 'Root',
      url: null, description: null, tags: [], visibility: 'inherit', positionToken: null,
      resourceRevision: 'root-r1', childrenRevision: 'children-r1', createdAt: now, updatedAt: now,
      deletedAt: null, deletedCommitOrdinal: null,
    });
    const target = materializeNodePayload({
      id: TARGET, collectionId: COLLECTION, parentId: ROOT, kind: 'bookmark', isRoot: false, title: 'Target',
      url: 'https://example.test/', description: null, tags: [], visibility: 'inherit', positionToken: 'A',
      resourceRevision: 'target-r1', childrenRevision: 'target-children-r1', createdAt: now, updatedAt: now,
      deletedAt: null, deletedCommitOrdinal: null,
    });
    assert.equal(collection.ok, true);
    assert.equal(root.ok, true);
    assert.equal(target.ok, true);
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query("insert into accounts(id,subject_id,status,security_epoch) values ($1,$2,'active',0),($3,$4,'active',0)",
        [ACCOUNT, SUBJECT, MEMBER_ACCOUNT, MEMBER_SUBJECT]);
      await client.query("insert into profiles(account_id,display_name) values ($1,'R07 owner'),($2,'R07 member')",
        [ACCOUNT, MEMBER_ACCOUNT]);
      await client.query("insert into profile_handles(handle,account_id) values ('r07_owner',$1),('r07_member',$2)",
        [ACCOUNT, MEMBER_ACCOUNT]);
      await client.query(`insert into account_identities(id,account_id,issuer,subject) values
        ('r07-owner-identity',$1,$3,'r07-owner-oidc'),('r07-member-identity',$2,$3,'r07-member-oidc')`,
      [ACCOUNT, MEMBER_ACCOUNT, ISSUER]);
      await client.query("insert into resource_id_ledger(resource_id,resource_type) values ($1,'collection'),($2,'node'),($3,'node')",
        [COLLECTION, ROOT, TARGET]);
      await client.query(`insert into collections
        (id,owner_subject_id,title,kind,visibility,root_node_id,resource_revision,content_revision,
         policy_revision,commit_ordinal,created_at,updated_at,payload_json,payload_schema_version,payload_authority_status)
        values ($1,$2,$1,'bookmarks','private',$3,'collection-r1','content-r1','policy-r1',0,$4,$4,$5,$6,'backfilled')`,
      [COLLECTION, SUBJECT, ROOT, now, collection.ok ? collection.payload : {}, RESOURCE_PAYLOAD_SCHEMA_VERSION]);
      await client.query(`insert into nodes
        (id,collection_id,parent_id,kind,is_root,title,url,visibility,position_token,resource_revision,
         children_revision,created_at,updated_at,payload_json,payload_schema_version,payload_authority_status)
        values ($1,$2,null,'folder',true,'Root',null,'inherit',null,'root-r1','children-r1',$3,$3,$4,$5,'backfilled')`,
      [ROOT, COLLECTION, now, root.ok ? root.payload : {}, RESOURCE_PAYLOAD_SCHEMA_VERSION]);
      await client.query(`insert into nodes
        (id,collection_id,parent_id,kind,is_root,title,url,visibility,position_token,resource_revision,
         children_revision,created_at,updated_at,payload_json,payload_schema_version,payload_authority_status)
        values ($1,$2,$3,'bookmark',false,'Target','https://example.test/','inherit','A','target-r1','target-children-r1',$4,$4,$5,$6,'backfilled')`,
      [TARGET, COLLECTION, ROOT, now, target.ok ? target.payload : {}, RESOURCE_PAYLOAD_SCHEMA_VERSION]);
      await client.query(`insert into sync_node_revision_history
        (collection_id,resource_id,revision,kind,payload_json,commit_ordinal,operation_id)
        values ($1,$2,'target-r1','bookmark',$3,0,null)`,
      [COLLECTION, TARGET, target.ok ? target.payload : {}]);
      await client.query(`insert into collection_members(collection_id,subject_id,role) values ($1,$2,'editor')`,
        [COLLECTION, MEMBER_SUBJECT]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally { client.release(); }
  }, 20_000);

  afterAll(async () => isolated?.close(), 30_000);

  async function createScope(options: {
    readonly accountId?: string;
    readonly oidcSubject?: string;
    readonly label?: string;
    readonly requestedScopes?: readonly ('sync:pull' | 'sync:push')[];
    readonly sessionDurationSeconds?: number;
  } = {}) {
    const label = options.label ?? randomUUID();
    const accountId = options.accountId ?? ACCOUNT;
    const oidcSubject = options.oidcSubject ?? (accountId === MEMBER_ACCOUNT ? 'r07-member-oidc' : 'r07-owner-oidc');
    const credential = await mintVerifiedExtensionCredentialFixture({
      issuer: ISSUER, audience: 'known-api', clientId: 'known-extension', subject: oidcSubject,
      credentialId: `r07-credential-${label}`,
    });
    const replica = await createPostgresReplicaStore(isolated.runtime.db, { ids: {
      deviceId: () => `r07-device-${label}`, replicaId: () => `r07-replica-${label}`,
      leaseId: () => `r07-lease-${label}`,
    } }).create({
      accountId, collectionId: COLLECTION, deviceName: 'R07 device', replicaName: 'R07 replica',
      kind: 'browser_extension', adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: { read: true, write: true, events: true, separator: true, alias: false,
        annotations: 'sidecar', maxBatchOperations: 1 },
      binding: { browserProfileId: `r07-profile-${label}`, mountMode: 'whole-profile',
        browserGeneration: `generation-${label}` },
      leaseDurationSeconds: 3_600,
    }, { actorAccountId: accountId });
    const issuer = createPostgresSyncSessionIssuer(isolated.runtime.db, {
      issuer: ISSUER, audience: 'known-api', clientId: 'known-extension',
      replayEncryptionKey: Buffer.alloc(32, 23), replayEncryptionKeyVersion: 1,
      sessionDurationSeconds: options.sessionDurationSeconds ?? 900, replicaLeaseExtensionSeconds: 3_600,
      tombstoneRetentionSeconds: 86_400, maxBatchOperations: 1,
      endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'],
    });
    const issued = await issuer.issue({
      credential, idempotencyKey: `r07-session-${label}`, requestFingerprint: `r07-fingerprint-${label}`,
      collectionId: COLLECTION, replicaId: replica.replicaId,
      expectedLeaseGeneration: replica.leaseGeneration, expectedLifecycleRevision: replica.lifecycleRevision,
      binding: replica.binding, requestedScopes: [...(options.requestedScopes ?? ['sync:pull'])], origin: ORIGIN,
    });
    return { credential, replica, session: issued.session, issuer };
  }

  function operation(id: string, sequence: number, replicaId: string, targetId = TARGET): Operation {
    return { opId: id, replicaId, sequence, collectionId: COLLECTION,
      type: 'update_node_content', targetId, baseRevision: 'target-r1',
      occurredAt: '2026-07-26T06:01:00Z', payload: { base: { title: 'Root' }, value: { title: `Root ${id}` } } };
  }

  async function seedPushFolder(title = 'Before') {
    const id = `r07-push-${randomUUID()}`;
    const revision = `r07-push-rev-${randomUUID()}`;
    const childrenRevision = `r07-push-children-${randomUUID()}`;
    const now = new Date('2026-07-26T06:05:00Z');
    const materialized = materializeNodePayload({
      id, collectionId: COLLECTION, parentId: ROOT, kind: 'folder', isRoot: false, title,
      url: null, description: null, tags: [], visibility: 'inherit', positionToken: `P${id.slice(-8)}`,
      resourceRevision: revision, childrenRevision, createdAt: now, updatedAt: now,
      deletedAt: null, deletedCommitOrdinal: null,
    });
    assert.equal(materialized.ok, true);
    const payload = { ...(materialized.ok ? materialized.payload : {}), extensions: {} };
    await isolated.runtime.pool.query("insert into resource_id_ledger(resource_id,resource_type) values ($1,'node')", [id]);
    await isolated.runtime.pool.query(`insert into nodes
      (id,collection_id,parent_id,kind,is_root,title,url,description,tags,visibility,position_token,
       resource_revision,children_revision,created_at,updated_at,payload_json,payload_schema_version,payload_authority_status)
      values ($1,$2,$3,'folder',false,$4,null,null,null,'inherit',$5,$6,$7,$8,$8,$9,$10,'backfilled')`,
    [id, COLLECTION, ROOT, title, `P${id.slice(-8)}`, revision, childrenRevision, now, payload,
      RESOURCE_PAYLOAD_SCHEMA_VERSION]);
    await isolated.runtime.pool.query(`insert into sync_node_revision_history
      (collection_id,resource_id,revision,kind,payload_json,commit_ordinal,operation_id)
      values ($1,$2,$3,'folder',$4,0,null)`, [COLLECTION, id, revision, payload]);
    return { id, revision, title };
  }

  async function insertOperation(id: string, ordinal: number, replicaId: string, sequence = ordinal): Promise<void> {
    const wire = operation(id, sequence, replicaId);
    await isolated.runtime.pool.query("insert into resource_id_ledger(resource_id,resource_type) values ($1,'operation')", [id]);
    await insertTestOperation(isolated.runtime.db, {
      operationId: id, collectionId: COLLECTION, commitOrdinal: BigInt(ordinal),
      operationType: 'sync.node.update', payloadJson: { action: 'update' },
      syncWireJson: wire as unknown as Record<string, unknown>, actorPrincipalId: ACCOUNT,
    });
  }

  async function seedOperationBatch(prefix: string, startOrdinal: number, count: number, replicaId: string): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      const id = `batch-${prefix}-${String(index).padStart(5, '0')}`;
      await insertOperation(id, startOrdinal + index, replicaId, startOrdinal + index);
    }
  }

  function reader(options: Parameters<typeof createPostgresSyncPullReadPort>[2] = {}) {
    const keys = createSyncPullCursorKeyring({
      active: { id: `r07-${randomUUID()}`, secret: Buffer.alloc(32, 37).toString('base64') },
      retained: [], ttlMs: 60_000,
    });
    return { keys, port: createPostgresSyncPullReadPort(isolated.runtime.db, keys, options) };
  }

  function authorityBarrier(onPhase: SyncPullAuthorityPhase, hook: () => void | Promise<void>) {
    return {
      authorityFaultInjector: {
        async afterPhase(phase: SyncPullAuthorityPhase) {
          if (phase === onPhase) await hook();
        },
      },
    };
  }

  async function evidenceCounts(replicaId: string): Promise<{ readonly evidence: number; readonly proofs: number }> {
    const evidence = await isolated.runtime.db.selectFrom('sync_pull_cursor_evidence').select('evidence_id')
      .where('replica_id', '=', replicaId).execute();
    const proofs = await isolated.runtime.db.selectFrom('sync_pull_cursor_recovery_proofs').select('proof_id')
      .where('replica_id', '=', replicaId).execute();
    return { evidence: evidence.length, proofs: proofs.length };
  }

  async function raceAfterSnapshot(
    scope: Awaited<ReturnType<typeof createScope>>,
    mutate: () => Promise<void>,
    expectedCode?: SyncPullReadError['code'],
  ): Promise<void> {
    const suffix = randomUUID();
    const ordinalBase = 100_000 + (Date.now() % 800_000);
    await insertOperation(`race-anchor-${suffix}`, ordinalBase, scope.replica.replicaId);
    await insertOperation(`race-op-${suffix}`, ordinalBase + 1, scope.replica.replicaId);
    const before = await evidenceCounts(scope.replica.replicaId);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let snapshotSeen!: () => void;
    const atSnapshot = new Promise<void>((resolve) => { snapshotSeen = resolve; });
    const { keys, port } = reader(authorityBarrier('after_snapshot', async () => {
      snapshotSeen();
      await gate;
    }));
    const pending = port.read({ origin: ORIGIN, credential: scope.credential, sessionId: scope.session.sessionId,
      collectionId: COLLECTION, replicaId: scope.replica.replicaId, cursor: null, limit: 50 });
    await atSnapshot;
    await mutate();
    release();
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof SyncPullReadError, String(error));
      if (expectedCode) assert.equal(error.code, expectedCode);
      return true;
    });
    const after = await evidenceCounts(scope.replica.replicaId);
    assert.deepEqual(after, before);
    keys.destroy();
  }

  test('revoked credential after snapshot fails closed with zero evidence or proof', async () => {
    const scope = await createScope({ label: 'revoke-credential' });
    await raceAfterSnapshot(scope, async () => {
      await isolated.runtime.pool.query(
        'update sync_extension_credentials set revoked_at=current_timestamp where credential_id=$1',
        [scope.credential.credentialId],
      );
    }, 'not_found');
  });

  test('removed membership after snapshot fails closed with zero evidence or proof', async () => {
    const scope = await createScope({ accountId: MEMBER_ACCOUNT, label: 'member-pull' });
    await raceAfterSnapshot(scope, async () => {
      await isolated.runtime.pool.query(
        'delete from collection_members where collection_id=$1 and subject_id=$2',
        [COLLECTION, MEMBER_SUBJECT],
      );
    }, 'not_found');
    await isolated.runtime.pool.query(
      'insert into collection_members(collection_id,subject_id,role) values ($1,$2,\'editor\') on conflict do nothing',
      [COLLECTION, MEMBER_SUBJECT],
    );
  });

  test('policy revision advance after snapshot fails closed with zero evidence or proof', async () => {
    const scope = await createScope({ label: 'policy-revision' });
    await raceAfterSnapshot(scope, async () => {
      await isolated.runtime.pool.query(
        "update collections set policy_revision='policy-r2' where id=$1", [COLLECTION],
      );
    }, 'not_found');
    await isolated.runtime.pool.query("update collections set policy_revision='policy-r1' where id=$1", [COLLECTION]);
    assert.equal(scope.session.sessionId.length > 0, true);
  });

  test('replica retirement after snapshot fails closed with zero evidence or proof', async () => {
    const scope = await createScope({ label: 'retire-replica' });
    await raceAfterSnapshot(scope, async () => {
      await isolated.runtime.pool.query(
        "update sync_replicas set status='retired',retired_at=current_timestamp where replica_id=$1",
        [scope.replica.replicaId],
      );
    }, 'replica_retired');
  });

  test('expired Session after snapshot fails closed with zero evidence or proof', async () => {
    const scope = await createScope({ label: 'expire-session' });
    await raceAfterSnapshot(scope, async () => {
      await isolated.runtime.pool.query(`update sync_replicas set status='expired',
        lease_expires_at=current_timestamp,
        wire_json=jsonb_set(wire_json,'{status}','"expired"',true)
        where replica_id=$1`, [scope.replica.replicaId]);
    }, 'replica_expired');
  });

  test('concurrent Ack lease extension after snapshot continues with the fresh fingerprint', async () => {
    const scope = await createScope({ label: `benign-ack-${randomUUID()}` });
    const suffix = randomUUID();
    const ordinalBase = 810_000 + (Date.now() % 100_000);
    await insertOperation(`benign-ack-anchor-${suffix}`, ordinalBase, scope.replica.replicaId);
    await insertOperation(`benign-ack-op-${suffix}`, ordinalBase + 1, scope.replica.replicaId);
    const before = await evidenceCounts(scope.replica.replicaId);
    let firstSnapshot = true;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let snapshotSeen!: () => void;
    const atSnapshot = new Promise<void>((resolve) => { snapshotSeen = resolve; });
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    let secondSeen!: () => void;
    const atSecondSnapshot = new Promise<void>((resolve) => { secondSeen = resolve; });
    const { keys, port } = reader(authorityBarrier('after_snapshot', async () => {
      if (firstSnapshot) {
        firstSnapshot = false;
        snapshotSeen();
        await gate;
      } else {
        secondSeen();
        await secondGate;
      }
    }));
    const pending = port.read({ origin: ORIGIN, credential: scope.credential, sessionId: scope.session.sessionId,
      collectionId: COLLECTION, replicaId: scope.replica.replicaId, cursor: null, limit: 50 });
    await atSnapshot;
    // A concurrent Ack extends the Replica lease without touching any cursor-binding fact.
    await isolated.runtime.pool.query(
      `update sync_replicas set lease_expires_at=clock_timestamp()+interval '2 hours' where replica_id=$1`,
      [scope.replica.replicaId],
    );
    release();
    const page = await pending;
    assert.ok(page.events.length > 0);
    assert.equal(page.collectionRevision, 'content-r1');
    const after = await evidenceCounts(scope.replica.replicaId);
    assert.ok(after.evidence > before.evidence && after.proofs > before.proofs,
      JSON.stringify({ before, after }));
    // The continuation also survives a concurrent Ack lease extension.
    const pendingResumed = port.read({ origin: ORIGIN, credential: scope.credential, sessionId: scope.session.sessionId,
      collectionId: COLLECTION, replicaId: scope.replica.replicaId, cursor: page.nextCursor, limit: 50 });
    await atSecondSnapshot;
    await isolated.runtime.pool.query(
      `update sync_replicas set lease_expires_at=clock_timestamp()+interval '2 hours' where replica_id=$1`,
      [scope.replica.replicaId],
    );
    releaseSecond();
    const resumed = await pendingResumed;
    assert.equal(resumed.events.length, 0);
    const stored = await isolated.runtime.db.selectFrom('sync_replicas').select('status')
      .where('replica_id', '=', scope.replica.replicaId).executeTakeFirstOrThrow();
    assert.equal(stored.status, 'active');
    keys.destroy();
  });

  test('content revision advance after snapshot continues with the fresh fingerprint', async () => {
    const scope = await createScope({ label: `benign-content-${randomUUID()}` });
    const suffix = randomUUID();
    const ordinalBase = 820_000 + (Date.now() % 100_000);
    await insertOperation(`benign-content-anchor-${suffix}`, ordinalBase, scope.replica.replicaId);
    await insertOperation(`benign-content-op-${suffix}`, ordinalBase + 1, scope.replica.replicaId);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let snapshotSeen!: () => void;
    const atSnapshot = new Promise<void>((resolve) => { snapshotSeen = resolve; });
    const { keys, port } = reader(authorityBarrier('after_snapshot', async () => {
      snapshotSeen();
      await gate;
    }));
    const pending = port.read({ origin: ORIGIN, credential: scope.credential, sessionId: scope.session.sessionId,
      collectionId: COLLECTION, replicaId: scope.replica.replicaId, cursor: null, limit: 50 });
    await atSnapshot;
    // A concurrent content change advances Collection content_revision without
    // touching policy, membership, or any cursor-binding fact.
    await isolated.runtime.pool.query(
      "update collections set content_revision='content-r2' where id=$1", [COLLECTION],
    );
    release();
    const page = await pending;
    assert.ok(page.events.length > 0);
    // The response and the persisted evidence carry the fresh fingerprint's revision.
    assert.equal(page.collectionRevision, 'content-r2');
    const evidence = await isolated.runtime.db.selectFrom('sync_pull_cursor_evidence')
      .select('collection_revision').where('replica_id', '=', scope.replica.replicaId)
      .executeTakeFirstOrThrow();
    assert.equal(evidence.collection_revision, 'content-r2');
    const resumed = await port.read({ origin: ORIGIN, credential: scope.credential, sessionId: scope.session.sessionId,
      collectionId: COLLECTION, replicaId: scope.replica.replicaId, cursor: page.nextCursor, limit: 50 });
    assert.equal(resumed.events.length, 0);
    await isolated.runtime.pool.query(
      "update collections set content_revision='content-r1' where id=$1", [COLLECTION],
    );
    keys.destroy();
  });

  test('membership role shift after snapshot continues with the fresh fingerprint', async () => {
    const scope = await createScope({ accountId: MEMBER_ACCOUNT, label: `benign-role-${randomUUID()}` });
    const suffix = randomUUID();
    const ordinalBase = 830_000 + (Date.now() % 100_000);
    await insertOperation(`benign-role-anchor-${suffix}`, ordinalBase, scope.replica.replicaId);
    await insertOperation(`benign-role-op-${suffix}`, ordinalBase + 1, scope.replica.replicaId);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let snapshotSeen!: () => void;
    const atSnapshot = new Promise<void>((resolve) => { snapshotSeen = resolve; });
    const { keys, port } = reader(authorityBarrier('after_snapshot', async () => {
      snapshotSeen();
      await gate;
    }));
    const pending = port.read({ origin: ORIGIN, credential: scope.credential, sessionId: scope.session.sessionId,
      collectionId: COLLECTION, replicaId: scope.replica.replicaId, cursor: null, limit: 50 });
    await atSnapshot;
    // editor -> viewer keeps the member authorized (any membership role satisfies
    // the locked authority check) but changes the authority fingerprint.
    await isolated.runtime.pool.query(
      "update collection_members set role='viewer' where collection_id=$1 and subject_id=$2",
      [COLLECTION, MEMBER_SUBJECT],
    );
    release();
    const page = await pending;
    assert.ok(page.events.length > 0);
    const resumed = await port.read({ origin: ORIGIN, credential: scope.credential, sessionId: scope.session.sessionId,
      collectionId: COLLECTION, replicaId: scope.replica.replicaId, cursor: page.nextCursor, limit: 50 });
    assert.equal(resumed.events.length, 0);
    await isolated.runtime.pool.query(
      "update collection_members set role='editor' where collection_id=$1 and subject_id=$2",
      [COLLECTION, MEMBER_SUBJECT],
    );
    keys.destroy();
  });

  test('ordinary empty continuation still revalidates revoked authority', async () => {
    const scope = await createScope({ label: `empty-continuation-${randomUUID()}` });
    let armed = false;
    let snapshotSeen!: () => void;
    let release!: () => void;
    const atSnapshot = new Promise<void>((resolve) => { snapshotSeen = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { keys, port } = reader(authorityBarrier('after_snapshot', async () => {
      if (!armed) return;
      snapshotSeen();
      await gate;
    }));
    const first = await port.read({ origin: ORIGIN, credential: scope.credential, sessionId: scope.session.sessionId,
      collectionId: COLLECTION, replicaId: scope.replica.replicaId, cursor: null, limit: 1_000 });
    assert.equal(first.hasMore, false);
    const before = await evidenceCounts(scope.replica.replicaId);
    armed = true;
    const pending = port.read({ origin: ORIGIN, credential: scope.credential, sessionId: scope.session.sessionId,
      collectionId: COLLECTION, replicaId: scope.replica.replicaId, cursor: first.nextCursor, limit: 1_000 });
    await atSnapshot;
    await isolated.runtime.pool.query(
      'update sync_extension_credentials set revoked_at=clock_timestamp() where credential_id=$1',
      [scope.credential.credentialId],
    );
    release();
    await assert.rejects(pending, (error: unknown) => (
      error instanceof SyncPullReadError && error.code === 'not_found'
    ));
    assert.deepEqual(await evidenceCounts(scope.replica.replicaId), before);
    keys.destroy();
  });

  test('expired-cursor recovery revalidates authority before consuming proof or changing Replica', async () => {
    const scope = await createScope({ label: `expired-recovery-${randomUUID()}` });
    let cursorNow = Date.now();
    let armed = false;
    let snapshotSeen!: () => void;
    let release!: () => void;
    const atSnapshot = new Promise<void>((resolve) => { snapshotSeen = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const keys = createSyncPullCursorKeyring({
      active: { id: `expired-recovery-${randomUUID()}`, secret: Buffer.alloc(32, 38).toString('base64') },
      retained: [], ttlMs: 60_000, now: () => cursorNow,
    });
    const port = createPostgresSyncPullReadPort(isolated.runtime.db, keys, {
      cursorNow: () => cursorNow,
      ...authorityBarrier('after_snapshot', async () => {
        if (!armed) return;
        snapshotSeen();
        await gate;
      }),
    });
    const first = await port.read({ origin: ORIGIN, credential: scope.credential, sessionId: scope.session.sessionId,
      collectionId: COLLECTION, replicaId: scope.replica.replicaId, cursor: null, limit: 1_000 });
    const digest = createHash('sha256').update(first.nextCursor, 'utf8').digest('hex');
    await createPostgresSyncAckApplication(isolated.runtime.db, {
      leaseExtensionSeconds: 600, maxLeaseLifetimeSeconds: 3_600,
    }).acknowledge({
      credential: scope.credential, idempotencyKey: `expired-recovery-ack-${randomUUID()}`,
      origin: ORIGIN, mediaType: 'application/json', endpointIdentity: 'syncAck',
      request: { sessionId: scope.session.sessionId, cursor: first.nextCursor, warnings: [] },
    });
    cursorNow += 120_000;
    armed = true;
    const pending = port.read({ origin: ORIGIN, credential: scope.credential, sessionId: scope.session.sessionId,
      collectionId: COLLECTION, replicaId: scope.replica.replicaId, cursor: first.nextCursor, limit: 1_000 });
    await atSnapshot;
    await isolated.runtime.pool.query(
      'update sync_extension_credentials set revoked_at=clock_timestamp() where credential_id=$1',
      [scope.credential.credentialId],
    );
    release();
    await assert.rejects(pending, (error: unknown) => (
      error instanceof SyncPullReadError && error.code === 'not_found'
    ));
    const replica = await isolated.runtime.db.selectFrom('sync_replicas').select('status')
      .where('replica_id', '=', scope.replica.replicaId).executeTakeFirstOrThrow();
    const proof = await isolated.runtime.db.selectFrom('sync_pull_cursor_recovery_proofs').select('consumed_at')
      .where('replica_id', '=', scope.replica.replicaId).where('cursor_digest', '=', digest)
      .executeTakeFirstOrThrow();
    assert.equal(replica.status, 'active');
    assert.equal(proof.consumed_at, null);
    keys.destroy();
  });

  test('final revalidation uses wall clock after locks are acquired', async () => {
    const scope = await createScope({
      label: `natural-expiry-${randomUUID()}`,
      sessionDurationSeconds: 3,
    });
    const before = await evidenceCounts(scope.replica.replicaId);
    const { keys, port } = reader(authorityBarrier('after_snapshot', async () => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const expiry = await isolated.runtime.pool.query<{ expired: boolean }>(
          `select clock_timestamp() > expires_at as expired
             from sync_sessions
            where session_id = $1`,
          [scope.session.sessionId],
        );
        if (expiry.rows[0]?.expired === true) break;
        assert.ok(Date.now() < deadline, 'database session did not expire before the test deadline');
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }));
    await assert.rejects(port.read({ origin: ORIGIN, credential: scope.credential, sessionId: scope.session.sessionId,
      collectionId: COLLECTION, replicaId: scope.replica.replicaId, cursor: null, limit: 10 }),
    (error: unknown) => error instanceof SyncPullReadError && error.code === 'replica_expired');
    assert.deepEqual(await evidenceCounts(scope.replica.replicaId), before);
    keys.destroy();
  });

  test('two replicas on large pages both reach finalization before completing', async () => {
    const suffix = randomUUID();
    const first = await createScope({ label: `dual-a-${suffix}` });
    const second = await createScope({ label: `dual-b-${suffix}` });
    await seedOperationBatch(`dual-${suffix}`, 400_000, 120, first.replica.replicaId);
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const barrier = authorityBarrier('before_finalization', async () => {
      arrived += 1;
      if (arrived === 2) release();
      await gate;
    });
    const readerA = reader(barrier);
    const readerB = reader(barrier);
    const inputA = { origin: ORIGIN, credential: first.credential, sessionId: first.session.sessionId,
      collectionId: COLLECTION, replicaId: first.replica.replicaId, cursor: null, limit: 100 };
    const inputB = { origin: ORIGIN, credential: second.credential, sessionId: second.session.sessionId,
      collectionId: COLLECTION, replicaId: second.replica.replicaId, cursor: null, limit: 100 };
    const [pageA, pageB] = await Promise.all([readerA.port.read(inputA), readerB.port.read(inputB)]);
    assert.equal(arrived, 2);
    assert.ok(pageA.events.length > 0);
    assert.ok(pageB.events.length > 0);
    readerA.keys.destroy();
    readerB.keys.destroy();
  }, 30_000);

  test('Pull page build overlaps concurrent Push without deadlock and rejects stale finalization', async () => {
    const scope = await createScope({ label: 'pull-push-race' });
    const pushScope = await createScope({
      label: 'pull-push-push', accountId: ACCOUNT, requestedScopes: ['sync:push', 'sync:pull'],
    });
    const pushTarget = await seedPushFolder();
    await insertOperation(`push-race-anchor-${randomUUID()}`, 500_000, scope.replica.replicaId);
    await insertOperation(`push-race-op-${randomUUID()}`, 500_001, scope.replica.replicaId);
    const push = createPostgresSyncPushApplication(isolated.runtime.db, pushScope.issuer, {
      conflictPayloadEncryption: { key: Buffer.alloc(32, 71), keyVersion: 7 },
    });
    const pushRequest = (opId: string) => syncNodeUpdatePushRequest({
      sessionId: pushScope.session.sessionId, replicaId: pushScope.replica.replicaId,
      collectionId: COLLECTION, opId, targetId: pushTarget.id, baseRevision: pushTarget.revision,
      base: { title: pushTarget.title }, value: { title: 'After during pull race' },
    });
    let releasePull!: () => void;
    const pullGate = new Promise<void>((resolve) => { releasePull = resolve; });
    let snapshotSeen!: () => void;
    const atSnapshot = new Promise<void>((resolve) => { snapshotSeen = resolve; });
    const before = await evidenceCounts(scope.replica.replicaId);
    const { keys, port } = reader(authorityBarrier('after_snapshot', async () => {
      snapshotSeen();
      await pullGate;
    }));
    const pendingPull = port.read({ origin: ORIGIN, credential: scope.credential, sessionId: scope.session.sessionId,
      collectionId: COLLECTION, replicaId: scope.replica.replicaId, cursor: null, limit: 10 });
    await atSnapshot;
    const pushOpId = `push-during-pull-${randomUUID()}`;
    const pendingPush = push.admit({
      credential: pushScope.credential, idempotencyKey: `push-during-pull-key-${randomUUID()}`,
      origin: ORIGIN, mediaType: 'application/json', endpointIdentity: 'syncPush',
      request: pushRequest(pushOpId),
    });
    releasePull();
    const [pullOutcome, pushOutcome] = await Promise.allSettled([pendingPull, pendingPush]);
    assert.ok(pullOutcome.status === 'fulfilled' || pullOutcome.status === 'rejected');
    assert.equal(pushOutcome.status, 'fulfilled');
    if (pullOutcome.status === 'rejected') {
      assert.ok(pullOutcome.reason instanceof SyncPullReadError);
      assert.notEqual(pullOutcome.reason.code, 'integrity_failure');
      assert.deepEqual(await evidenceCounts(scope.replica.replicaId), before);
    } else {
      assert.ok(pullOutcome.value.events.length > 0);
    }
    keys.destroy();
  }, 20_000);

  test('retirement serializes against Pull finalization without leaving pull evidence', async () => {
    const scope = await createScope({ label: 'pull-retire-order' });
    await insertOperation(`retire-order-anchor-${randomUUID()}`, 600_000, scope.replica.replicaId);
    await insertOperation(`retire-order-op-${randomUUID()}`, 600_001, scope.replica.replicaId);
    let enteredRetire!: () => void;
    const atReplicaWrite = new Promise<void>((resolve) => { enteredRetire = resolve; });
    let releaseRetire!: () => void;
    const retireBlocked = new Promise<void>((resolve) => { releaseRetire = resolve; });
    const retirement = createPostgresReplicaRetirementApplication(isolated.runtime.db, {
      faultInjector: { async afterPhase(phase) {
        if (phase === 'replica') { enteredRetire(); await retireBlocked; }
      } },
    }).retireExtension({ origin: ORIGIN, credential: scope.credential, sessionId: scope.session.sessionId,
      idempotencyKey: `retire-order-${randomUUID()}`, requestFingerprint: 'retire-order-race' });
    let releasePull!: () => void;
    const pullGate = new Promise<void>((resolve) => { releasePull = resolve; });
    let snapshotSeen!: () => void;
    const atSnapshot = new Promise<void>((resolve) => { snapshotSeen = resolve; });
    const before = await evidenceCounts(scope.replica.replicaId);
    const { keys, port } = reader(authorityBarrier('after_snapshot', async () => {
      snapshotSeen();
      await pullGate;
    }));
    const pendingPull = port.read({ origin: ORIGIN, credential: scope.credential, sessionId: scope.session.sessionId,
      collectionId: COLLECTION, replicaId: scope.replica.replicaId, cursor: null, limit: 10 });
    await atSnapshot;
    releasePull();
    await atReplicaWrite;
    const pullRejected = assert.rejects(pendingPull, /retired|stale|not_found|authorization/iu);
    releaseRetire();
    await retirement;
    await pullRejected;
    assert.deepEqual(await evidenceCounts(scope.replica.replicaId), before);
    const stored = await isolated.runtime.db.selectFrom('sync_replicas').select('status')
      .where('replica_id', '=', scope.replica.replicaId).executeTakeFirstOrThrow();
    assert.equal(stored.status, 'retired');
    keys.destroy();
  });

  test('abort during finalization leaves checkpoint unchanged and writes no evidence', async () => {
    const scope = await createScope({ label: 'pull-abort' });
    const before = (await isolated.runtime.pool.query(`select checkpoint_cursor,checkpoint_commit_ordinal
      from sync_replicas where replica_id=$1`, [scope.replica.replicaId])).rows[0];
    const beforeEvidence = await evidenceCounts(scope.replica.replicaId);
    const blocker = await isolated.runtime.pool.connect();
    await blocker.query('begin');
    await blocker.query('select session_id from sync_sessions where session_id=$1 for update', [scope.session.sessionId]);
    const controller = new AbortController();
    const { keys, port } = reader();
    const pending = port.read({ origin: ORIGIN, credential: scope.credential, sessionId: scope.session.sessionId,
      collectionId: COLLECTION, replicaId: scope.replica.replicaId, cursor: null, limit: 10,
      signal: controller.signal, timeoutMs: 5_000 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort(new DOMException('client disconnected', 'AbortError'));
    await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
    await blocker.query('rollback');
    blocker.release();
    const after = (await isolated.runtime.pool.query(`select checkpoint_cursor,checkpoint_commit_ordinal
      from sync_replicas where replica_id=$1`, [scope.replica.replicaId])).rows[0];
    assert.deepEqual(after, before);
    assert.deepEqual(await evidenceCounts(scope.replica.replicaId), beforeEvidence);
    keys.destroy();
  });

  test('statement timeout during page build fails closed without evidence', async () => {
    const scope = await createScope({ label: 'pull-timeout' });
    const ordinalBase = 700_000 + (Date.now() % 100_000);
    await insertOperation(`timeout-anchor-${randomUUID()}`, ordinalBase, scope.replica.replicaId);
    await insertOperation(`timeout-op-${randomUUID()}`, ordinalBase + 1, scope.replica.replicaId);
    const before = await evidenceCounts(scope.replica.replicaId);
    const { keys, port } = reader({
      authorityFaultInjector: {
        async afterPhase(phase, transaction) {
          if (phase === 'after_snapshot') await sql`select pg_sleep(0.15)`.execute(transaction);
        },
      },
    });
    const pending = port.read({ origin: ORIGIN, credential: scope.credential, sessionId: scope.session.sessionId,
      collectionId: COLLECTION, replicaId: scope.replica.replicaId, cursor: null, limit: 10, timeoutMs: 50 });
    await assert.rejects(pending);
    assert.deepEqual(await evidenceCounts(scope.replica.replicaId), before);
    keys.destroy();
  });

});
