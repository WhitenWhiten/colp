import { sql } from 'kysely';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import type { Operation } from '@know-n/colp/types';
import { createPostgresCanonicalMutationPorts } from '../../../src/infrastructure/collections/canonical-mutation-postgres-ports.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createUnitOfWork } from '../../../src/infrastructure/database/unit-of-work.js';
import { insertTestOperation } from '../../support/ledger-split-writes.js';
import {
  createPostgresReplicaStore,
  createPostgresSyncPullReadPort,
  createPostgresSyncPushApplication,
  createPostgresSyncSessionIssuer,
} from '../../../src/infrastructure/sync/index.js';
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

describeWithPostgres('R07 Pull authority cut and recovery races', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('r07_pull_authority_cut', { maxConnections: 16 });
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

  function reader(options: Parameters<typeof createPostgresSyncPullReadPort>[2] = {}) {
    const keys = createSyncPullCursorKeyring({
      active: { id: `r07-${randomUUID()}`, secret: Buffer.alloc(32, 37).toString('base64') },
      retained: [], ttlMs: 60_000,
    });
    return { keys, port: createPostgresSyncPullReadPort(isolated.runtime.db, keys, options) };
  }

  async function evidenceCounts(replicaId: string): Promise<{ readonly evidence: number; readonly proofs: number }> {
    const evidence = await isolated.runtime.db.selectFrom('sync_pull_cursor_evidence').select('evidence_id')
      .where('replica_id', '=', replicaId).execute();
    const proofs = await isolated.runtime.db.selectFrom('sync_pull_cursor_recovery_proofs').select('proof_id')
      .where('replica_id', '=', replicaId).execute();
    return { evidence: evidence.length, proofs: proofs.length };
  }

  test('a sync commit between the event cut and the authority lock stays on the next page', async () => {
    const scope = await createScope({ label: `u10-cut-${randomUUID()}` });
    const pushScope = await createScope({
      label: `u10-push-${randomUUID()}`, requestedScopes: ['sync:push', 'sync:pull'],
    });
    const pushTarget = await seedPushFolder('Before');
    let holdFinalization = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const atCut = new Promise<void>((resolve) => { entered = resolve; });
    const { keys, port } = reader({
      authorityFaultInjector: {
        async afterPhase(phase) {
          if (phase !== 'before_finalization' || !holdFinalization) return;
          holdFinalization = false;
          entered();
          await gate;
        },
      },
    });
    const input = { credential: scope.credential, sessionId: scope.session.sessionId,
      collectionId: COLLECTION, replicaId: scope.replica.replicaId };
    let cursor: string | null = null;
    let cutRevision = '';
    for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
      const drained = await port.read({ ...input, cursor, limit: 1_000 });
      cursor = drained.nextCursor;
      cutRevision = drained.collectionRevision;
      if (!drained.hasMore) break;
      assert.notEqual(pageNumber, 19, 'the pre-commit stream did not fit in the drain budget');
    }
    assert.equal(typeof cursor, 'string');
    holdFinalization = true;
    const pending = port.read({ ...input, cursor, limit: 1_000 });
    try {
      await new Promise<void>((resolve, reject) => {
        atCut.then(resolve, reject);
        pending.then(() => reject(new Error('pull finished before the authority recheck')), reject);
      });
      // Fixture inserts can sit ahead of collections.commit_ordinal. Advance that
      // ordinal, and the payload copy of it, to the stream head so a real push
      // commits strictly after this cut without an authority mismatch.
      await isolated.runtime.pool.query(`UPDATE collections AS collection
        SET commit_ordinal = aligned.ordinal,
            payload_json = jsonb_set(collection.payload_json, '{commitOrdinal}', to_jsonb(aligned.ordinal::text))
        FROM (
          SELECT GREATEST(collection.commit_ordinal,
            COALESCE((SELECT MAX(operation.commit_ordinal) FROM operations operation
              WHERE operation.collection_id = collection.id), 0),
            COALESCE((SELECT MAX(conflict.commit_ordinal) FROM sync_conflicts conflict
              WHERE conflict.collection_id = collection.id), 0)) AS ordinal
          FROM collections AS collection
          WHERE collection.id = $1
        ) AS aligned
        WHERE collection.id = $1`, [COLLECTION]);
      const pushOpId = `u10-push-${randomUUID()}`;
      const push = createPostgresSyncPushApplication(isolated.runtime.db, pushScope.issuer, {
        conflictPayloadEncryption: { key: Buffer.alloc(32, 71), keyVersion: 7 },
      });
      const pushed = await push.admit({
        credential: pushScope.credential, idempotencyKey: `u10-push-key-${randomUUID()}`,
        origin: ORIGIN, mediaType: 'application/json', endpointIdentity: 'syncPush',
        request: syncNodeUpdatePushRequest({
          sessionId: pushScope.session.sessionId, replicaId: pushScope.replica.replicaId,
          collectionId: COLLECTION, opId: pushOpId, targetId: pushTarget.id,
          baseRevision: pushTarget.revision, base: { title: pushTarget.title },
          value: { title: 'After the cut' },
        }),
      });
      assert.equal(pushed.results[0]?.status, 'applied');
      const head = await isolated.runtime.pool.query<{ content_revision: string }>(
        'select content_revision from collections where id=$1', [COLLECTION]);
      const headRevision = head.rows[0]?.content_revision;
      assert.equal(typeof headRevision, 'string');
      assert.notEqual(headRevision, cutRevision);
      release();
      const page = await pending;
      assert.equal(page.events.length, 0);
      assert.equal(page.hasMore, false);
      assert.equal(page.nextCursor, cursor);
      assert.equal(page.collectionRevision, cutRevision);
      const next = await port.read({ ...input, cursor: page.nextCursor, limit: 1_000 });
      const delivered = next.events.find((event) => event.kind === 'operation' && event.operation.opId === pushOpId);
      assert.ok(delivered && delivered.kind === 'operation');
      assert.equal(next.hasMore, false);
      assert.equal(next.collectionRevision, headRevision);
      assert.equal(next.nextCursor, delivered.cursor);
      assert.notEqual(next.nextCursor, page.nextCursor);
    } finally {
      release();
      await pending.catch(() => undefined);
      keys.destroy();
    }
  });

  test('a product change that requires recovery still rejects the pre-cut authorization', async () => {
    const scope = await createScope({ label: `u10-recovery-${randomUUID()}` });
    await insertOperation(`u10-recovery-${randomUUID()}`, 910_000 + (Date.now() % 10_000), scope.replica.replicaId);
    const before = await evidenceCounts(scope.replica.replicaId);
    const prior = await isolated.runtime.pool.query<{ content_revision: string }>(
      'select content_revision from collections where id=$1', [COLLECTION]);
    const priorRevision = prior.rows[0]?.content_revision;
    assert.equal(typeof priorRevision, 'string');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const atCut = new Promise<void>((resolve) => { entered = resolve; });
    const { keys, port } = reader({
      authorityFaultInjector: {
        async afterPhase(phase) {
          if (phase !== 'before_finalization') return;
          entered();
          await gate;
        },
      },
    });
    const pending = port.read({ credential: scope.credential, sessionId: scope.session.sessionId,
      collectionId: COLLECTION, replicaId: scope.replica.replicaId, cursor: null, limit: 50 });
    try {
      await new Promise<void>((resolve, reject) => {
        atCut.then(resolve, reject);
        pending.then(() => reject(new Error('pull finished before the authority recheck')), reject);
      });
      const recoveryRevision = `u10-recovery-${randomUUID()}`;
      await createUnitOfWork(isolated.runtime.db).execute(async ({ transaction }) => {
        const ports = createPostgresCanonicalMutationPorts(transaction, {
          invalidateSyncReplicasOnNodeMutation: true,
        });
        const locked = await ports.collectionLock.lockForCanonicalMutation(transaction, COLLECTION);
        assert.ok(locked);
        await transaction.updateTable('collections').set({ content_revision: recoveryRevision })
          .where('id', '=', COLLECTION).execute();
        await transaction.updateTable('sync_replicas').set({
          status: 'recovery_required',
          lifecycle_revision: sql<bigint>`lifecycle_revision + 1`,
          wire_json: sql<Record<string, unknown>>`jsonb_set(
            wire_json, '{status}', '"recovery_required"'::jsonb, true)`,
        }).where('replica_id', '=', scope.replica.replicaId).where('status', '=', 'active').execute();
      });
      release();
      await assert.rejects(pending, (error: unknown) => (
        error instanceof SyncPullReadError && error.code === 'recovery_required'
      ));
      assert.deepEqual(await evidenceCounts(scope.replica.replicaId), before);
      const stored = await isolated.runtime.db.selectFrom('sync_replicas').select('status')
        .where('replica_id', '=', scope.replica.replicaId).executeTakeFirstOrThrow();
      assert.equal(stored.status, 'recovery_required');
    } finally {
      release();
      await pending.catch(() => undefined);
      await isolated.runtime.pool.query(
        'update collections set content_revision=$2 where id=$1', [COLLECTION, priorRevision]);
      keys.destroy();
    }
  });
});
