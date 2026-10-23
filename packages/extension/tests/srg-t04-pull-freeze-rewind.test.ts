/**
 * T-04: F005 (pull block freeze + blocked-page exit) and F008 (durable cursor
 * rewind guard). Drives the production Pull applier/store entry points and the
 * real durable engine, never raw state fields alone.
 */
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { createPullApplier } from '../src/pull-applier.js';
import { digest } from '../src/pull-codec.js';
import { createDurableSyncEngine } from '../src/durable-sync-engine.js';
import { needsReplicaRebuild } from '../src/sync-failure-class.js';
import { createSyncStateStore } from '../src/sync-state-store.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import {
  completeWithMappings, installKns05IndexedDb, mappingInput, scope, setup,
} from './kns-05-pull-harness.js';
import {
  ack, json, pullPage, scope as engineScope, setup as engineSetup, snapshot,
} from './durable-sync-engine-harness.js';

installKns05IndexedDb();

const effectPageTemplate = 'https://known.example/effects/{effectId}/pages/{pageNumber}';
const spc2 = (ordinal: number) => `spc2.knowntag001.1z.${ordinal.toString(36)}.o.${'A'.repeat(43)}.${'B'.repeat(22)}`;

async function engineRecoveryFlags(store: ReturnType<typeof createSyncStateStore>) {
  await store.transitionEngine(scope, { phase: 'recovery', updatedAt: 1, recoveryFrozen: true,
    authorityRefreshRequired: true, notBefore: 0, lastError: 'stale_replica' });
}

