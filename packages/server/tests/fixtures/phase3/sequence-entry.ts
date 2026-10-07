import type { CanonicalMutationInput } from '../../../src/modules/collections/index.js';
import type { Phase3SequenceEntryFaultPoint } from '../../../scripts/evidence/phase3-sequence-entry-harness.js';

export const PHASE3_SEQUENCE_FAULT_POINTS = Object.freeze([
  'receipt_claim',
  'canonical_mutation',
  'operation',
  'audit',
  'outbox',
  'receipt_finalize',
] satisfies readonly Phase3SequenceEntryFaultPoint[]);

export const PHASE3_SEQUENCE_FIXTURE = Object.freeze({
  collectionId: 'c3Nzc3Nzc3Nzc3Nzc3Nzcw',
  rootId: 'phase3-sequence-root',
  nodeId: 'phase3-sequence-node',
  principalId: 'EREREREREREREREREREREQ',
  sessionId: 'phase3-sequence-session',
  replicaId: 'phase3-sequence-replica',
  sequenceScope: 'collection:c3Nzc3Nzc3Nzc3Nzc3Nzcw',
  leaseGeneration: 7,
  batchId: 'phase3-sequence-session.batch-1',
  operationId: 'phase3-sequence-operation-1',
  mediaType: 'application/vnd.collection-protocol.sync-push+json',
  endpointIdentity: 'manifest:endpoints.syncPush',
  requestId: 'request-random-a',
  date: 'Sat, 25 Jul 2026 03:00:00 GMT',
} as const);

export function phase3SequenceCanonicalMutation(
  operationId = PHASE3_SEQUENCE_FIXTURE.operationId,
): CanonicalMutationInput {
  return {
    operationId,
    collectionId: PHASE3_SEQUENCE_FIXTURE.collectionId,
    actor: { principalId: PHASE3_SEQUENCE_FIXTURE.principalId, principalType: 'account' },
    mutation: {
      action: 'update',
      target: {
        collectionId: PHASE3_SEQUENCE_FIXTURE.collectionId,
        resourceId: PHASE3_SEQUENCE_FIXTURE.nodeId,
        resourceKind: 'node',
      },
      parentId: PHASE3_SEQUENCE_FIXTURE.rootId,
      expectedResourceRevision: 'node-r1',
      fields: {
        kindFields: {
          kind: 'bookmark',
          title: 'After exact retry',
          url: 'https://example.test/after',
          description: 'P3-02 Sequence owner evidence',
          tags: ['phase3', 'sequence'],
          visibility: 'inherit',
        },
        extensions: { 'example.test/phase3': { retained: true } },
      },
    },
  };
}
