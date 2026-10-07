import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createPostgresReplicaStore,
  createPostgresSyncRecoveryApplication,
  createPostgresSyncSessionIssuer,
  createSyncRecoveryCapabilityKeyring,
  type PostgresSyncRecoveryOptions,
  type SyncRecoveryFaultPhase,
} from '../../src/infrastructure/sync/index.js';
import { materializeCollectionPayload, materializeNodePayload,
  RESOURCE_PAYLOAD_SCHEMA_VERSION } from '../../src/modules/collections/index.js';
import type { VerifiedExtensionCredential } from '../../src/modules/identity/index.js';
import type { SyncRecoveryCapabilityClaims } from '../../src/modules/sync/index.js';
import { snapshotMaterializationIdentity } from '../../src/modules/sync/sync-snapshot-parent-first.js';
import { mintExtensionCredentialHttpFixture } from './extension-credential.js';
import type { IsolatedPostgresRuntime } from './postgres-test-runtime.js';

// The fixture uses production migrations and public application ports; it never updates a Replica active.
export interface RecoveryFixture {
  readonly application: ReturnType<typeof createPostgresSyncRecoveryApplication>;
  readonly options: PostgresSyncRecoveryOptions;
  readonly optionsWithoutFault: PostgresSyncRecoveryOptions;
  readonly credential: VerifiedExtensionCredential; readonly authorization: string;
  readonly credentialVerifier: Awaited<ReturnType<typeof mintExtensionCredentialHttpFixture>>['verifier'];
  readonly accountId: string;
  readonly sessionId: string; readonly snapshotId: string; readonly replicaId: string;
  readonly collectionId: string;
  readonly oldGeneration: string; readonly oldLeaseId: string;
  readonly cursorBeforeBoundary: string; readonly cursorAtBoundary: string;
  readonly cursorBeyondBoundary: string; readonly snapshotCursor: string;
  readonly recordPage: (sequence: number, startOffset: number, endOffset: number,
    complete: boolean) => Promise<unknown>;
  readonly recordAllPages: () => Promise<void>;
  readonly capabilityFor: (overrides: Partial<SyncRecoveryCapabilityClaims>) => string;
  readonly retire: () => Promise<unknown>;
}

