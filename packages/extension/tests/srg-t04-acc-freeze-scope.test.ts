/**
 * T-04 acceptance probe (independent of the developer's cases).
 *
 * Goal 1: the widened FREEZE set must not turn ordinary, retryable Pull failures
 * into `recovery_required` (over-freeze).
 * Goal 2: after an F005 block, a pathological server that keeps re-offering a
 * conflicting page must never see the same cursor requested twice; every further
 * attempt has to go through a forced Session authority refresh.
 */
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { createDurableSyncEngine } from '../src/durable-sync-engine.js';
import { shouldFreezePullApply } from '../src/pull-recovery-freeze.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import { installKns05IndexedDb, mappingInput, scope, setup } from './kns-05-pull-harness.js';

installKns05IndexedDb();

function session(cursor: string) {
  return { sessionId: 'session-acc', credentialAuthorityDigest: 'a'.repeat(64),
    expiresAt: '2099-01-01T00:00:00Z', scope: 'collection' as const, acceptedProtocolVersion: '0.2' as const,
    snapshotRequired: false, conversionPolicy: { separator: 'preserve_remote' as const },
    collection: { collectionId: scope.collectionId, serverCursor: cursor, serverRevision: `revision-${cursor}` },
    replicaLease: { leaseId: 'lease-kns05', generation: '1', state: 'active' as const,
      expiresAt: '2099-01-01T00:00:00Z' } };
}

/** Real Pull applier + real durable engine, with the test owning the Pull/Session transport. */
async function engineFixture(handler: (cursor: string) => Response) {
  const fixture = await setup();
  const clock = { now: 1_000 }; const forced: boolean[] = []; const pullCursors: string[] = [];
  let sessionCursor = 'cursor-old';
  const engine = createDurableSyncEngine({ ...fixture.options, origin: 'chrome-extension://extension-id',
    now: () => clock.now, schedule: () => undefined, pullApplier: fixture.applier,
    endpoints: async () => ({ syncPull: 'https://known.example/pull', syncAck: 'https://known.example/ack',
      syncSnapshot: 'https://known.example/snapshot' }),
    sessions: { async get(force = false) { forced.push(force);
      if (force) sessionCursor = `cursor-refreshed-${forced.filter(Boolean).length}`;
      return { credential: { accessToken: 'access-token' }, session: session(sessionCursor) }; } },
    pushWorker: { async drain() { return { outcome: 'idle' } as never; } },
    snapshotProjector: async (rows) => rows,
    fetch: async (input, init) => {
      const url = String(input);
      if (url.includes('/pull')) {
        const cursor = String(new URL(url).searchParams.get('cursor')); pullCursors.push(cursor);
        return handler(cursor);
      }
      const cursor = (JSON.parse(String(init?.body)) as { readonly cursor: string }).cursor;
      return Response.json({ replicaId: scope.replicaId, ackedCursor: cursor, ackedAt: '2026-07-28T00:00:00Z' });
    } });
  return { fixture, engine, clock, forced, pullCursors };
}

describe('T-04 acceptance: freeze trigger surface', () => {
  test('freezes the F005 family and leaves retryable/normal Pull failures unfrozen', () => {
    for (const code of ['pull_page_reuse', 'recovery_capability_premature', 'recovery_required']) {
      assert.equal(shouldFreezePullApply(new Error(code)), true, code);
    }
    // Ordinary transient transport / normal-flow guard failures must stay retryable.
    for (const code of ['pull_failed', 'rate_limited', 'network_unavailable', 'sync_paused',
      'pull_page_pending', 'pull_cursor_discontinuous', 'pull_page_incomplete', 'pull_event_state_invalid',
      'intent_correlation_active', 'internal_error', 'service_unavailable', 'constraint_error', 'worker_crash']) {
      assert.equal(shouldFreezePullApply(new Error(code)), false, code);
    }
  });
});

describe('T-04 acceptance: transient failures do not freeze the scope', () => {
  test('a 503 Pull leaves the scope active and the next wake completes the page', async () => {
    let fail = true;
    const { fixture, engine, clock } = await engineFixture((cursor) => fail
      ? new Response('unavailable', { status: 503 })
      : Response.json(pullFixtures.page({ events: [fixture.createEvent('Bookmark', 1)],
        nextCursor: `${cursor}-next`, collectionRevision: 'revision-next' })));
    await engine.wake('manual');
    let exported = await fixture.store.exportScope(scope);
    assert.equal(exported.scope?.lifecycle, 'active');
    assert.equal(exported.scope?.metadata?.recoveryCode, undefined);
    assert.equal(exported.engine.phase, 'offline');
    assert.notEqual(exported.engine.recoveryFrozen, true);
    assert.notEqual(exported.engine.authorityRefreshRequired, true);
    assert.equal(exported.scope?.checkpoint?.cursor, 'cursor-old');
    // The very next wake must still be able to run the ordinary forward Pull path.
    fail = false; clock.now += 600_000;
    await engine.wake('manual');
    exported = await fixture.store.exportScope(scope);
    assert.equal(exported.scope?.lifecycle, 'active');
    assert.equal(exported.cursor?.cursor, 'cursor-old-next');
    assert.equal(exported.pullPages[0]?.state, 'page_complete');
    assert.equal(exported.engine.lastError, undefined);
    fixture.store.close();
  });
});

describe('T-04 acceptance: a blocked page never retries the same cursor', () => {
  test('four pathological wakes never re-request the stale cursor and always refresh authority', async () => {
    const { fixture, engine, clock, forced, pullCursors } = await engineFixture((cursor) =>
      Response.json(pullFixtures.page({ events: [fixture.createEvent('Bookmark', 1)],
        nextCursor: `${cursor}-next`, collectionRevision: 'revision-next' })));
    // The pre-existing mapping for the colpId the page creates makes every page completion conflict.
    await fixture.store.putMapping(scope, mappingInput('native-blocker', 'node-created-1'));
    for (let wake = 0; wake < 4; wake += 1) {
      await engine.wake('manual');
      const exported = await fixture.store.exportScope(scope);
      assert.equal(exported.scope?.lifecycle, 'recovery_required', `wake ${wake}`);
      assert.equal(exported.engine.recoveryFrozen, true, `wake ${wake}`);
      assert.equal(exported.engine.authorityRefreshRequired, true, `wake ${wake}`);
      clock.now += 600_000;
    }
    // One Pull per wake: no retry loop inside a wake.
    assert.equal(pullCursors.length, 4);
    assert.deepEqual(pullCursors, ['cursor-old', 'cursor-refreshed-1', 'cursor-refreshed-2', 'cursor-refreshed-3']);
    // Session authority is refreshed before every retry; the stale cursor is never reused.
    assert.deepEqual(forced, [false, true, true, true]);
    assert.equal(pullCursors.filter((cursor) => cursor === 'cursor-old').length, 1);
    assert.equal(new Set(pullCursors).size, pullCursors.length);
    fixture.store.close();
  });
});
