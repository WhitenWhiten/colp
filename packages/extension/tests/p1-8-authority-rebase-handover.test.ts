/**
 * P1-8: an authority rebase must not apply an interrupted Pull page as the new cursor.
 * Not-called (`staged` + not started) is retired. Prepared, browser_call_started, and
 * any other unknown result stay, and an unproven retry does not create again.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { createDurableSyncEngine } from '../src/durable-sync-engine.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import { installKns05IndexedDb, scope, setup } from './kns-05-pull-harness.js';

installKns05IndexedDb();

const phases = ['before_intent', 'after_intent', 'before_event', 'after_browser_call', 'after_api_evidence', 'after_event'] as const;

function session(cursor: string) {
  return { sessionId: 'session-p18', credentialAuthorityDigest: 'a'.repeat(64),
    expiresAt: '2099-01-01T00:00:00Z', scope: 'collection' as const, acceptedProtocolVersion: '0.2' as const,
    snapshotRequired: false, conversionPolicy: { separator: 'preserve_remote' as const },
    collection: { collectionId: scope.collectionId, serverCursor: cursor, serverRevision: `revision-${cursor}` },
    replicaLease: { leaseId: 'lease-kns05', generation: '1', state: 'active' as const,
      expiresAt: '2099-01-01T00:00:00Z' } };
}

async function flagRecovery(store: Awaited<ReturnType<typeof setup>>['store']) {
  await store.transitionEngine(scope, { phase: 'recovery', updatedAt: 1, recoveryFrozen: true,
    authorityRefreshRequired: true, notBefore: 0, lastError: 'stale_replica' });
}

describe('P1-8 authority rebase after a real apply interruption', () => {
  test.each(phases)('refresh onto an active session after %s does not write the old page', async (boundary) => {
    const fixture = await setup(boundary);
    const clock = { now: 1_000 }; const cursors: string[] = [];
    const engine = createDurableSyncEngine({ ...fixture.options, origin: 'chrome-extension://extension-id',
      now: () => clock.now, schedule: () => undefined, pullApplier: fixture.applier,
      endpoints: async () => ({ syncPull: 'https://known.example/pull', syncAck: 'https://known.example/ack',
        syncSnapshot: 'https://known.example/snapshot' }),
      sessions: { async get(force = false) {
        return { credential: { accessToken: 'access-token' }, session: session(force ? 'cursor-refreshed' : 'cursor-old') };
      } },
      pushWorker: { async drain() { return { outcome: 'idle' } as never; } },
      snapshotProjector: async (rows) => rows,
      fetch: async (input, init) => {
        const url = String(input);
        if (url.includes('/pull')) {
          const cursor = String(new URL(url).searchParams.get('cursor')); cursors.push(cursor);
          return Response.json(cursor === 'cursor-old'
            ? fixture.page([fixture.createEvent('Bookmark')], 'cursor-next')
            : pullFixtures.page({ events: [], nextCursor: cursor, collectionRevision: 'revision-refreshed' }));
        }
        const cursor = (JSON.parse(String(init?.body)) as { readonly cursor: string }).cursor;
        return Response.json({ replicaId: scope.replicaId, ackedCursor: cursor, ackedAt: '2026-07-28T00:00:00Z' });
      } });
    await assert.rejects(() => engine.wake('manual'), /worker_crash/);
    const interrupted = fixture.api.calls.filter((call) => call.kind === 'create');
    const called = interrupted.length > 0;
    assert.equal(called, boundary === 'after_browser_call' || boundary === 'after_api_evidence' || boundary === 'after_event');
    fixture.disableCrash();
    await flagRecovery(fixture.store);
    clock.now += 600_000;
    await engine.wake('manual');
    await fixture.applier.resume();
    const creates = fixture.api.calls.filter((call) => call.kind === 'create');
    assert.equal(creates.length, interrupted.length, 'an unproven retry must not create another bookmark');
    assert.equal(fixture.api.all().filter((node) => node.title === 'Remote').length, interrupted.length);
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.cursor?.cursor, 'cursor-refreshed');
    assert.notEqual(exported.cursor?.cursor, 'cursor-next');
    assert.equal(exported.scope?.lifecycle, 'active');
    assert.deepEqual(cursors, ['cursor-old', 'cursor-refreshed']);
    if (!called && boundary === 'before_intent') {
      assert.equal(exported.pullEvents.length, 0);
      assert.equal(exported.engine.recoveryFrozen, false);
      assert.ok((await fixture.store.exportDiagnostics()).records.some((row) =>
        row.kind === 'pull_page_handover' && row.code === 'stale_unapplied_page_retired' && row.callFact === 'not_called'));
    } else if (!called) {
      assert.equal(exported.pullEvents.length, 1);
      assert.equal(exported.pullEvents[0]?.state, 'intent_prepared');
      assert.equal(exported.pullPages[0]?.recoveryCode, 'authority_reconcile');
      assert.equal(exported.engine.recoveryFrozen, true);
    } else {
      assert.equal(creates.length, 1);
      const mapping = await fixture.store.getMappingByColpId(scope, 'node-created-1');
      assert.equal(mapping?.nativeId, creates[0]?.nativeId);
      assert.equal(exported.pullEvents.length, 1);
    }
    fixture.store.close();
  });

  test('a staged not_started fact is retired and is not retried into Chrome', async () => {
    const fixture = await setup('after_intent');
    await fixture.applier.stage(fixture.page([fixture.createEvent('Bookmark')], 'cursor-next'));
    await assert.rejects(() => fixture.applier.resume(), /worker_crash/);
    const event = (await fixture.store.exportScope(scope)).pullEvents[0]!;
    await fixture.store.persistApplyIntentFacts(scope, String(event.intentId), {
      nativeResult: 'not_started', replayState: 'not_started', state: 'staged', eventState: 'staged' });
    await flagRecovery(fixture.store);
    await fixture.store.rebaseActiveSessionAuthority(scope, { cursor: 'cursor-rebased', serverRevision: 'revision-rebased' });
    await fixture.applier.resume();
    assert.equal((await fixture.store.exportScope(scope)).pullEvents.length, 0);
    assert.equal(fixture.api.calls.filter((call) => call.kind === 'create').length, 0);
    assert.ok((await fixture.store.exportDiagnostics()).records.some((row) => row.callFact === 'not_called'));
    fixture.store.close();
  });

  test('a staged result_unknown fact is kept and an unproven retry does not create', async () => {
    const fixture = await setup('after_intent');
    await fixture.applier.stage(fixture.page([fixture.createEvent('Bookmark')], 'cursor-next'));
    await assert.rejects(() => fixture.applier.resume(), /worker_crash/);
    const event = (await fixture.store.exportScope(scope)).pullEvents[0]!;
    await fixture.store.persistApplyIntentFacts(scope, String(event.intentId), {
      nativeResult: 'result_unknown', replayState: 'awaiting_receipt', eventState: 'staged' });
    await flagRecovery(fixture.store);
    await fixture.store.rebaseActiveSessionAuthority(scope, { cursor: 'cursor-rebased', serverRevision: 'revision-rebased' });
    await fixture.applier.resume();
    await fixture.applier.resume();
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.pullEvents.length, 1);
    assert.equal(exported.pullPages[0]?.recoveryCode, 'authority_reconcile');
    assert.equal(fixture.api.calls.filter((call) => call.kind === 'create').length, 0);
    assert.ok((await fixture.store.exportDiagnostics()).records.some((row) => row.callFact === 'unknown'));
    fixture.store.close();
  });

  test('a generation mismatch detaches a page even when previousCursor still matches', async () => {
    const fixture = await setup();
    await fixture.applier.stage(fixture.page([fixture.createEvent('Bookmark')], 'cursor-next'));
    const pageId = String((await fixture.store.exportScope(scope)).pullPages[0]?.pageId);
    await fixture.store.putScopeDiagnostic(scope, { kind: 'pull_page_authority', code: pageId, details: {
      pageId, previousCursor: 'cursor-old', authorityGeneration: 99 } });
    await flagRecovery(fixture.store);
    await fixture.store.rebaseActiveSessionAuthority(scope, { cursor: 'cursor-old', serverRevision: 'revision-old' });
    await fixture.applier.resume();
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.pullEvents.length, 0);
    assert.equal(exported.cursor?.cursor, 'cursor-old');
    assert.equal(fixture.api.calls.filter((call) => call.kind === 'create').length, 0);
    fixture.store.close();
  });

  test('handover stamps a retired not-called echo and drops the stale pull ack', async () => {
    const fixture = await setup();
    const queued = await fixture.store.allocateSequenceAndEnqueue(scope, {
      opId: 'old-local-update', batchId: 'batch-old', idempotencyKey: 'key-old', digest: 'sha256:old',
      endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: 'revision-old',
      operationRevision: 'local-old', status: 'pending', retry: { attempt: 0, notBefore: 0 },
      payload: { type: 'update_node_content', targetId: 'node-1',
        payload: { base: { title: 'Original' }, value: { title: 'Old local title' } } },
    }, { allowUnstamped: true });
    await fixture.store.completeQueueWithReceipt(scope, queued.sequence, {
      opId: queued.opId, operationDigest: queued.digest, kind: 'terminal', receiptId: 'receipt-old',
      resultDigest: 'sha256:result' });
    await fixture.store.stagePullPage(scope, { pageId: 'page-echo', previousCursor: 'cursor-old', nextCursor: 'cursor-echo',
      collectionRevision: 'revision-echo', pageDigest: 'sha256:echo', events: [{
        eventId: 'echo-1', cursor: 'cursor-echo', operationId: queued.opId, effectId: 'fx-echo',
        effectDigest: 'sha256:fx-echo', operationDigest: queued.digest, kind: 'node_content_updated', payload: {} }] });
    await assert.rejects(() => fixture.store.completePullPage(scope, 'page-echo'), /pull_page_incomplete/);
    await fixture.store.stagePullPage(scope, { pageId: 'page-empty', previousCursor: 'cursor-old', nextCursor: 'cursor-acked',
      collectionRevision: 'revision-acked', pageDigest: 'sha256:acked', events: [] });
    await fixture.store.completePullPage(scope, 'page-empty');
    const body = JSON.stringify({ sessionId: 'session-p18', cursor: 'cursor-acked', warnings: [] });
    await fixture.store.beginAckIntent(scope, { intentId: 'ack-old', kind: 'pull', sessionId: 'session-p18',
      cursor: 'cursor-acked', idempotencyKey: 'ack-old', endpointIdentity: 'syncAck', mediaType: 'application/json',
      body, bodyDigest: createHash('sha256').update(body).digest('hex') });
    await flagRecovery(fixture.store);
    await fixture.store.rebaseActiveSessionAuthority(scope, { cursor: 'cursor-rebased', serverRevision: 'revision-rebased' });
    const exported = await fixture.store.exportScope(scope);
    assert.equal((await fixture.store.getQueueByOpId(scope, queued.opId))?.echoApplied, true);
    assert.equal(exported.ackIntents.some((ack) => ack.intentId === 'ack-old'), false);
    assert.equal(exported.cursor?.cursor, 'cursor-rebased');
    fixture.store.close();
  });
});
