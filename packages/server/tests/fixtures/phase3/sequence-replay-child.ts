import { verifyFixtureSyncSessionRecord } from '../../support/sync-verified-session.js';
import { createDatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { createPhase3SequenceEntryHarness } from '../../../scripts/evidence/phase3-sequence-entry-harness.js';
import {
  PHASE3_SEQUENCE_FIXTURE as FIXTURE,
  phase3SequenceCanonicalMutation,
} from './sequence-entry.js';

const databaseUrl = process.env.KNOWN_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('KNOWN_TEST_DATABASE_URL is required');

const runtime = createDatabaseRuntime(databaseUrl, {
  maxConnections: 1,
  applicationName: 'known-p3-sequence-replay-child',
  connectionTimeoutMs: 5_000,
  idleTimeoutMs: 1_000,
});

try {
  const session = await verifyFixtureSyncSessionRecord({
    sessionId: FIXTURE.sessionId,
    principal: { type: 'user' as const, id: FIXTURE.principalId },
    credential: { kind: 'token' as const, id: 'phase3-credential' },
    oauthClientId: 'phase3-extension',
    origin: null,
    sessionScope: 'collection' as const,
    protocolVersion: '0.1' as const,
    collectionId: FIXTURE.collectionId,
    purpose: null,
    authorizationScopes: ['sync:push'] as const,
    status: 'active' as const,
  });
  const harness = createPhase3SequenceEntryHarness(runtime.db);
  const replay = await harness.admit({
    session,
    leaseGeneration: FIXTURE.leaseGeneration,
    batchId: FIXTURE.batchId,
    replicaId: FIXTURE.replicaId,
    sequenceScope: FIXTURE.sequenceScope,
    sequence: 1,
    operationId: FIXTURE.operationId,
    mediaType: FIXTURE.mediaType,
    endpointIdentity: FIXTURE.endpointIdentity,
    payload: phase3SequenceCanonicalMutation(),
    requestId: 'retry-from-rebuilt-process',
    date: 'Sun, 26 Jul 2026 00:00:00 GMT',
  });
  process.stdout.write(JSON.stringify({
    kind: replay.result.kind,
    result: replay.operationResult,
    receipt: await harness.inspectReceipt(FIXTURE.replicaId, FIXTURE.sequenceScope, 1),
    evidence: await harness.inspect(FIXTURE.collectionId),
  }));
} finally {
  await runtime.close();
}