describe('T-04 pull block freeze and blocked-page exit', () => {
  test('freezes the scope and engine when a re-delivered page collides with a blocked page', async () => {
    const fixture = await setup();
    const event = fixture.createEvent('Bookmark', 1);
    const page = fixture.page([event], 'cursor-next');
    const staged = page.events[0]!;
    const pageId = digest({ previousCursor: 'cursor-old', nextCursor: 'cursor-next',
      events: [`${staged.cursor}:${staged.operation.opId}`] });
    await fixture.store.putMapping(scope, mappingInput('native-a', 'colp-fight'));
    await assert.rejects(() => completeWithMappings(fixture.store, pageId, 'cursor-old', 'cursor-next',
      [mappingInput('native-b', 'colp-fight')]), /recovery_required/);
    assert.equal((await fixture.store.exportScope(scope)).pullPages[0]?.state, 'blocked');
    // The next pull replays the same page id with different backend evidence.
    await assert.rejects(() => fixture.applier.stage(page), /pull_page_reuse/);
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.scope?.lifecycle, 'recovery_required');
    assert.equal(exported.engine.recoveryFrozen, true);
    assert.equal(exported.engine.authorityRefreshRequired, true);
    assert.equal(exported.engine.lastError, 'pull_page_reuse');
    fixture.store.close();
  });

  test('replays a blocked page under an attaching chain and completes it once the conflict clears', async () => {
    const fixture = await setup();
    await fixture.store.putMapping(scope, mappingInput('native-other', 'node-created-1'));
    const page = fixture.page([fixture.createEvent('Bookmark', 1)], 'cursor-next');
    await fixture.applier.stage(page);
    await assert.rejects(() => fixture.applier.resume(), /recovery_required/);
    let exported = await fixture.store.exportScope(scope);
    const pageId = String(exported.pullPages[0]?.pageId);
    assert.equal(exported.pullPages[0]?.state, 'blocked');
    assert.equal(exported.pullPages[0]?.recoveryCode, 'mapping_identity_conflict');
    assert.equal(exported.scope?.lifecycle, 'recovery_required');
    assert.equal(exported.engine.recoveryFrozen, true);
    assert.equal(exported.engine.lastError, 'mapping_identity_conflict');
    assert.ok(exported.pullEvents.every((row) => row.state === 'authority_committed'));
    // The blocked record (including its local block timestamp) stays a valid durable row.
    assert.equal(typeof exported.pullPages[0]?.blockedAt, 'number');
    assert.equal((await fixture.store.auditIntegrity()).outcome, 'valid');

    // The same page is re-delivered: it is handed back to staging, not reused or dropped.
    await fixture.applier.stage(page);
    exported = await fixture.store.exportScope(scope);
    assert.equal(exported.pullPages.find((row) => row.pageId === pageId)?.state, 'staged');
    assert.ok((await fixture.store.exportDiagnostics()).records
      .some((row) => row.kind === 'pull_page_retry' && row.pageId === pageId));
    assert.ok(exported.pullEvents.every((row) => row.state === 'authority_committed'));

    await fixture.store.deleteMapping(scope, 'native-other');
    await fixture.applier.resume();
    exported = await fixture.store.exportScope(scope);
    assert.equal(exported.pullPages.find((row) => row.pageId === pageId)?.state, 'page_complete');
    assert.equal(exported.cursor?.cursor, 'cursor-next');
    assert.equal((await fixture.store.getMappingByColpId(scope, 'node-created-1'))?.nativeId.startsWith('created-'), true);
    fixture.store.close();
  });

  test('hands a stale blocked page over at the authority rebase and pulls from the rebased cursor', async () => {
    const fixture = await setup();
    await fixture.store.putMapping(scope, mappingInput('native-other', 'node-created-1'));
    await fixture.applier.stage(fixture.page([fixture.createEvent('Bookmark', 1)], 'cursor-next'));
    await assert.rejects(() => fixture.applier.resume(), /recovery_required/);
    const blocked = (await fixture.store.exportScope(scope)).pullPages[0];
    assert.equal(blocked?.state, 'blocked');
    await fixture.store.rebaseActiveSessionAuthority(scope, { cursor: 'cursor-rebased',
      serverRevision: 'revision-rebased' });
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.scope?.lifecycle, 'active');
    assert.equal(exported.cursor?.cursor, 'cursor-rebased');
    assert.equal(exported.pullPages.some((row) => row.state === 'blocked'), false);
    assert.equal(exported.pullEvents.length, 0);
    assert.ok((await fixture.store.exportDiagnostics()).records.some((row) =>
      row.kind === 'pull_page_handover' && row.pageId === blocked?.pageId
        && row.recoveryCode === 'mapping_identity_conflict'));
    const requests: string[] = [];
    const applier = createPullApplier({ ...fixture.options,
      endpoints: { syncPull: 'https://known.example/pull', syncEffectPages: effectPageTemplate },
      credential: { accessToken: 'access-token' },
      fetch: async (url) => { requests.push(String(url));
        return Response.json(pullFixtures.page({ events: [], nextCursor: 'cursor-rebased',
          collectionRevision: 'revision-rebased' })); } });
    await applier.pull('cursor-rebased');
    assert.equal(new URL(requests[0]!).searchParams.get('cursor'), 'cursor-rebased');
    assert.equal((await fixture.store.getCursor(scope))?.cursor, 'cursor-rebased');
    assert.equal((await fixture.store.exportScope(scope)).pullPages.length, 1);
    fixture.store.close();
  });

  test('parks a committed detached page and does not let it overwrite the rebased cursor', async () => {
    const fixture = await setup();
    await fixture.store.stagePullPage(scope, { pageId: 'paged-block', previousCursor: 'cursor-old',
      nextCursor: 'cursor-next', collectionRevision: 'revision-next', pageDigest: 'sha256:paged-block',
      events: [{ eventId: 'paged-e1', cursor: 'cursor-next', operationId: 'op-paged', effectId: 'fx-paged',
        effectDigest: 'sha256:fx-paged', operationDigest: 'sha256:op-paged', kind: 'subtree_deleted',
        initialState: 'authority_committed', payload: {} }],
      effectPages: [{ eventId: 'paged-e1', effectId: 'fx-paged', pageNumber: 1, pageDigest: 'sha256:page-1',
        previousPageDigest: null, payload: {} }] });
    let exported = await fixture.store.exportScope(scope);
    assert.equal(exported.pullEvents.length, 1);
    assert.equal(exported.effectPages.length, 1);
    await engineRecoveryFlags(fixture.store);
    await fixture.store.rebaseActiveSessionAuthority(scope, { cursor: 'cursor-detached',
      serverRevision: 'revision-detached' });
    await fixture.applier.resume();
    exported = await fixture.store.exportScope(scope);
    assert.equal(exported.cursor?.cursor, 'cursor-detached');
    assert.equal(exported.pullPages[0]?.state, 'blocked');
    assert.equal(exported.pullPages[0]?.recoveryCode, 'authority_reconcile');
    assert.equal(exported.pullEvents.length, 1);
    assert.equal(exported.effectPages.length, 1);
    await engineRecoveryFlags(fixture.store);
    await fixture.store.rebaseActiveSessionAuthority(scope, { cursor: 'cursor-restart',
      serverRevision: 'revision-restart' });
    exported = await fixture.store.exportScope(scope);
    assert.equal(exported.pullEvents.length, 1, 'known apply evidence is not discarded with the page');
    assert.equal(exported.effectPages.length, 1);
    assert.equal(exported.cursor?.cursor, 'cursor-restart');
    assert.equal(exported.scope?.lifecycle, 'active');
    fixture.store.close();
  });

  test('retires a stale staged page at rebase and does not write it to Chrome', async () => {
    const fixture = await setup();
    await fixture.applier.stage(fixture.page([fixture.createEvent('Bookmark')], 'cursor-next'));
    await engineRecoveryFlags(fixture.store);
    await fixture.store.rebaseActiveSessionAuthority(scope, { cursor: 'cursor-rebased',
      serverRevision: 'revision-rebased' });
    await fixture.applier.resume();
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.cursor?.cursor, 'cursor-rebased');
    assert.equal(exported.scope?.lifecycle, 'active');
    assert.equal(exported.pullPages.length, 0);
    assert.equal(exported.pullEvents.length, 0);
    assert.equal(fixture.api.calls.filter((call) => call.kind === 'create').length, 0);
    assert.ok((await fixture.store.exportDiagnostics()).records.some((row) =>
      row.kind === 'pull_page_handover' && row.code === 'stale_unapplied_page_retired'));
    await engineRecoveryFlags(fixture.store);
    await fixture.store.rebaseActiveSessionAuthority(scope, { cursor: 'cursor-rebased-again',
      serverRevision: 'revision-rebased-again' });
    const handedOver = await fixture.store.exportScope(scope);
    assert.equal(handedOver.scope?.lifecycle, 'active');
    assert.equal(handedOver.cursor?.cursor, 'cursor-rebased-again');
    assert.equal(handedOver.pullPages.length, 0);
    fixture.store.close();
  });

  test('does not apply a staged page whose chain rewinds behind the rebased cursor', async () => {
    const fixture = await setup();
    await engineRecoveryFlags(fixture.store);
    await fixture.store.rebaseActiveSessionAuthority(scope, { cursor: spc2(5), serverRevision: 'revision-5' });
    await fixture.applier.stage(fixture.page([fixture.createEvent('Bookmark')], spc2(9)));
    await engineRecoveryFlags(fixture.store);
    await fixture.store.rebaseActiveSessionAuthority(scope, { cursor: spc2(36), serverRevision: 'revision-36' });
    await fixture.applier.resume();
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.cursor?.cursor, spc2(36));
    assert.equal(exported.scope?.checkpoint?.cursor, spc2(36));
    assert.equal(exported.pullPages.length, 0);
    assert.equal(fixture.api.calls.filter((call) => call.kind === 'create').length, 0);
    fixture.store.close();
  });

  test('does not let an old staged page overwrite a newer authority cursor', async () => {
    const fixture = await setup();
    await engineRecoveryFlags(fixture.store);
    await fixture.store.rebaseActiveSessionAuthority(scope, { cursor: spc2(5), serverRevision: 'revision-5' });
    await fixture.applier.stage(fixture.page([fixture.createEvent('Bookmark')], spc2(9)));
    await engineRecoveryFlags(fixture.store);
    await fixture.store.rebaseActiveSessionAuthority(scope, { cursor: spc2(3), serverRevision: 'revision-3' });
    await fixture.applier.resume();
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.cursor?.cursor, spc2(3));
    assert.equal(exported.scope?.checkpoint?.cursor, spc2(3));
    assert.equal(exported.pullPages.some((row) => row.state === 'page_complete'), false);
    assert.equal(fixture.api.calls.filter((call) => call.kind === 'create').length, 0);
    fixture.store.close();
  });

  test('keeps the normal multi-page forward chain and the existing staging invariants untouched', async () => {
    const fixture = await setup();
    await fixture.applier.stage(fixture.page([fixture.createEvent('Bookmark', 1)], 'cursor-1'));
    await fixture.applier.resume();
    await fixture.applier.stage(fixture.page([fixture.createEvent('Folder', 2)], 'cursor-2'));
    await fixture.applier.resume();
    // A page that does not attach at the durable cursor is still discontinuous, not a block.
    await assert.rejects(() => fixture.store.stagePullPage(scope, { pageId: 'discontinuous', previousCursor: 'cursor-other',
      nextCursor: 'cursor-3', collectionRevision: 'revision-3', pageDigest: 'sha256:discontinuous', events: [] }),
    /pull_cursor_discontinuous/);
    // A second page built on the same chain head as a leftover staged page is still pending.
    await fixture.applier.stage(fixture.page([fixture.createEvent('Bookmark', 3)], 'cursor-3'));
    await assert.rejects(() => fixture.applier.stage(fixture.page([fixture.createEvent('Bookmark', 4)], 'cursor-4')),
      /pull_page_pending/);
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.cursor?.cursor, 'cursor-2');
    assert.equal(exported.scope?.lifecycle, 'active');
    assert.equal(exported.pullPages.filter((row) => row.state === 'blocked').length, 0);
    assert.equal(fixture.api.calls.filter((call) => call.kind === 'create').length, 2);
    const diagnostics = (await fixture.store.exportDiagnostics()).records;
    assert.equal(diagnostics.some((row) => row.kind === 'pull_page_blocked'), false);
    assert.equal((await fixture.store.getEngineState(scope))?.recoveryFrozen, undefined);
    fixture.store.close();
  });
});

