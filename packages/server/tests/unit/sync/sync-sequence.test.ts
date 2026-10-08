import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { verifyFixtureSyncSessionRecord } from '../../support/sync-verified-session.js';
import {
  SYNC_SEQUENCE_RECEIPT_RETENTION,
  canonicalSyncSequenceAttemptDigest,
  canonicalSyncSequenceDigest,
  presentSequenceReceiptDigest,
  validateSyncSequenceAdmissionInput,
  type SyncSequenceAdmissionInput,
} from '../../../src/modules/sync/index.js';
import { syncSequenceAdmission, verifiedSequenceSession } from '../../fixtures/phase3/sync-sequence.js';

function expectTypeError(run: () => unknown, message: string | RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof TypeError, `expected TypeError, got ${String(error)}`);
    const text = error.message;
    return typeof message === 'string' ? text.includes(message) : message.test(text);
  });
}

const verifiedSession = await verifiedSequenceSession({ sessionId: 'sequence-session' });

describe('P3-10 Sequence binding and retention contract', () => {
  const session = verifiedSession;
  const legal = syncSequenceAdmission(session, 'sequence-replica');

  test('canonical digest binds every durable replay identity and excludes transport entropy', async () => {
    const base = legal;
    const digest = canonicalSyncSequenceDigest(base);
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.equal(canonicalSyncSequenceDigest({ ...base, requestId: 'random-request', date: new Date().toUTCString(), traceId: 'random-trace' }), digest);
    for (const change of [
      { session: await verifiedSequenceSession({ sessionId: 'other-session' }) },
      { leaseGeneration: '2' }, { serverBatchId: `${session.sessionId}.other` },
      { endpointIdentity: 'manifest:endpoints.other' }, { mediaType: 'application/json' },
    ]) assert.equal(canonicalSyncSequenceDigest({ ...base, ...change }), digest);
    for (const change of [
      { replicaId: 'other-replica' }, { sequenceScope: 'collection:other' },
      { sequence: 2 }, { operationId: 'other-operation' },
      { payload: { changed: true } },
    ]) assert.notEqual(canonicalSyncSequenceDigest({ ...base, ...change }), digest);
    const otherSession = { session: await verifiedSequenceSession({ sessionId: 'other-session' }) };
    assert.notEqual(canonicalSyncSequenceAttemptDigest({ ...base, ...otherSession }),
      canonicalSyncSequenceAttemptDigest(base));
    const v1Stored = {
      storedDigest: canonicalSyncSequenceAttemptDigest(base),
      storedAlgorithm: 'known.sync-sequence.v1',
      storedAttempt: {
        sessionId: base.session.sessionId, leaseGeneration: base.leaseGeneration,
        serverBatchId: base.serverBatchId, mediaType: base.mediaType,
        endpointIdentity: base.endpointIdentity,
      },
    };
    assert.equal(presentSequenceReceiptDigest({
      ...v1Stored, request: { ...base, ...otherSession, serverBatchId: 'other-session.batch.1' },
    }), digest);
    assert.equal(presentSequenceReceiptDigest({ ...v1Stored, request: base }), digest);
    assert.equal(presentSequenceReceiptDigest({
      ...v1Stored, request: { ...base, payload: { changed: true } },
    }), v1Stored.storedDigest);
  });

  test('validates Sequence one, canonical Collection scope, Session batch binding, and safe counters', () => {
    assert.deepEqual(validateSyncSequenceAdmissionInput(legal), legal);
    for (const invalid of [
      { ...legal, sequence: 0 }, { ...legal, sequence: Number.MAX_SAFE_INTEGER + 1 },
      { ...legal, leaseGeneration: '0' }, { ...legal, leaseGeneration: '01' },
      { ...legal, sequenceScope: 'collection:other' },
      { ...legal, sequenceScope: session.collectionId ?? '' },
      { ...legal, serverBatchId: 'client-selected-unbound-batch' },
    ]) assert.throws(() => validateSyncSequenceAdmissionInput(invalid));
  });

  test('declares lifecycle-wide permanent replay retention without a purge API', () => {
    assert.deepEqual(SYNC_SEQUENCE_RECEIPT_RETENTION, {
      policy: 'replica_lifetime', retainOperationClaimForever: true,
      retainReceiptThroughRetirement: true, purgeSupported: false,
    });
  });
});

describe('R05 Sync Sequence admission negative guards', () => {
  const session = verifiedSession;
  const legal = syncSequenceAdmission(session, 'sequence-replica');

  test('rejects unknown fields while keeping every other Session input legal', () => {
    expectTypeError(
      () => validateSyncSequenceAdmissionInput({ ...legal, unexpectedField: true }),
      'unknown field',
    );
    assert.deepEqual(validateSyncSequenceAdmissionInput(legal), legal);
  });

  test('rejects missing required keys and scope mismatches with legal Session evidence', async () => {
    for (const key of [
      'session', 'replicaId', 'leaseGeneration', 'sequenceScope', 'sequence', 'operationId',
      'serverBatchId', 'mediaType', 'endpointIdentity', 'payload',
    ] as const) {
      const incomplete = { ...legal };
      delete (incomplete as Record<string, unknown>)[key];
      expectTypeError(() => validateSyncSequenceAdmissionInput(incomplete), 'incomplete');
    }

    const missingPush = await verifyFixtureSyncSessionRecord({
        ...session,
        authorizationScopes: ['sync:pull'],
    });
    expectTypeError(
      () => validateSyncSequenceAdmissionInput({ ...legal, session: missingPush }),
      'Collection-bound Sync Push Session is required',
    );

    const wrongScope = await verifyFixtureSyncSessionRecord({
        ...session,
        sessionScope: 'instance',
        collectionId: null,
        purpose: 'create_collection',
        authorizationScopes: ['sync:bootstrap', 'sync:push', 'collections:create'],
    });
    expectTypeError(
      () => validateSyncSequenceAdmissionInput({ ...legal, session: wrongScope }),
      'Collection-bound Sync Push Session is required',
    );
  });

  test('rejects non-boolean reevaluateDeferred and overlong durable string fields', () => {
    expectTypeError(
      () => validateSyncSequenceAdmissionInput({ ...legal, reevaluateDeferred: 'yes' }),
      'boolean',
    );
    assert.deepEqual(
      validateSyncSequenceAdmissionInput({ ...legal, reevaluateDeferred: true }).reevaluateDeferred,
      true,
    );

    for (const [field, length, label] of [
      ['replicaId', 129, 'Replica ID'],
      ['sequenceScope', 641, 'Sequence scope'],
      ['operationId', 513, 'Operation ID'],
      ['serverBatchId', 513, 'Server batch ID'],
      ['mediaType', 256, 'Media type'],
      ['endpointIdentity', 513, 'Endpoint identity'],
    ] as const) {
      expectTypeError(
        () => validateSyncSequenceAdmissionInput({ ...legal, [field]: 'x'.repeat(length) }),
        label,
      );
    }
  });

  test('rejects abnormal prototype and accessor-bearing admission objects', () => {
    const customPrototype = { ...legal, marker: 'visible' };
    Object.setPrototypeOf(customPrototype, { inherited: true });
    expectTypeError(() => validateSyncSequenceAdmissionInput(customPrototype), 'plain object');

    const accessor = { ...legal } as SyncSequenceAdmissionInput & { readonly poison?: string };
    Object.defineProperty(accessor, 'poison', {
      enumerable: true,
      get() {
        return 'leak';
      },
    });
    expectTypeError(
      () => validateSyncSequenceAdmissionInput(accessor),
      'enumerable data properties only',
    );
  });
});
