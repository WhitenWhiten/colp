/**
 * NV-01 regression: COLP conflict resolution must re-check the account security
 * epoch from the locked rows, exactly like push / retire / ack / pull-authority /
 * session-verify / recovery do.
 *
 * The epoch bump is the durable revoke fact for Sync sessions: password reset,
 * email change, provider link, MFA disable and revoke-all bump
 * `accounts.security_epoch` without writing `sync_extension_credentials.revoked_at`
 * or terminating `sync_sessions`. The entry `sessionIssuer.verify` compares the
 * epoch, but it commits in its own transaction BEFORE the conflict-resolution
 * transaction opens, so a bump committed in that window must be caught again by
 * the locked predicate inside the resolution transaction.
 *
 * This suite models "the entry verify already committed successfully" by handing
 * the resolution application a session issuer whose verify succeeds, then bumps
 * the account epoch to make the locked session/credential snapshots stale.
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import {
  RESOURCE_PAYLOAD_SCHEMA_VERSION,
  materializeCollectionPayload,
  materializeNodePayload,
} from '../../../src/modules/collections/index.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresReplicaStore,
  createPostgresSyncSessionIssuer,
} from '../../../src/infrastructure/sync/index.js';
import { createPostgresSyncConflictResolutionApplication } from '../../../src/infrastructure/sync/sync-conflict-resolution-postgres.js';
import { encryptPrivatePayload } from '../../../src/infrastructure/sync/sync-conflict-postgres.js';
import { stableJson } from '../../../src/infrastructure/sync/sync-conflict-json.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';
import { insertTestOperation } from '../../support/ledger-split-writes.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const ISSUER = 'https://issuer.example';
const ACCOUNT = 'YkaXNaZYPvsLuArdvoYrIQ';
const SUBJECT = 'sc-epoch-subject';
const COLLECTION = 'BIbWqOJEZfitiCgb5of2Ug';
const ROOT = '2f2qw3d8SRRqlBKbWsdEpQ';
const TARGET = 'W6-T13FfkW_Gli9WoaJXDg';
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const KEYRING = { active: { key: Buffer.alloc(32, 71), keyVersion: 7 }, retained: [] } as const;

function invalid(): never {
  throw new Error('invalid');
}

describeWithPostgres('COLP conflict resolution re-authorizes the account security epoch (real PostgreSQL)', () => {
  let isolated: IsolatedPostgresRuntime;
  let replicaId: string;
  let sessionId: string;
  let credential: Awaited<ReturnType<typeof mintVerifiedExtensionCredentialFixture>>;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('sync_conflict_epoch');
    await runMigrations(isolated.runtime.db, 'latest');
    await seedCollection();
    await seedAuthority();
  }, 120_000);

  afterAll(async () => isolated?.close());

  test('a resolution whose locked session epoch is stale must not commit', async () => {
    // Control: with matching epochs the same fixture resolves normally, which
    // proves the fixture itself is valid and the refusal below is about the epoch.
    const controlConflict = await openConflict('sc-epoch-conflict-control', 'sc-epoch-op-control', 31);
    const fresh = await resolve(controlConflict, 'server');
    assert.equal(fresh.outcome, 'resolved', `control: an in-epoch resolution must still resolve (error=${fresh.error}; status=${fresh.conflictStatus})`);

    // The security event: password reset / revoke-all bump the account epoch.
    // The credential stays non-revoked and the account stays active, so the
    // locked predicate's revoked_at and status checks cannot catch it.
    await isolated.runtime.pool.query(
      "update accounts set security_epoch = security_epoch + 1 where id = $1",
      [ACCOUNT],
    );
    const stale = await resolve(await openConflict('sc-epoch-conflict-stale', 'sc-epoch-op-stale', 32));

    assert.equal(
      stale.outcome, 'refused',
      `stale-epoch COLP resolution committed: conflict status=${stale.conflictStatus}, `
      + `resolved_by_operation_id=${stale.resolvedByOperationId}, node title=${JSON.stringify(stale.nodeTitle)}`,
    );
    assert.equal(stale.conflictStatus, 'open', 'the conflict must stay open after a refused resolution');
    assert.equal(stale.nodeTitle, 'Target', 'the target node content must not change');
  });

  test('control: the entry session issuer does reject the same stale epoch', async () => {
    // The entry check is what makes the window narrow; it is not a substitute for
    // the locked re-check, because it already committed before this transaction.
    const issuer = createPostgresSyncSessionIssuer(isolated.runtime.db, issuerOptions());
    await assert.rejects(issuer.verify({ credential, sessionId, collectionId: COLLECTION, replicaId,
    }));
  });

  async function resolve(conflictId: string, resolution: 'server' | 'incoming' = 'incoming'): Promise<{
    outcome: 'resolved' | 'refused'; conflictStatus: string;
    resolvedByOperationId: string | null; nodeTitle: string | null; error: string;
  }> {
    // Models "the entry verify already committed": the entry check passed before
    // the epoch bump, so only the locked predicate inside this transaction can
    // still refuse the write.
    const application = createPostgresSyncConflictResolutionApplication(
      isolated.runtime.db,
      { verify: async () => ({ authorizationScopes: ['sync:push'] }) } as never,
      { conflictPayloadKeyring: KEYRING, managedBookmarkWrites: false },
    );
    let outcome: 'resolved' | 'refused' = 'resolved';
    let error = '';
    try {
      await application.resolve({ origin: ORIGIN,
        credential, sessionId, replicaId, collectionId: COLLECTION, conflictId,
        idempotencyKey: `epoch-${conflictId}`, ifMatch: ['"conflict-r1"'],
        request: { resolution, baseConflictRevision: 'conflict-r1' },
      } as never);
    } catch (thrown) {
      outcome = 'refused';
      error = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown);
    }
    const conflict = (await isolated.runtime.pool.query(
      'select status, resolved_by_operation_id from sync_conflicts where conflict_id = $1',
      [conflictId],
    )).rows[0];
    const node = (await isolated.runtime.pool.query('select title from nodes where id = $1', [TARGET])).rows[0];
    return {
      outcome,
      conflictStatus: conflict?.status ?? 'missing',
      resolvedByOperationId: conflict?.resolved_by_operation_id ?? null,
      nodeTitle: node?.title ?? null,
      error,
    };
  }

  function issuerOptions() {
    return {
      issuer: ISSUER, audience: 'known-api', clientId: 'known-extension',
      replayEncryptionKey: Buffer.alloc(32, 23), replayEncryptionKeyVersion: 1,
      sessionDurationSeconds: 900, replicaLeaseExtensionSeconds: 3_600,
      tombstoneRetentionSeconds: 86_400, maxBatchOperations: 1,
      endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'] as const,
    };
  }

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

  async function seedAuthority(): Promise<void> {
    await isolated.runtime.pool.query(
      "insert into accounts(id,subject_id,status) values ($1,$2,'active')",
      [ACCOUNT, SUBJECT],
    );
    await isolated.runtime.pool.query(
      "insert into profiles(account_id, display_name, avatar_url) values ($1,'Epoch owner',null)",
      [ACCOUNT],
    );
    await isolated.runtime.pool.query(
      "insert into profile_handles(handle,account_id) values ('sc_epoch',$1)",
      [ACCOUNT],
    );
    await isolated.runtime.pool.query(
      "insert into account_identities(id,account_id,issuer,subject) values ('sc-epoch-identity',$1,$2,'sc-epoch-oidc')",
      [ACCOUNT, ISSUER],
    );
    credential = await mintVerifiedExtensionCredentialFixture({
      issuer: ISSUER, audience: 'known-api', clientId: 'known-extension',
      subject: 'sc-epoch-oidc', credentialId: 'sc-epoch-credential',
    });
    const replica = await createPostgresReplicaStore(isolated.runtime.db, {
      ids: {
        deviceId: () => 'sc-epoch-device',
        replicaId: () => 'sc-epoch-replica',
        leaseId: () => 'sc-epoch-lease',
      },
    }).create({
      accountId: ACCOUNT, collectionId: COLLECTION, deviceName: 'Epoch device',
      replicaName: 'Epoch replica', kind: 'browser_extension',
      adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: {
        read: true, write: true, events: true, separator: true, alias: false,
        annotations: 'sidecar', maxBatchOperations: 1,
      },
      binding: {
        browserProfileId: 'sc-epoch-profile', mountMode: 'whole-profile',
        browserGeneration: 'generation-1',
      },
      leaseDurationSeconds: 3_600,
    }, { actorAccountId: ACCOUNT });
    replicaId = replica.replicaId;
    const issued = await createPostgresSyncSessionIssuer(isolated.runtime.db, issuerOptions()).issue({
      credential, idempotencyKey: 'sc-epoch-session',
      requestFingerprint: 'sc-epoch-session-fingerprint',
      collectionId: COLLECTION, replicaId: replica.replicaId,
      expectedLeaseGeneration: replica.leaseGeneration,
      expectedLifecycleRevision: replica.lifecycleRevision,
      binding: replica.binding, requestedScopes: ['sync:pull', 'sync:push'], origin: ORIGIN,
    });
    sessionId = issued.session.sessionId;
  }

  /** Inserts a conflict whose private payload is genuinely decryptable. */
  async function openConflict(conflictId: string, operationId: string, ordinal: number): Promise<string> {
    await isolated.runtime.pool.query(
      "insert into resource_id_ledger(resource_id,resource_type) values ($1,'activity') on conflict do nothing",
      [`${conflictId}-seed`],
    );
    await isolated.runtime.pool.query(
      "insert into resource_id_ledger(resource_id,resource_type) values ($1,'operation')",
      [operationId],
    );
    await insertTestOperation(isolated.runtime.db, {
      operationId, collectionId: COLLECTION, commitOrdinal: BigInt(ordinal),
      operationType: 'sync.node.update', payloadJson: { action: 'update' },
      actorPrincipalId: ACCOUNT,
    });
    await isolated.runtime.pool.query(
      "insert into resource_id_ledger(resource_id,resource_type) values ($1,'event')",
      [conflictId],
    );
    const conflictingFields = ['/title'];
    const binding = (await isolated.runtime.pool.query(
      'select lease_generation from sync_session_bindings where session_id = $1', [sessionId],
    )).rows[0];
    const leaseGeneration = String(binding.lease_generation);
    const plaintext = stableJson({
      base: { title: 'Target' }, current: { title: 'Target' },
      incoming: { title: 'Stale-epoch edit' }, nodeKind: 'bookmark',
    });
    const encrypted = encryptPrivatePayload(plaintext, KEYRING.active, {
      collectionId: COLLECTION, replicaId, leaseGeneration, sessionId, operationId,
      targetId: TARGET, conflictId, commitOrdinal: String(ordinal),
      conflictType: 'concurrent_field_update', conflictingFields: stableJson(conflictingFields, invalid),
      nodeKind: 'bookmark', baseRevision: 'target-r1', currentRevision: 'target-r1',
      keyVersion: '7',
    });
    const pullWire = {
      id: conflictId, collectionId: COLLECTION, targetId: TARGET,
      type: 'concurrent_field_update', field: '/title', incomingOpId: operationId,
      createdAt: '2026-08-20T06:02:00Z', status: 'open',
      allowedResolutions: ['server', 'incoming', 'custom'], revision: 'conflict-r1',
    };
    await isolated.runtime.pool.query(`insert into sync_conflicts
      (conflict_id,collection_id,replica_id,session_id,operation_id,target_id,base_revision,
       trusted_base_revision,current_revision,conflict_type,conflicting_fields,base_projection,
       current_projection,incoming_projection,private_payload_ciphertext,private_payload_iv,
       private_payload_auth_tag,private_payload_key_version,private_payload_digest,
       allowed_resolutions,pull_wire_json,status,revision,commit_ordinal)
      values ($1,$2,$3,$4,$5,$6,'target-r1',null,'target-r1','concurrent_field_update',$7,
       '{"fields":["/title"]}','{"fields":["/title"]}','{"fields":["/title"]}',
       $8,$9,$10,7,$11,$12,$13,'open','conflict-r1',$14)`,
    [
      conflictId, COLLECTION, replicaId, sessionId, operationId, TARGET,
      JSON.stringify(conflictingFields), encrypted.ciphertext, encrypted.iv, encrypted.authTag,
      encrypted.digest, JSON.stringify(['server', 'incoming', 'custom']), pullWire, ordinal,
    ]);
    return conflictId;
  }
});