describe('T-04 engine-driven pull block recovery (F005/F008)', () => {
  // Sync resilience (2026-10-18): a page blocked on a mapping identity conflict is a
  // replica-class stop whose exit is Rebuild. Later wakes make no Session or Pull
  // request and keep the blocked page's evidence; the stop is visible as terminal.
  test('never re-pulls the blocked cursor: the conflict keeps its evidence and waits for Rebuild', async () => {
    const fixture = await setup();
    await fixture.store.putMapping(scope, mappingInput('native-blocker', 'node-created-1'));
    const clock = { now: 1_000 };
    const pullRequests: string[] = []; const forced: boolean[] = [];
    const session = (cursor: string) => ({ sessionId: 'session-engine', credentialAuthorityDigest: 'a'.repeat(64),
      expiresAt: '2099-01-01T00:00:00Z', scope: 'collection' as const, acceptedProtocolVersion: '0.2' as const,
      snapshotRequired: false, conversionPolicy: { separator: 'preserve_remote' as const },
      collection: { collectionId: scope.collectionId, serverCursor: cursor, serverRevision: `revision-${cursor}` },
      replicaLease: { leaseId: 'lease-kns05', generation: '1', state: 'active' as const,
        expiresAt: '2099-01-01T00:00:00Z' } });
    const engine = createDurableSyncEngine({ ...fixture.options, origin: 'chrome-extension://extension-id',
      now: () => clock.now, schedule: () => undefined, pullApplier: fixture.applier,
      endpoints: async () => ({ syncPull: 'https://known.example/pull', syncAck: 'https://known.example/ack',
        syncSnapshot: 'https://known.example/snapshot' }),
      sessions: { async get(force = false) { forced.push(force);
        return { credential: { accessToken: 'access-token' }, session: session(force ? 'cursor-refreshed' : 'cursor-old') }; } },
      pushWorker: { async drain() { return { outcome: 'idle' } as never; } },
      snapshotProjector: async (rows) => rows,
      fetch: async (input, init) => {
        const url = String(input);
        if (url.includes('/pull')) { const cursor = String(new URL(url).searchParams.get('cursor'));
          pullRequests.push(cursor);
          // The conflict page is re-offered once under the stale cursor; after the
          // authority rebase the same chain restarts cleanly.
          return Response.json(cursor === 'cursor-old'
            ? pullFixtures.page({ events: [fixture.createEvent('Bookmark', 1)],
              nextCursor: 'cursor-next', collectionRevision: 'revision-next' })
            : pullFixtures.page({ events: [], nextCursor: cursor, collectionRevision: 'revision-refreshed' })); }
        const cursor = (JSON.parse(String(init?.body)) as { readonly cursor: string }).cursor;
        return Response.json({ replicaId: scope.replicaId, ackedCursor: cursor, ackedAt: '2026-07-28T00:00:00Z' });
      } });
    await engine.wake('manual');
    let exported = await fixture.store.exportScope(scope);
    assert.deepEqual(pullRequests, ['cursor-old']);
    assert.equal(exported.scope?.lifecycle, 'recovery_required');
    assert.equal(exported.scope?.metadata?.recoveryCode, 'mapping_identity_conflict');
    assert.equal(exported.pullPages[0]?.state, 'blocked');
    assert.equal(exported.pullPages[0]?.recoveryCode, 'mapping_identity_conflict');
    assert.equal(exported.engine.phase, 'recovery');
    assert.equal(exported.engine.recoveryFrozen, true);
    assert.equal(exported.engine.authorityRefreshRequired, true);
    assert.equal(exported.scope?.checkpoint?.cursor, 'cursor-old');
    assert.ok((await fixture.store.exportDiagnostics()).records.some((row) =>
      row.kind === 'pull_page_blocked' && row.code === 'mapping_identity_conflict'));

    for (const reason of ['manual', 'startup', 'alarm'] as const) {
      clock.now += 600_000;
      await engine.wake(reason);
    }
    exported = await fixture.store.exportScope(scope);
    assert.deepEqual(pullRequests, ['cursor-old'], 'the stale cursor is never re-pulled');
    assert.deepEqual(forced, [false], 'an active Session cannot clear a local identity conflict');
    assert.equal(exported.scope?.lifecycle, 'recovery_required');
    assert.equal(exported.pullPages[0]?.state, 'blocked', 'the evidence stays for Rebuild');
    assert.equal(exported.engine.recoveryFrozen, true);
    // The engine row keeps the generic freeze; the scope's recovery code names the cause for Status and health.
    assert.equal(exported.scope?.metadata?.recoveryCode, 'mapping_identity_conflict');
    assert.equal(needsReplicaRebuild(exported.scope?.metadata?.recoveryCode as string), true);
    fixture.store.close();
  });
});

