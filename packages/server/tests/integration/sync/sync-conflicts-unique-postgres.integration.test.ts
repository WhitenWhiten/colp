/**
 * Runtime UNIQUE proof for `sync_conflicts`.
 *
 * `tests/unit/sync/sync-conflict-migration-static.test.ts` pins UNIQUE tokens in
 * migration source. This suite inserts a valid row after latest migrations,
 * then proves a duplicate `operation_id` and a duplicate
 * `(collection_id, commit_ordinal, conflict_id)` fail with SQLSTATE 23505.
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import {
  RESOURCE_PAYLOAD_SCHEMA_VERSION,
  materializeCollectionPayload,
  materializeNodePayload,
} from '../../../src/modules/collections/index.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { insertTestOperation } from '../../support/ledger-split-writes.js';
import {
  createPostgresReplicaStore,
  createPostgresSyncSessionIssuer,
} from '../../../src/infrastructure/sync/index.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const ISSUER = 'https://issuer.example';
const ACCOUNT = 'sc-unique-account';
const SUBJECT = 'sc-unique-subject';
const COLLECTION = 'sc-unique-collection';
const ROOT = 'sc-unique-root';
const TARGET = 'sc-unique-root-target';
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const DIGEST = 'A'.repeat(43);
const CIPHER = Buffer.from('01', 'hex');
const IV = Buffer.alloc(12);
const TAG = Buffer.alloc(16);

describeWithPostgres('sync_conflicts UNIQUE constraints (real PostgreSQL)', () => {
  let isolated: IsolatedPostgresRuntime;
  let replicaId: string;
  let sessionId: string;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('sync_conflicts_unique');
    await runMigrations(isolated.runtime.db, 'latest');
    await seedCollection();
    const scope = await createScope();
    replicaId = scope.replicaId;
    sessionId = scope.sessionId;
  }, 120_000);

  afterAll(async () => isolated?.close());

  test('duplicate operation_id is SQLSTATE 23505', async () => {
    await insertOperation('sc-unique-op-operation', 11);
    await insertConflict({
      conflictId: 'sc-unique-conflict-operation',
      operationId: 'sc-unique-op-operation',
      ordinal: 11,
    });
    await assertUniqueViolation(
      () => insertConflict({
        conflictId: 'sc-unique-conflict-operation-dup',
        operationId: 'sc-unique-op-operation',
        ordinal: 12,
      }),
      'duplicate operation_id must violate UNIQUE (operation_id)',
    );
  });

  test('duplicate (collection_id, commit_ordinal, conflict_id) is SQLSTATE 23505', async () => {
    await insertOperation('sc-unique-op-triple', 21);
    await insertConflict({
      conflictId: 'sc-unique-conflict-triple',
      operationId: 'sc-unique-op-triple',
      ordinal: 21,
    });
    await insertOperation('sc-unique-op-triple-other', 22);
    await assertUniqueViolation(
      () => insertConflict({
        conflictId: 'sc-unique-conflict-triple',
        operationId: 'sc-unique-op-triple-other',
        ordinal: 21,
        reserveLedger: false,
      }),
      'duplicate (collection_id, commit_ordinal, conflict_id) must be rejected',
    );
  });

  async function seedCollection(): Promise<void> {
    const now = new Date('2026-08-20T06:00:00Z');
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
      await client.query(
        "insert into resource_id_ledger(resource_id,resource_type) values ($1,'collection'),($2,'node'),($3,'node')",
        [COLLECTION, ROOT, TARGET],
      );
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
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async function createScope(): Promise<{ replicaId: string; sessionId: string }> {
    await isolated.runtime.pool.query(
      "insert into accounts(id,subject_id,status) values ($1,$2,'active')",
      [ACCOUNT, SUBJECT],
    );
    await isolated.runtime.pool.query(
      "insert into profile_handles(handle,account_id) values ('sc_unique',$1)",
      [ACCOUNT],
    );
    await isolated.runtime.pool.query(
      `insert into account_identities(id,account_id,issuer,subject)
        values ('sc-unique-identity',$1,$2,'sc-unique-oidc')`,
      [ACCOUNT, ISSUER],
    );
    const credential = await mintVerifiedExtensionCredentialFixture({
      issuer: ISSUER, audience: 'known-api', clientId: 'known-extension',
      subject: 'sc-unique-oidc', credentialId: 'sc-unique-credential',
    });
    const replica = await createPostgresReplicaStore(isolated.runtime.db, {
      ids: {
        deviceId: () => 'sc-unique-device',
        replicaId: () => 'sc-unique-replica',
        leaseId: () => 'sc-unique-lease',
      },
    }).create({
      accountId: ACCOUNT, collectionId: COLLECTION, deviceName: 'UNIQUE device',
      replicaName: 'UNIQUE replica', kind: 'browser_extension',
      adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: {
        read: true, write: true, events: true, separator: true, alias: false,
        annotations: 'sidecar', maxBatchOperations: 1,
      },
      binding: {
        browserProfileId: 'sc-unique-profile', mountMode: 'whole-profile',
        browserGeneration: 'generation-1',
      },
      leaseDurationSeconds: 3_600,
    }, { actorAccountId: ACCOUNT });
    const issued = await createPostgresSyncSessionIssuer(isolated.runtime.db, {
      issuer: ISSUER, audience: 'known-api', clientId: 'known-extension',
      replayEncryptionKey: Buffer.alloc(32, 23), replayEncryptionKeyVersion: 1,
      sessionDurationSeconds: 900, replicaLeaseExtensionSeconds: 3_600,
      tombstoneRetentionSeconds: 86_400, maxBatchOperations: 1,
      endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'],
    }).issue({
      credential, idempotencyKey: 'sc-unique-session',
      requestFingerprint: 'sc-unique-session-fingerprint',
      collectionId: COLLECTION, replicaId: replica.replicaId,
      expectedLeaseGeneration: replica.leaseGeneration,
      expectedLifecycleRevision: replica.lifecycleRevision,
      binding: replica.binding, requestedScopes: ['sync:pull'], origin: ORIGIN,
    });
    return { replicaId: replica.replicaId, sessionId: issued.session.sessionId };
  }

  async function insertOperation(operationId: string, ordinal: number): Promise<void> {
    await isolated.runtime.pool.query(
      "insert into resource_id_ledger(resource_id,resource_type) values ($1,'operation')",
      [operationId],
    );
    await insertTestOperation(isolated.runtime.db, {
      operationId, collectionId: COLLECTION, commitOrdinal: BigInt(ordinal),
      operationType: 'sync.node.update', payloadJson: { action: 'update' },
      actorPrincipalId: ACCOUNT,
    });
  }

  async function insertConflict(input: {
    readonly conflictId: string;
    readonly operationId: string;
    readonly ordinal: number;
    readonly reserveLedger?: boolean;
  }): Promise<void> {
    if (input.reserveLedger !== false) {
      await isolated.runtime.pool.query(
        "insert into resource_id_ledger(resource_id,resource_type) values ($1,'event')",
        [input.conflictId],
      );
    }
    const pullWire = {
      id: input.conflictId, collectionId: COLLECTION, targetId: TARGET,
      type: 'concurrent_field_update', field: '/title', incomingOpId: input.operationId,
      createdAt: '2026-08-20T06:02:00Z', status: 'open',
      allowedResolutions: ['server', 'incoming', 'custom'], revision: 'conflict-r1',
    };
    await isolated.runtime.pool.query(`insert into sync_conflicts
      (conflict_id,collection_id,replica_id,session_id,operation_id,target_id,base_revision,
       trusted_base_revision,current_revision,conflict_type,conflicting_fields,base_projection,
       current_projection,incoming_projection,private_payload_ciphertext,private_payload_iv,
       private_payload_auth_tag,private_payload_key_version,private_payload_digest,
       allowed_resolutions,pull_wire_json,status,revision,commit_ordinal)
      values ($1,$2,$3,$4,$5,$6,'target-r1',null,'target-r1','concurrent_field_update','["/title"]',
       '{"fields":["/title"]}','{"fields":["/title"]}','{"fields":["/title"]}',
       $7,$8,$9,1,$10,'["server","incoming","custom"]',$11,'open','conflict-r1',$12)`,
    [
      input.conflictId, COLLECTION, replicaId, sessionId, input.operationId, TARGET,
      CIPHER, IV, TAG, DIGEST, pullWire, input.ordinal,
    ]);
  }
});

async function assertUniqueViolation(run: () => Promise<void>, reason: string): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.equal((error as { code?: string }).code, '23505', `${reason} (expected SQLSTATE 23505)`);
    return true;
  });
}
