import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';



import { afterAll, beforeAll, test } from 'vitest';
import type { Operation } from '@know-n/colp/types';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { insertTestOperation } from '../../support/ledger-split-writes.js';
import { createPostgresReplicaStore, createPostgresSyncPullReadPort, createPostgresSyncSessionIssuer } from '../../../src/infrastructure/sync/index.js';

import { createSyncPullCursorKeyring } from '../../../src/modules/sync/index.js';
import { seedPullCollection } from '../../support/sync-pull-collection-fixture.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';

import { createIsolatedPostgresRuntime, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';


export const ISSUER = 'https://issuer.example';
export const ACCOUNT = 'p3-20-account';
export const SUBJECT = 'p3-20-subject';
export const COLLECTION = 'p3-20-collection';
export const OTHER_COLLECTION = 'p3-20-other-collection';
export const ROOT = 'p3-20-root';
export const TARGET = 'p3-20-root-target';
export const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
export const FOREIGN_ORIGIN = 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
export { migrationDirectoryExcluding, PRODUCTION_MIGRATIONS_DIRECTORY } from '../../support/migration-subset-directory.js';
/** Each suite owns its database and lifecycle; stream-dependent cases get explicit seed facts. */
export function createSyncPullFixture(schemaPrefix: string, seedStream = true) {
  let isolated: IsolatedPostgresRuntime;
  let scope: Awaited<ReturnType<typeof createScope>>;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime(schemaPrefix, { maxConnections: 12 });
    await runMigrations(isolated.runtime.db, 'latest');
    await seedCollection(COLLECTION, ROOT);
    await seedCollection(OTHER_COLLECTION, 'p3-20-other-root');
    scope = await createScope();
    if (seedStream) {
      await insertOperation('fixture-op-a', 10, 1);
      await insertOperation('fixture-op-b', 11, 2);
      await insertOperation('fixture-op-c', 12, 3);
      await insertConflict('fixture-conflict-a', 'fixture-op-b', 11);
      await insertConflict('fixture-conflict-b', 'fixture-op-c', 11);
      await insertOperation('fixture-op-appended', 13, 4);
    }
  }, 120_000);

  afterAll(async () => isolated?.close());

  const seedCollection = (collectionId: string, rootId: string) =>
    seedPullCollection(isolated.runtime, SUBJECT, collectionId, rootId);

  async function createScope() {
    await isolated.runtime.pool.query("insert into accounts(id,subject_id,status) values ($1,$2,'active')", [ACCOUNT, SUBJECT]);
    await isolated.runtime.pool.query("insert into profile_handles(handle,account_id) values ('sync_pull',$1)", [ACCOUNT]);
    await isolated.runtime.pool.query(`insert into account_identities(id,account_id,issuer,subject)
      values ('p3-20-identity',$1,$2,'p3-20-oidc')`, [ACCOUNT, ISSUER]);
    const credential = await mintVerifiedExtensionCredentialFixture({
      issuer: ISSUER, audience: 'known-api', clientId: 'known-extension', subject: 'p3-20-oidc',
      credentialId: 'p3-20-credential',
    });
    const replica = await createPostgresReplicaStore(isolated.runtime.db, { ids: {
      deviceId: () => 'p3-20-device', replicaId: () => 'p3-20-replica', leaseId: () => 'p3-20-lease',
    } }).create({
      accountId: ACCOUNT, collectionId: COLLECTION, deviceName: 'P3-20 device', replicaName: 'P3-20 replica',
      kind: 'browser_extension', adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: { read: true, write: true, events: true, separator: true, alias: false,
        annotations: 'sidecar', maxBatchOperations: 1 },
      binding: { browserProfileId: 'p3-20-profile', mountMode: 'whole-profile', browserGeneration: 'generation-1' },
      leaseDurationSeconds: 3_600,
    }, { actorAccountId: ACCOUNT });
    const issuer = createPostgresSyncSessionIssuer(isolated.runtime.db, {
      issuer: ISSUER, audience: 'known-api', clientId: 'known-extension',
      replayEncryptionKey: Buffer.alloc(32, 23), replayEncryptionKeyVersion: 1,
      sessionDurationSeconds: 900, replicaLeaseExtensionSeconds: 3_600,
      tombstoneRetentionSeconds: 86_400, maxBatchOperations: 1,
      endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'],
    });
    const issued = await issuer.issue({
      credential, idempotencyKey: 'p3-20-session', requestFingerprint: 'p3-20-session-fingerprint',
      collectionId: COLLECTION, replicaId: replica.replicaId,
      expectedLeaseGeneration: replica.leaseGeneration, expectedLifecycleRevision: replica.lifecycleRevision,
      binding: replica.binding, requestedScopes: ['sync:pull'], origin: ORIGIN,
    });
    return { credential, replica, session: issued.session };
  }

  async function createProtocolScope(protocolVersion: '0.1' | '0.2') {
    const suffix = randomUUID();
    const credential = await mintVerifiedExtensionCredentialFixture({
      issuer: ISSUER, audience: 'known-api', clientId: 'known-extension', subject: 'p3-20-oidc',
      credentialId: `p3-20-credential-${suffix}`,
    });
    const replica = await createPostgresReplicaStore(isolated.runtime.db, { ids: {
      deviceId: () => `p3-20-device-${suffix}`, replicaId: () => `p3-20-replica-${suffix}`,
      leaseId: () => `p3-20-lease-${suffix}`,
    } }).create({
      accountId: ACCOUNT, collectionId: COLLECTION, deviceName: 'P3-20 protocol device',
      replicaName: 'P3-20 protocol replica', kind: 'browser_extension',
      adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: { read: true, write: true, events: true, separator: true, alias: false,
        annotations: 'sidecar', maxBatchOperations: 1 },
      binding: { browserProfileId: `p3-20-profile-${suffix}`, mountMode: 'whole-profile',
        browserGeneration: `generation-${suffix}` },
      leaseDurationSeconds: 3_600,
    }, { actorAccountId: ACCOUNT });
    const issuer = createPostgresSyncSessionIssuer(isolated.runtime.db, {
      issuer: ISSUER, audience: 'known-api', clientId: 'known-extension',
      replayEncryptionKey: Buffer.alloc(32, 23), replayEncryptionKeyVersion: 1,
      sessionDurationSeconds: 900, replicaLeaseExtensionSeconds: 3_600,
      tombstoneRetentionSeconds: 86_400, maxBatchOperations: 1,
      endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'],
    });
    const issued = await issuer.issue({
      credential, idempotencyKey: `p3-20-session-${suffix}`,
      requestFingerprint: `p3-20-session-fingerprint-${suffix}`,
      collectionId: COLLECTION, replicaId: replica.replicaId,
      expectedLeaseGeneration: replica.leaseGeneration,
      expectedLifecycleRevision: replica.lifecycleRevision,
      binding: replica.binding, requestedScopes: ['sync:pull'],
      origin: ORIGIN, protocolVersion,
    });
    return { credential, replica, session: issued.session, issuer };
  }

  function operation(id: string, sequence: number): Operation {
    return { opId: id, replicaId: scope.replica.replicaId, sequence, collectionId: COLLECTION,
      type: 'update_node_content', targetId: TARGET, baseRevision: 'target-r1',
      occurredAt: '2026-07-26T06:01:00Z', payload: { base: { title: 'Root' }, value: { title: `Root ${id}` } } };
  }

  async function insertOperation(id: string, ordinal: number, sequence = ordinal, collectionId = COLLECTION,
    title = `Root ${id}`): Promise<void> {
    const wire = { ...operation(id, sequence), collectionId,
      payload: { base: { title: 'Root' }, value: { title } } };
    await isolated.runtime.pool.query("insert into resource_id_ledger(resource_id,resource_type) values ($1,'operation')", [id]);
    await insertTestOperation(isolated.runtime.db, {
      operationId: id, collectionId, commitOrdinal: BigInt(ordinal),
      operationType: 'sync.node.update', payloadJson: { action: 'update' },
      syncWireJson: wire as unknown as Record<string, unknown>, actorPrincipalId: ACCOUNT,
    });
  }

  async function insertConflict(id: string, operationId: string, ordinal: number): Promise<void> {
    await isolated.runtime.pool.query("insert into resource_id_ledger(resource_id,resource_type) values ($1,'event')", [id]);
    await isolated.runtime.pool.query(`insert into sync_conflicts
      (conflict_id,collection_id,replica_id,session_id,operation_id,target_id,base_revision,
       trusted_base_revision,current_revision,conflict_type,conflicting_fields,base_projection,current_projection,
       incoming_projection,private_payload_ciphertext,private_payload_iv,private_payload_auth_tag,
       private_payload_key_version,private_payload_digest,allowed_resolutions,pull_wire_json,status,revision,commit_ordinal)
      values ($1,$2,$3,$4,$5,$6,'target-r1',null,'target-r1','concurrent_field_update','["/title"]',
       '{"fields":["/title"]}','{"fields":["/title"]}','{"fields":["/title"]}',
       decode('01','hex'),decode('000000000000000000000000','hex'),decode('00000000000000000000000000000000','hex'),
       1,$7,'["server","incoming","custom"]',$8,'open','conflict-r1',$9)`,
    [id, COLLECTION, scope.replica.replicaId, scope.session.sessionId, operationId, TARGET, 'A'.repeat(43), {
      id, collectionId: COLLECTION, targetId: TARGET, type: 'concurrent_field_update', field: '/title',
      incomingOpId: operationId, createdAt: '2026-07-26T06:02:00Z', status: 'open',
      allowedResolutions: ['server', 'incoming', 'custom'], revision: 'conflict-r1',
    }, ordinal]);
  }

  function reader(options: Parameters<typeof createPostgresSyncPullReadPort>[2] = {}) {
    const keys = createSyncPullCursorKeyring({
      active: { id: 'p3-20', secret: Buffer.alloc(32, 37).toString('base64') }, retained: [], ttlMs: 60_000,
    });
    return { keys, port: createPostgresSyncPullReadPort(isolated.runtime.db, keys, options) };
  }

  function countPersistenceStatements<T>(
    run: () => Promise<T>,
  ): Promise<{ readonly result: T; readonly count: number }> {
    const pool = isolated.runtime.pool;
    const original = pool.query.bind(pool);
    let count = 0;
    pool.query = ((...args: Parameters<typeof original>) => {
      const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text: string }).text;
      if (/sync_pull_cursor_evidence|sync_pull_cursor_recovery_proofs|sync_pull_page_evidence/iu.test(text)) count += 1;
      return original(...args);
    }) as typeof pool.query;
    return run().then((result) => {
      pool.query = original;
      return { result, count };
    }, (error: unknown) => {
      pool.query = original;
      throw error;
    });
  }

  async function seedOperationBatch(prefix: string, startOrdinal: number, count: number,
    replicaId = scope.replica.replicaId): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      const id = `batch-${prefix}-${String(index).padStart(5, '0')}`;
      const sequence = startOrdinal + index;
      const wire = { ...operation(id, sequence), collectionId: COLLECTION, replicaId };
      await isolated.runtime.pool.query("insert into resource_id_ledger(resource_id,resource_type) values ($1,'operation')", [id]);
      await insertTestOperation(isolated.runtime.db, {
        operationId: id, collectionId: COLLECTION, commitOrdinal: BigInt(sequence),
        operationType: 'sync.node.update', payloadJson: { action: 'update' },
        syncWireJson: wire as unknown as Record<string, unknown>, actorPrincipalId: ACCOUNT,
      });
    }
  }

  return {
    get isolated() { return isolated; }, set isolated(value: IsolatedPostgresRuntime) { isolated = value; },
    get scope() { return scope; },
    seedCollection, createScope, createProtocolScope, operation, insertOperation, insertConflict,
    reader, countPersistenceStatements, seedOperationBatch,
  };
}