describe('T-04 recovery capability premature freeze', () => {
  // Sync resilience (2026-10-18, third review task 3): a stream integrity failure is
  // fail-closed. The wake refreshes authority first, but an ordinary active Session
  // cannot bypass it: the stale cursor is never re-pulled, the stop keeps its cause,
  // and the breaker counts the integrity refresh so repeats stop automatic probes.
  test('a pull_page_reuse freeze never re-pulls the stale cursor: an active Session cannot clear it', async () => {
    const fixture = await engineSetup();
    await fixture.store.transitionEngine(engineScope, { phase: 'recovery', updatedAt: 1, recoveryFrozen: true,
      authorityRefreshRequired: true, notBefore: 0, lastError: 'pull_page_reuse' });
    await fixture.store.registerScope({ ...(await fixture.store.getScope(engineScope))!, lifecycle: 'recovery_required',
      metadata: { recoveryCode: 'pull_page_reuse' } });
    fixture.forcedSessions.push({ state: 'active', snapshotRequired: false, cursor: 'cursor-refreshed' });
    fixture.pullResponses.push(json(200, pullPage('cursor-advanced')));
    fixture.ackResponses.push(json(200, ack('cursor-advanced')));
    await fixture.engine.wake('alarm');
    const requests = fixture.pullRequests.map((url) => new URL(url).searchParams.get('cursor'));
    assert.equal(fixture.sessionForces[0], true);
    assert.deepEqual(requests, [], 'neither the stale nor the refreshed cursor is pulled under the integrity stop');
    const exported = await fixture.store.exportScope(engineScope);
    assert.equal(exported.scope?.lifecycle, 'recovery_required');
    assert.equal(exported.engine.recoveryFrozen, true);
    assert.equal(exported.engine.lastError, 'pull_page_reuse');
    assert.equal(exported.engine.circuitBreaker?.failures[0]?.code, 'replica_integrity_refresh');
    fixture.store.close();
  });

  test('freezes recovery and re-establishes Session authority instead of retrying the same denial', async () => {
    const fixture = await engineSetup({ snapshotRequired: true });
    await fixture.store.transitionEngine(engineScope, { phase: 'recovery', updatedAt: 1, recoveryFrozen: true,
      authorityRefreshRequired: true, notBefore: 0, lastError: 'stale_replica' });
    fixture.snapshotResponses.push(json(200, { ...snapshot(1, true, 'snap-page-2'),
      recoveryCapability: 'src1.premature' }));
    await fixture.engine.wake('alarm');
    const frozen = await fixture.store.exportScope(engineScope);
    assert.equal(frozen.scope?.lifecycle, 'recovery_required');
    assert.equal(frozen.engine.phase, 'recovery');
    assert.equal(frozen.engine.recoveryFrozen, true);
    assert.equal(frozen.engine.authorityRefreshRequired, true);
    assert.equal(frozen.engine.lastError, 'recovery_capability_premature');
    assert.deepEqual(fixture.sessionForces, [true]);
    assert.equal(fixture.snapshotRequests.length, 1);
    // The next wake refreshes Session authority and re-requests the Snapshot there.
    fixture.clock.now += 600_000;
    fixture.snapshotResponses.push(json(200, { ...snapshot(1, true, 'snap-page-2'),
      recoveryCapability: 'src1.premature' }));
    await fixture.engine.wake('alarm');
    assert.equal(fixture.sessionForces.length, 2);
    assert.ok(fixture.sessionForces.every((forced) => forced === true));
    assert.equal(fixture.snapshotRequests.length, 2);
    // A Session that is active again leaves recovery through the rebased authority cursor.
    fixture.clock.now += 600_000;
    fixture.forcedSessions.push({ state: 'active', snapshotRequired: false, cursor: 'cursor-recovered' });
    fixture.pullResponses.push(json(200, { events: [], nextCursor: 'cursor-recovered', hasMore: false,
      collectionRevision: 'revision-1', recommendedPullAfterSeconds: 30 }));
    fixture.ackResponses.push(json(200, { replicaId: engineScope.replicaId, ackedCursor: 'cursor-recovered',
      ackedAt: '2026-07-28T00:00:00Z' }));
    await fixture.engine.wake('alarm');
    const recovered = await fixture.store.exportScope(engineScope);
    assert.equal(recovered.scope?.lifecycle, 'active');
    assert.equal(recovered.cursor?.cursor, 'cursor-recovered');
    assert.equal(recovered.engine.recoveryFrozen, false);
    fixture.store.close();
  });
});
