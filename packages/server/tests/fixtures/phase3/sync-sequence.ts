import { verifyFixtureSyncSessionRecord } from '../../support/sync-verified-session.js';
import {
  collectionSequenceScopeKey,
  type VerifiedSyncSession,
} from '@know-n/colp/sync';
import type { SyncSequenceAdmissionInput } from '../../../src/modules/sync/index.js';

export const SYNC_SEQUENCE_MEDIA_TYPE = 'application/vnd.collection-protocol.sync-push+json';
export const SYNC_SEQUENCE_ENDPOINT = 'manifest:endpoints.syncPush';

export async function verifiedSequenceSession(input: {
  readonly sessionId: string;
  readonly principalId?: string;
  readonly collectionId?: string;
}): Promise<VerifiedSyncSession> {
  return verifyFixtureSyncSessionRecord({
    sessionId: input.sessionId,
    principal: { type: 'user', id: input.principalId ?? 'sequence-subject' },
    credential: { kind: 'token', id: 'sequence-credential' },
    oauthClientId: 'known-extension',
    origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
    sessionScope: 'collection',
    protocolVersion: '0.1',
    collectionId: input.collectionId ?? 'sequence-collection',
    purpose: null,
    authorizationScopes: ['sync:push'],
    status: 'active',
  });
}

export function syncSequenceAdmission(
  session: VerifiedSyncSession,
  replicaId: string,
  overrides: Partial<SyncSequenceAdmissionInput> = {},
): SyncSequenceAdmissionInput {
  const collectionId = session.collectionId;
  if (!collectionId) throw new TypeError('Sequence fixture requires a Collection-bound Session');
  return {
    session,
    replicaId,
    leaseGeneration: '1',
    sequenceScope: collectionSequenceScopeKey(collectionId),
    sequence: 1,
    operationId: `${replicaId}.operation.1`,
    serverBatchId: `${session.sessionId}.batch.1`,
    mediaType: SYNC_SEQUENCE_MEDIA_TYPE,
    endpointIdentity: SYNC_SEQUENCE_ENDPOINT,
    payload: {
      sessionId: session.sessionId,
      atomic: true,
      operations: [{
        opId: `${replicaId}.operation.1`, replicaId, sequence: 1,
        type: 'create_node', payload: { title: 'stable result input' },
      }],
    },
    ...overrides,
  };
}

export function appliedSequenceResult(operationId: string, sequence = 1) {
  return {
    status: 'applied' as const,
    opId: operationId,
    sequence,
    cursor: 'cursor.commit.17.operation',
    resource: {
      id: 'node-sequence-result', revision: 'node-r17',
      extensions: { 'https://unknown.example/nested': { retain: ['all', { bytes: 17 }] } },
    },
    warnings: [] as const,
  };
}

export function deferredSequenceResult(operationId: string, sequence = 1) {
  return {
    status: 'deferred' as const,
    opId: operationId,
    sequence,
    code: 'dependency_pending',
    retryAfterSeconds: 5,
    warnings: [] as const,
  };
}
