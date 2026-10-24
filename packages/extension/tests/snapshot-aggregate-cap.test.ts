import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { loadCompleteRemoteSnapshot } from '../src/bootstrap/remote-snapshot.js';
import { classifySyncFailure, needsReplicaRebuild, persistentLocalSyncFailure } from '../src/sync-failure-class.js';
import type { SyncScope } from '../src/sync-state-store.js';
import type { StoredSession } from '../src/types.js';
import {
  ack, json, problem, recoverySnapshot, scope, setup, snapshot as snapshotFixture,
} from './durable-sync-engine-harness.js';

// B-02 (sync resilience audit): an operator-set aggregate Snapshot quota answers 413 on the
// FIRST page, because the server builds the whole Snapshot there. No page size changes that and
// a Reset needs the same Snapshot, so the extension must stop after one request with a code that
// names the cause instead of halving seven times and offering a Reset that cannot help.
describe('aggregate Snapshot size limit (B-02)', () => {
  test('is registered as a stop that a Reset cannot cure', () => {
    assert.equal(classifySyncFailure('snapshot_too_large')?.exit, 'stop');
    assert.equal(persistentLocalSyncFailure('snapshot_too_large'), true);
    assert.equal(needsReplicaRebuild('snapshot_too_large'), false);
    assert.equal(classifySyncFailure('snapshot_too_large')?.freezesPull, undefined);
  });

  test('recovery stops after one request and names the size limit', async () => {
    const fixture = await setup();
    fixture.pullResponses.push(problem(410, 'stale_replica', {}));
    await fixture.engine.wake('alarm');
    fixture.forcedSessions.push({ state: 'active', snapshotRequired: true, cursor: 'cursor-stale' });
    fixture.snapshotResponses.push(problem(413, 'payload_too_large', {}));
    await fixture.engine.wake('online');
    const exported = await fixture.store.exportScope(scope);
    const requests = fixture.snapshotRequests.map((request) => new URL(request.url));
    assert.deepEqual(requests.map((url) => url.searchParams.get('limit')), ['100'], 'no halving ladder');
    assert.equal(exported.engine.phase, 'error');
    assert.equal(exported.engine.lastError, 'snapshot_too_large');
    assert.notEqual(exported.engine.lastError, 'payload_too_large');
    assert.notEqual(exported.scope?.metadata?.recoveryCode, 'payload_too_large');
    await fixture.store.close();
  });

  test('a manual retry asks the server again and recovers once the limit is lifted', async () => {
    const fixture = await setup({ useStandInProjector: true });
    fixture.pullResponses.push(problem(410, 'stale_replica', {}));
    await fixture.engine.wake('alarm');
    fixture.forcedSessions.push({ state: 'active', snapshotRequired: true, cursor: 'cursor-stale' });
    fixture.snapshotResponses.push(problem(413, 'payload_too_large', {}));
    await fixture.engine.wake('online');
    assert.equal((await fixture.store.getEngineState(scope))?.lastError, 'snapshot_too_large');
    // The operator raised the limit; the user presses Retry. The stored Session still says a
    // Snapshot is required, so the wake asks for page one again without minting anything first.
    fixture.snapshotResponses.push(json(200, recoverySnapshot(1, true, 'page-2')), json(200, recoverySnapshot(2, false, null)));
    fixture.ackResponses.push(json(200, ack('bootstrap-cursor')));
    fixture.forcedSessions.push({ state: 'active', snapshotRequired: false, cursor: 'cursor-recovered' });
    fixture.clock.now += 120_000;
    await fixture.engine.wake('manual');
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.engine.phase, 'sleeping');
    assert.equal(exported.engine.lastError, undefined);
    assert.equal(exported.cursor.cursor, 'cursor-recovered');
    await fixture.store.close();
  });
});

describe('first-run Snapshot load and the aggregate limit (B-02)', () => {
  const runScope: SyncScope = Object.freeze({
    environment: 'production', serverId: 'server-a', serverOrigin: 'https://sync.example',
    accountId: 'account-a', browserProfileId: 'profile-a', collectionId: scope.collectionId,
    replicaId: 'replica-a', generation: 1,
  });
  const session = {
    sessionId: 'session-a', expiresAt: '2099-01-01T00:00:00Z', scope: 'collection' as const,
    acceptedProtocolVersion: '0.2' as const, snapshotRequired: false,
    collection: { collectionId: scope.collectionId, serverCursor: 'cursor-0', serverRevision: 'revision-0' },
    replicaLease: { leaseId: 'lease-a', generation: '1', state: 'active' as const, expiresAt: '2099-01-01T00:00:00Z' },
    conversionPolicy: { separator: 'preserve_remote' as const },
  } as StoredSession;
  const input = (fetcher: typeof fetch) => ({ endpoint: 'https://sync.example/v1/snapshot',
    origin: 'chrome-extension://extension', credential: { accessToken: 'access-token' }, session, scope: runScope, fetcher });

  test('a 413 on the first page is snapshot_too_large', async () => {
    let calls = 0;
    await assert.rejects(loadCompleteRemoteSnapshot(input(async () => { calls += 1; return problem(413, 'payload_too_large', {}); })),
      /^Error: snapshot_too_large$/u);
    assert.equal(calls, 1);
  });

  test('a 413 on a continuation page stays payload_too_large (one Node over the page budget)', async () => {
    let calls = 0;
    await assert.rejects(loadCompleteRemoteSnapshot(input(async () => {
      calls += 1;
      return calls === 1 ? json(200, snapshotFixture(1, true, 'page-2')) : problem(413, 'payload_too_large', {});
    })), /^Error: payload_too_large$/u);
    assert.equal(calls, 2);
  });
});
