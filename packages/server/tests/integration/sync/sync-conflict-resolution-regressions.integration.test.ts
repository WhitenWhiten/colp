import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'vitest';
import {
  RESOURCE_PAYLOAD_SCHEMA_VERSION,
  materializeCollectionPayload,
  materializeNodePayload,
} from '../../../src/modules/collections/index.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresReplicaStore,
  createPostgresSyncSessionIssuer,
  createPostgresSyncPullReadPort,
  createPostgresSyncAckApplication,
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

import { createSyncPullCursorKeyring } from '../../../src/modules/sync/index.js';

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

describeWithPostgres('Conflict resolution preserves Pull integrity and concurrent node edits', () => {
  let isolated: IsolatedPostgresRuntime;
  let replicaId: string;
  let sessionId: string;
  let credential: Awaited<ReturnType<typeof mintVerifiedExtensionCredentialFixture>>;

  beforeEach(async () => {
    isolated = await createIsolatedPostgresRuntime('sync_conflict_regressions');
    await runMigrations(isolated.runtime.db, 'latest');
    await seedCollection();
    await seedAuthority();
  }, 120_000);

  afterEach(async () => isolated?.close());

  test('incoming cannot overwrite a same-field edit committed after the conflict opened', async () => {
    const id = await openConflict('stale-decision', 'stale-incoming', 10);
    await isolated.runtime.pool.query(`update nodes set title='Later title', resource_revision='target-r2',
      payload_json=jsonb_set(jsonb_set(payload_json,'{title}','"Later title"'),'{resourceRevision}','"target-r2"') where id=$1`, [TARGET]);
    const result = await resolve(id, 'incoming');
    assert.equal(result.outcome, 'refused');
    assert.match(result.error, /precondition_failed/);
    assert.equal(result.nodeTitle, 'Later title');
    assert.equal(result.conflictStatus, 'open');
    assert.equal(result.resolvedByOperationId, null);
    const server = await resolve(id, 'server');
    assert.equal(server.outcome, 'resolved', server.error);
    assert.equal(server.nodeTitle, 'Later title');
  });

  test('incoming preserves a later edit to an unrelated field', async () => {
    const id = await openConflict('unrelated-decision', 'unrelated-incoming', 11);
    await isolated.runtime.pool.query(`update nodes set url='https://later.test/', resource_revision='target-r2',
      payload_json=jsonb_set(jsonb_set(payload_json,'{url}','"https://later.test/"'),'{resourceRevision}','"target-r2"') where id=$1`, [TARGET]);
    const result = await resolve(id, 'incoming');
    assert.equal(result.outcome, 'resolved', result.error);
    assert.equal(result.nodeTitle, 'Stale-epoch edit');
    const node = (await isolated.runtime.pool.query('select url from nodes where id=$1', [TARGET])).rows[0];
    assert.equal(node.url, 'https://later.test/');
  });

  test('server dismiss publishes a resolved conflict without a deletion effect and Pull advances', async () => {
    const conflictId = await openConflict('dismiss-conflict', 'dismiss-incoming', 1, 'delete_update');
    await isolated.runtime.pool.query(`update collections set commit_ordinal=greatest(commit_ordinal,1),
      payload_json=jsonb_set(payload_json,'{commitOrdinal}',to_jsonb(greatest(commit_ordinal,1)::text)) where id=$1`, [COLLECTION]);
    await isolated.runtime.pool.query(`update nodes set deleted_at=now(), deleted_commit_ordinal=1,
      payload_json=jsonb_set(payload_json,'{deletedAt}',to_jsonb(now())) where id=$1`, [TARGET]);
    const keys = createSyncPullCursorKeyring({ active: { id: 'dismiss-pull', secret: Buffer.alloc(32, 37).toString('base64') }, retained: [], ttlMs: 60000 });
    try {
      const port = createPostgresSyncPullReadPort(isolated.runtime.db, keys);
      const input = { credential, sessionId, collectionId: COLLECTION, replicaId, cursor: null, limit: 1 };
      const opened = await port.read(input);
      assert.equal(opened.events[0]?.kind, 'conflict');
      const result = await resolve(conflictId, 'server');
      assert.equal(result.outcome, 'resolved', result.error);
      const ledger = (await isolated.runtime.pool.query(`select o.sync_wire_present, p.sync_wire_json
        from operations o join operation_payloads p using(operation_id) where o.operation_id=$1`, [result.resolvedByOperationId])).rows[0];
      assert.equal(ledger.sync_wire_present, false);
      assert.equal(ledger.sync_wire_json, null);
      const resolved = await port.read({ ...input, cursor: opened.nextCursor });
      assert.equal(resolved.events.length, 1);
      const event = resolved.events[0]!;
      assert.equal(event.kind, 'conflict');
      if (event.kind === 'conflict') assert.equal(event.conflict!.status, 'resolved');
      assert.notEqual(resolved.nextCursor, opened.nextCursor);
      const combined = await port.read({ ...input, cursor: null, limit: 10 });
      assert.deepEqual(combined.events.map(event => event.kind === 'conflict' ? event.conflict!.status : event.kind), ['open', 'resolved']);
      const replay = await resolve(conflictId, 'server');
      assert.equal(replay.resolvedByOperationId, result.resolvedByOperationId);
      const empty = await port.read({ ...input, cursor: resolved.nextCursor });
      assert.deepEqual(empty.events, []);
      const ack = await createPostgresSyncAckApplication(isolated.runtime.db, {
        leaseExtensionSeconds: 600, maxLeaseLifetimeSeconds: 3600,
      }).acknowledge({ credential, idempotencyKey: 'dismiss-ack', origin: ORIGIN,
        mediaType: 'application/json', endpointIdentity: 'syncAck',
        request: { sessionId, cursor: resolved.nextCursor, warnings: [] } });
      assert.equal(ack.ackedCursor, resolved.nextCursor);
    } finally { keys.destroy(); }
  });

  test('historical effectless dismiss wires are read as resolved conflicts', async () => {
    const conflictId = await openConflict('legacy-dismiss', 'legacy-incoming', 1, 'delete_update');
    const opId = 'legacy-dismiss-operation';
    const wire = { opId, replicaId, sequence: 1, collectionId: COLLECTION, type: 'delete_node',
      targetId: TARGET, baseRevision: 'target-r1', occurredAt: '2026-08-20T06:02:00Z',
      dependencies: ['legacy-incoming'], payload: { reason: 'conflict-dismissed' },
      source: { adapterProfile: 'known-conflict-resolution' } };
    const conflict = { id: conflictId, collectionId: COLLECTION, targetId: TARGET, type: 'delete_update',
      field: '/deletedAt', incomingOpId: 'legacy-incoming', createdAt: '2026-08-20T06:02:00Z',
      status: 'resolved', allowedResolutions: ['server'], revision: 'conflict-resolved-2' };
    await isolated.runtime.pool.query("insert into resource_id_ledger(resource_id,resource_type) values ($1,'operation')", [opId]);
    await insertTestOperation(isolated.runtime.db, { operationId: opId, collectionId: COLLECTION,
      commitOrdinal: 2n, operationType: 'sync.conflict.dismissed', payloadJson: { action: 'dismiss' },
      syncWireJson: wire, actorPrincipalId: ACCOUNT });
    await isolated.runtime.pool.query(`update sync_conflicts set status='resolved', revision='conflict-resolved-2',
      resolved_by_operation_id=$2, resolved_by_principal_id=$3, resolution='server',
      resolution_result_json=$4, resolved_at=now() where conflict_id=$1`,
    [conflictId, opId, ACCOUNT, { conflict, operation: wire, cursor: 'sync-conflict-resolution-2' }]);
    await isolated.runtime.pool.query(`update collections set commit_ordinal=2,
      payload_json=jsonb_set(payload_json,'{commitOrdinal}','"2"') where id=$1`, [COLLECTION]);
    const keys = createSyncPullCursorKeyring({ active: { id: 'legacy-dismiss-pull', secret: Buffer.alloc(32, 38).toString('base64') }, retained: [], ttlMs: 60000 });
    try {
      const port = createPostgresSyncPullReadPort(isolated.runtime.db, keys);
      const input = { credential, sessionId, collectionId: COLLECTION, replicaId, cursor: null, limit: 1 };
      const opened = await port.read(input);
      const resolved = await port.read({ ...input, cursor: opened.nextCursor });
      assert.equal(resolved.events.length, 1);
      const event = resolved.events[0]!;
      assert.equal(event.kind, 'conflict');
      if (event.kind === 'conflict') assert.equal(event.conflict!.status, 'resolved');
      assert.deepEqual((await port.read({ ...input, cursor: resolved.nextCursor })).events, []);
    } finally { keys.destroy(); }
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
      await application.resolve({
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
      tombstoneRetentionSeconds: 86_400, maxBatchOperations: 1 as const,
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
        annotations: 'sidecar', maxBatchOperations: 1 as const,
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
      binding: replica.binding, requestedScopes: ['sync:pull', 'sync:push'], origin: ORIGIN, protocolVersion: '0.2',
    });
    sessionId = issued.session.sessionId;
  }

  /** Inserts a conflict whose private payload is genuinely decryptable. */
  async function openConflict(conflictId: string, operationId: string, ordinal: number, type: 'concurrent_field_update' | 'delete_update' = 'concurrent_field_update'): Promise<string> {
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
    const conflictingFields = type === 'delete_update' ? ['/deletedAt'] : ['/title'];
    const menu = type === 'delete_update' ? ['server'] : ['server', 'incoming', 'custom'];
    const binding = (await isolated.runtime.pool.query(
      'select lease_generation from sync_session_bindings where session_id = $1', [sessionId],
    )).rows[0];
    const leaseGeneration = String(binding.lease_generation);
    const plaintext = stableJson({
      base: { title: 'Target' }, current: { title: 'Target' },
      incoming: { title: 'Stale-epoch edit' }, nodeKind: 'bookmark',
    }, invalid);
    const encrypted = encryptPrivatePayload(plaintext, KEYRING.active, {
      collectionId: COLLECTION, replicaId, leaseGeneration, sessionId, operationId,
      targetId: TARGET, conflictId, commitOrdinal: String(ordinal),
      conflictType: type, conflictingFields: stableJson(conflictingFields, invalid),
      nodeKind: 'bookmark', baseRevision: 'target-r1', currentRevision: 'target-r1',
      keyVersion: '7',
    });
    const pullWire = {
      id: conflictId, collectionId: COLLECTION, targetId: TARGET,
      type, field: conflictingFields[0], incomingOpId: operationId,
      createdAt: '2026-08-20T06:02:00Z', status: 'open',
      allowedResolutions: menu, revision: 'conflict-r1',
    };
    await isolated.runtime.pool.query(`insert into sync_conflicts
      (conflict_id,collection_id,replica_id,session_id,operation_id,target_id,base_revision,
       trusted_base_revision,current_revision,conflict_type,conflicting_fields,base_projection,
       current_projection,incoming_projection,private_payload_ciphertext,private_payload_iv,
       private_payload_auth_tag,private_payload_key_version,private_payload_digest,
       allowed_resolutions,pull_wire_json,status,revision,commit_ordinal)
      values ($1,$2,$3,$4,$5,$6,'target-r1',null,'target-r1',$15,$7,
       '{"fields":["/title"]}','{"fields":["/title"]}','{"fields":["/title"]}',
       $8,$9,$10,7,$11,$12,$13,'open','conflict-r1',$14)`,
    [
      conflictId, COLLECTION, replicaId, sessionId, operationId, TARGET,
      JSON.stringify(conflictingFields), encrypted.ciphertext, encrypted.iv, encrypted.authTag,
      encrypted.digest, JSON.stringify(menu), pullWire, ordinal, type,
    ]);
    await isolated.runtime.pool.query(`update collections set commit_ordinal=greatest(commit_ordinal,$2),
      payload_json=jsonb_set(payload_json,'{commitOrdinal}',to_jsonb(greatest(commit_ordinal,$2)::text)) where id=$1`, [COLLECTION, ordinal]);
    return conflictId;
  }
});
