import { randomUUID } from 'node:crypto';
import type { NodeCreate } from '@know-n/colp/types';
import { createAutomationDeviceUnitOfWork } from '../../src/infrastructure/automation/index.js';
import { createPostgresReplicaStore, createPostgresSyncSessionIssuer, createPostgresSyncPushApplication } from '../../src/infrastructure/sync/index.js';
import { mintExtensionCredentialHttpFixture } from './extension-credential.js';
import { automationRuntimeFixture } from './automation-runtime-fixture.js';
import { syncNodeMovePushRequest } from '../fixtures/phase3/sync-node-move.js';
import { syncNodeCreatePushRequest } from '../fixtures/phase3/sync-push-admission.js';
export const AUTOMATION_DEVICE_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
export async function automationDeviceFixture(prefix: string) {
  const f = await automationRuntimeFixture(prefix);
  const http = await mintExtensionCredentialHttpFixture({ issuer: 'https://automation.example.test', audience: 'known-api',
    clientId: 'known-extension', subject: 'owner', credentialId: randomUUID(), evidenceTtlSeconds: 300 });
  const replica = await createPostgresReplicaStore(f.db).create({ accountId: f.owner.accountId, collectionId: 'collection',
    deviceName: 'Automation fixture', replicaName: 'Fixture replica', kind: 'browser_extension',
    adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
    capabilities: { read: true, write: true, events: true, separator: false, alias: false, annotations: 'sidecar', maxBatchOperations: 1 },
    binding: { browserProfileId: 'automation-fixture', mountMode: 'whole-profile', browserGeneration: 'fixture-install' },
    leaseDurationSeconds: 3600 }, { actorAccountId: f.owner.accountId });
  const issuer = createPostgresSyncSessionIssuer(f.db, { issuer: 'https://automation.example.test', audience: 'known-api', clientId: 'known-extension',
    replayEncryptionKey: Buffer.alloc(32, 73), replayEncryptionKeyVersion: 1, sessionDurationSeconds: 900,
    replicaLeaseExtensionSeconds: 3600, tombstoneRetentionSeconds: 86400, maxBatchOperations: 1,
    endpointCapabilities: ['syncSnapshot','syncPush','syncPull','syncAck','syncConflict'] });
  const issued = await issuer.issue({ credential: http.credential, idempotencyKey: randomUUID(), requestFingerprint: randomUUID(),
    collectionId: 'collection', replicaId: replica.replicaId, expectedLeaseGeneration: replica.leaseGeneration,
    expectedLifecycleRevision: replica.lifecycleRevision, binding: replica.binding, requestedScopes: ['sync:push','sync:pull'],
    protocolVersion: '0.1', origin: AUTOMATION_DEVICE_ORIGIN });
  const sessionId = issued.session.sessionId;
  await createAutomationDeviceUnitOfWork(f.db, 'server').execute({ credential: http.credential, sessionId, origin: AUTOMATION_DEVICE_ORIGIN }, p => p.bundle('browser-bounded-v1'));
  let sequence = 0;
  async function syncCreateNode(nodeId: string, operationId: string, parentId: string, node: NodeCreate) {
    const application = createPostgresSyncPushApplication(f.db, issuer, { nodeId: () => nodeId });
    const request = syncNodeCreatePushRequest({ sessionId, replicaId: replica.replicaId, collectionId: 'collection', sequence: ++sequence,
      opId: operationId, parentId, node });
    const result = await application.admit({ credential: http.credential, origin: AUTOMATION_DEVICE_ORIGIN,
      idempotencyKey: randomUUID(), requestFingerprint: randomUUID(), mediaType: 'application/json', endpointIdentity: '/colp/v0.1/sync/push', request });
    if (!['applied','rebased'].includes(result.results[0]!.status)) throw new Error(JSON.stringify(result));
    return result;
  }
  async function syncCreate(nodeId: string, operationId: string, parentId = 'academic') {
    return syncCreateNode(nodeId, operationId, parentId, { kind: 'bookmark', title: 'Sync paper', url: 'https://arxiv.org/sync',
      tags: [], visibility: 'inherit', extensions: {} });
  }
  async function syncMove(nodeId: string, operationId: string, parentId = 'academic') {
    const node = await f.db.selectFrom('nodes').selectAll().where('id', '=', nodeId).executeTakeFirstOrThrow();
    const source = await f.db.selectFrom('nodes').select('children_revision').where('id', '=', node.parent_id!).executeTakeFirstOrThrow();
    const target = await f.db.selectFrom('nodes').select('children_revision').where('id', '=', parentId).executeTakeFirstOrThrow();
    return createPostgresSyncPushApplication(f.db, issuer).admit({ credential: http.credential, origin: AUTOMATION_DEVICE_ORIGIN,
      idempotencyKey: randomUUID(), requestFingerprint: randomUUID(), mediaType: 'application/json', endpointIdentity: '/colp/v0.1/sync/push',
      request: syncNodeMovePushRequest({ sessionId, replicaId: replica.replicaId, collectionId: 'collection', sequence: ++sequence,
        opId: operationId, targetId: nodeId, baseRevision: node.resource_revision, newParentId: parentId,
        baseSourceParentRevision: source.children_revision, baseTargetParentRevision: target.children_revision }) });
  }
  return { ...f, http, replica, sessionId, issuer, syncCreate, syncCreateNode, syncMove };
}