export async function seedRecoveryFixture(isolated: IsolatedPostgresRuntime, suffix: string,
  fault?: SyncRecoveryFaultPhase, seedSnapshot = true, bootstrapCursorOverride?: string,
  protocolVersion: '0.1' | '0.2' = '0.1',
  /** FIX-M-014: total live DB nodes to seed (root + bookmarks) for size-cap and paging fixtures. */
  dbNodeCount = 1): Promise<RecoveryFixture> {
  const id = suffix.replace(/[^a-z0-9-]/giu, '-').slice(0, 40);
  const accountId = `recovery-account-${id}`; const subject = `recovery-subject-${id}`;
  const collectionId = `recovery-collection-${id}`; const rootId = `recovery-root-${id}`;
  const now = new Date('2026-07-26T12:00:00.000Z');
  const collectionPayload = materializeCollectionPayload({ id: collectionId, ownerSubjectId: subject,
    title: 'Recovery', summary: null, kind: 'bookmarks', visibility: 'private', rootNodeId: rootId,
    resourceRevision: 'collection-r1', contentRevision: 'content-r43', policyRevision: 'policy-r1',
    commitOrdinal: 43n, createdAt: now, updatedAt: now, deletedAt: null });
  const rootPayload = materializeNodePayload({ id: rootId, collectionId, parentId: null, kind: 'folder',
    isRoot: true, title: 'Root', url: null, description: null, tags: [], visibility: 'inherit',
    positionToken: null, resourceRevision: 'root-r1', childrenRevision: 'children-r1', createdAt: now,
    updatedAt: now, deletedAt: null, deletedCommitOrdinal: null });
  assert.equal(collectionPayload.ok && rootPayload.ok, true);
  await isolated.runtime.db.transaction().execute(async (transaction) => {
    await transaction.insertInto('accounts').values({ id: accountId, subject_id: subject,
      status: 'active', security_epoch: 0n, created_at: now }).execute();
    await transaction.insertInto('account_identities').values({ id: `recovery-identity-${id}`,
      account_id: accountId, issuer: 'https://issuer.example', subject: `recovery-oidc-${id}`, created_at: now }).execute();
    await transaction.insertInto('profile_handles').values({ handle: `recovery-${id}`,
      account_id: accountId, created_at: now }).execute();
    await transaction.insertInto('resource_id_ledger').values([{ resource_id: collectionId,
      resource_type: 'collection' }, { resource_id: rootId, resource_type: 'node' }]).execute();
    await transaction.insertInto('collections').values({ id: collectionId, owner_subject_id: subject,
      title: 'Recovery', kind: 'bookmarks', root_node_id: rootId, root_node_is_root: true, resource_revision: 'collection-r1',
      content_revision: 'content-r43', policy_revision: 'policy-r1', visibility: 'private', commit_ordinal: 43n,
      created_at: now, updated_at: now, deleted_at: null,
      payload_json: collectionPayload.ok ? collectionPayload.payload : {},
      payload_schema_version: RESOURCE_PAYLOAD_SCHEMA_VERSION, payload_authority_status: 'backfilled' }).execute();
    await transaction.insertInto('nodes').values({ id: rootId, collection_id: collectionId,
      parent_id: null, kind: 'folder', is_root: true, title: 'Root', url: null, position_token: null,
      resource_revision: 'root-r1', children_revision: 'children-r1', deleted_at: null,
      visibility: 'inherit', created_at: now, updated_at: now,
      payload_json: rootPayload.ok ? rootPayload.payload : {},
      payload_schema_version: RESOURCE_PAYLOAD_SCHEMA_VERSION, payload_authority_status: 'backfilled' }).execute();
    if (dbNodeCount > 1) {
      for (let index = 0; index < dbNodeCount - 1; index += 1) {
        const nodeId = `recovery-paged-node-${id}-${index}`;
        const bookmarkPayload = materializeNodePayload({ id: nodeId, collectionId, parentId: rootId,
          kind: 'bookmark', isRoot: false, title: `Paged ${index}`, url: `https://example.test/paged/${index}`,
          description: null, tags: [], visibility: 'inherit',
          positionToken: `P${index.toString().padStart(5, '0')}`,
          resourceRevision: `paged-r${index}`, childrenRevision: `paged-children-r${index}`,
          createdAt: now, updatedAt: now, deletedAt: null, deletedCommitOrdinal: null });
        if (!bookmarkPayload.ok) throw new Error('paged bookmark payload failed');
        await transaction.insertInto('resource_id_ledger').values({ resource_id: nodeId,
          resource_type: 'node' }).execute();
        await transaction.insertInto('nodes').values({ id: nodeId, collection_id: collectionId,
          parent_id: rootId, kind: 'bookmark', is_root: false, title: `Paged ${index}`,
          url: `https://example.test/paged/${index}`, position_token: `P${index.toString().padStart(5, '0')}`,
          resource_revision: `paged-r${index}`, children_revision: `paged-children-r${index}`,
          deleted_at: null, visibility: 'inherit', created_at: now, updated_at: now,
          payload_json: bookmarkPayload.payload, payload_schema_version: RESOURCE_PAYLOAD_SCHEMA_VERSION,
          payload_authority_status: 'backfilled' }).execute();
      }
    }
  });
  const httpCredential = await mintExtensionCredentialHttpFixture({ issuer: 'https://issuer.example',
    audience: 'known-api', clientId: 'known-extension', subject: `recovery-oidc-${id}`,
    credentialId: `recovery-credential-${id}` });
  const credential = httpCredential.credential;
  const replica = await createPostgresReplicaStore(isolated.runtime.db, { ids: {
    deviceId: () => `recovery-device-${id}`, replicaId: () => `recovery-replica-${id}`,
    leaseId: () => `recovery-lease-${id}`,
  } }).create({ accountId, collectionId, deviceName: 'Recovery device', replicaName: 'Recovery replica',
    kind: 'browser_extension', adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
    capabilities: { read: true, write: true, events: true, separator: false, alias: false,
      annotations: 'sidecar', maxBatchOperations: 1 }, binding: { browserProfileId: `profile-${id}`,
      mountMode: 'whole-profile', browserGeneration: `install-${id}` }, leaseDurationSeconds: 3_600 },
    { actorAccountId: accountId });
  const issuer = createPostgresSyncSessionIssuer(isolated.runtime.db, { issuer: 'https://issuer.example',
    audience: 'known-api', clientId: 'known-extension', replayEncryptionKey: Buffer.alloc(32, 91),
    replayEncryptionKeyVersion: 1, sessionDurationSeconds: 900, replicaLeaseExtensionSeconds: 3_600,
    tombstoneRetentionSeconds: 86_400, maxBatchOperations: 1,
    endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'] });
  const issued = await issuer.issue({ credential, idempotencyKey: `session-${id}`,
    requestFingerprint: `session-fingerprint-${id}`, collectionId, replicaId: replica.replicaId,
    expectedLeaseGeneration: replica.leaseGeneration, expectedLifecycleRevision: replica.lifecycleRevision,
    binding: replica.binding, requestedScopes: ['sync:bootstrap', 'sync:pull', 'sync:push'],
    protocolVersion, origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' });
  assert.equal(issued.state, 'issued'); if (issued.state !== 'issued') throw new Error('session denied');
  const sessionId = issued.envelope.sessionId;
  const snapshotId = `snap_${snapshotMaterializationIdentity({
    protocolVersion, sessionId, replicaId: replica.replicaId, leaseGeneration: replica.leaseGeneration,
    contentRevision: 'content-r43', policyRevision: 'policy-r1', rootNodeId: rootId,
  })}`;
  const snapshotCursor = bootstrapCursorOverride ?? `boot_snapshot-cursor-${id}`;
  const snapshotNodes = [{ id: rootId, collectionId, kind: 'root', parentId: null, position: null,
    folderRole: 'root', title: 'Recovery', createdAt: now.toISOString(), updatedAt: now.toISOString(),
    revision: 'root-r1', extensions: {} }, ...Array.from({ length: 400 }, (_, index) => ({
    id: `recovery-bookmark-${id}-${index}`, collectionId, kind: 'bookmark', parentId: rootId,
    position: `P${index.toString().padStart(4, '0')}`, title: `Bookmark ${index}`,
    url: `https://example.test/${index}`, createdAt: now.toISOString(), updatedAt: now.toISOString(),
    revision: `bookmark-r${index}`, extensions: {},
  }))];
  const snapshotDocument = { collection: { schemaVersion: '0.1', id: collectionId, kind: 'bookmarks',
    title: 'Recovery', rootNodeId: rootId, visibility: 'private', createdAt: now.toISOString(),
    updatedAt: now.toISOString(), revision: 'content-r43', extensions: {} }, nodes: snapshotNodes,
    ...(protocolVersion === '0.2' ? { parentRevisions: [{ parentId: rootId,
      childrenRevision: 'children-r1' }] } : {}) };
  if (seedSnapshot) await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id,resource_type)
    values ($1,'sync_bootstrap_snapshot')`, [snapshotId]);
  await isolated.runtime.pool.query(`update sync_collection_purge_state set
    purged_through_commit_ordinal=42,purged_through_stream_kind=1,purged_through_stable_id='conflict-42',
    state_revision=state_revision+1 where collection_id=$1`, [collectionId]);
  if (seedSnapshot) await isolated.runtime.pool.query(`insert into sync_bootstrap_snapshots(snapshot_id,session_id,account_id,collection_id,replica_id,
      lease_generation,policy_revision,content_revision,binding_mode,binding_root_node_id,snapshot_json,
      bootstrap_cursor,cursor_key_id,generated_at,expires_at)
      values ($1,$2,$3,$4,$5,$6,'policy-r1','content-r43','whole-profile',$7,$8,$9,'snapshot-v1',
        current_timestamp,current_timestamp + interval '10 minutes')`, [snapshotId, sessionId, accountId,
      collectionId, replica.replicaId, BigInt(replica.leaseGeneration), rootId, snapshotDocument, snapshotCursor]);
  for (const [cursor, ordinal, kind, stable] of [[`before-${id}`, 41, 1, 'conflict-41'],
    [`boundary-${id}`, 42, 1, 'conflict-42'], [`beyond-${id}`, 43, 0, 'operation-43']] as const) {
    await isolated.runtime.pool.query(`insert into sync_pull_cursor_evidence(cursor,cursor_digest,session_id,
      account_id,collection_id,replica_id,lease_generation,policy_revision,protocol_version,
      tuple_commit_ordinal,tuple_stream_kind,tuple_stable_id,cursor_expires_at,upper_commit_ordinal,
      upper_stream_kind,upper_stable_id,collection_revision,page_limit,purge_commit_ordinal,
      purge_stream_kind,purge_stable_id) values ($1,$2,$3,$4,$5,$6,$7,
      'policy-r1',$11,$8,$9,$10,current_timestamp + interval '10 minutes',$8,$9,$10,'content-r43',100,0,0,'')`,
    [cursor, createHash('sha256').update(cursor).digest('hex'), sessionId, accountId, collectionId,
      replica.replicaId, BigInt(replica.leaseGeneration), ordinal, kind, stable, protocolVersion]);
  }
  let faultRaised = false;
  const optionsWithoutFault = { capabilityKeys: createSyncRecoveryCapabilityKeyring({ active: {
    id: 'recovery-key-v1', secret: Buffer.alloc(32, 92).toString('base64'), }, retained: [], ttlMs: 300_000 }),
    leaseExtensionSeconds: 600, maxLeaseLifetimeSeconds: 3_600, leaseId: () => `new-lease-${id}` };
  const options = { ...optionsWithoutFault, ...(fault ? { faultInjector: { afterPhase(phase: SyncRecoveryFaultPhase) {
    if (phase === fault && !faultRaised) { faultRaised = true; throw new Error(`fault:${phase}`); }
  } } } : {}) };
  const application = createPostgresSyncRecoveryApplication(isolated.runtime.db, options);
  const recordPage = (sequence: number, startOffset: number, endOffset: number, complete: boolean) =>
    application.recordSnapshotPage({ credential, sessionId, snapshotId, sequence, startOffset, endOffset,
      complete, responseDigest: `page-${sequence}-${id}` });
  return { application, options, optionsWithoutFault, credential, authorization: httpCredential.authorization,
    credentialVerifier: httpCredential.verifier, accountId, sessionId, snapshotId, collectionId,
    replicaId: replica.replicaId, oldGeneration: replica.leaseGeneration, oldLeaseId: replica.leaseId,
    cursorBeforeBoundary: `before-${id}`, cursorAtBoundary: `boundary-${id}`,
    cursorBeyondBoundary: `beyond-${id}`, snapshotCursor,
    recordPage, recordAllPages: async () => { await recordPage(1, 0, 200, false);
      await recordPage(2, 200, 400, false); await recordPage(3, 400, 401, true);
      await isolated.runtime.pool.query(`update sync_bootstrap_snapshots
        set completed_at=GREATEST(generated_at, current_timestamp)
        where snapshot_id=$1 and completed_at is null
          and GREATEST(generated_at, current_timestamp)<expires_at`, [snapshotId]); },
    capabilityFor(overrides: Partial<SyncRecoveryCapabilityClaims>) { return optionsWithoutFault.capabilityKeys.sign({
      purpose: 'sync-recovery-bootstrap-ack', version: 1, sessionId, accountId,
      replicaId: replica.replicaId, collectionId, oldLeaseGeneration: replica.leaseGeneration,
      purgeBoundary: { commitOrdinal: '42', streamKind: 'conflict', stableId: 'conflict-42' },
      snapshotId, snapshotRevision: 'content-r43', snapshotPageCount: 3, snapshotNodeCount: 401,
      snapshotCursor, ...overrides }); },
    retire: () => application.retire({ credential, sessionId }),
  };
}
