/**
 * T-04 round 2 (F005/B1): a blocked page whose chain head the server re-pages under
 * a new pageId ("growth page") must never surface a raw IndexedDB ConstraintError.
 *
 * Covered contract:
 *  - an equivalent re-delivered eventId is adopted idempotently (no duplicate row, no
 *    second Chrome apply) and the incoming page stays completable;
 *  - a conflicting re-delivery (same eventId, different bytes) fails with the named,
 *    frozen `pull_event_conflict` so the engine enters recovery instead of retrying
 *    the same cursor forever;
 *  - every blocked state keeps an exit: the page is replayed, handed over or finally
 *    completed once the underlying conflict clears.
 */
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { createDurableSyncEngine } from '../src/durable-sync-engine.js';
import { digest } from '../src/pull-codec.js';
import { shouldFreezePullApply } from '../src/pull-recovery-freeze.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import { installKns05IndexedDb, mappingInput, scope, setup } from './kns-05-pull-harness.js';

installKns05IndexedDb();

function session(cursor: string) {
  return { sessionId: 'session-growth', credentialAuthorityDigest: 'a'.repeat(64),
    expiresAt: '2099-01-01T00:00:00Z', scope: 'collection' as const, acceptedProtocolVersion: '0.2' as const,
    snapshotRequired: false, conversionPolicy: { separator: 'preserve_remote' as const },
    collection: { collectionId: scope.collectionId, serverCursor: cursor, serverRevision: `revision-${cursor}` },
    replicaLease: { leaseId: 'lease-kns05', generation: '1', state: 'active' as const,
      expiresAt: '2099-01-01T00:00:00Z' } };
}

/** Real durable engine + real Pull applier; the test owns the Pull/Session transport. */
async function engineFixture(handler: (call: number) => Response) {
  const fixture = await setup();
  const clock = { now: 1_000 }; const forced: boolean[] = []; const pullCursors: string[] = [];
  let call = 0;
  const engine = createDurableSyncEngine({ ...fixture.options, origin: 'chrome-extension://extension-id',
    now: () => clock.now, schedule: () => undefined, pullApplier: fixture.applier,
    endpoints: async () => ({ syncPull: 'https://known.example/pull', syncAck: 'https://known.example/ack',
      syncSnapshot: 'https://known.example/snapshot' }),
    sessions: { async get(force = false) { forced.push(force);
      // The server checkpoint never advances: the blocked page was never acked.
      return { credential: { accessToken: 'access-token' }, session: session('cursor-old') }; } },
    pushWorker: { async drain() { return { outcome: 'idle' } as never; } },
    snapshotProjector: async (rows) => rows,
    fetch: async (input, init) => {
      const url = String(input);
      if (url.includes('/pull')) {
        pullCursors.push(String(new URL(url).searchParams.get('cursor'))); call += 1; return handler(call);
      }
      const cursor = (JSON.parse(String(init?.body)) as { readonly cursor: string }).cursor;
      return Response.json({ replicaId: scope.replicaId, ackedCursor: cursor, ackedAt: '2026-07-28T00:00:00Z' });
    } });
  return { fixture, engine, clock, forced, pullCursors };
}

/** Same eventId (`cursor-next:op-1`), different bytes: the server re-signed a different effect. */
function mutatedLeading(cursor: string) {
  return { ...pullFixtures.createEvent({ kind: 'Bookmark', sequence: 1, collectionId: scope.collectionId,
    parentId: 'root-colp', extensions: { 'https://known.example/x': 'mutated' } }), cursor };
}

/** The reference server re-signs the still-unacked leading event with the retained
 * request-cursor expiry, so its cursor bytes (and eventId) are identical in both pages. */
function growthPages(fixture: Awaited<ReturnType<typeof setup>>) {
  const leading = fixture.createEvent('Bookmark', 1) as Record<string, unknown>;
  const extra = fixture.createEvent('Bookmark', 2) as Record<string, unknown>;
  const first = pullFixtures.page({ events: [leading], nextCursor: 'cursor-next',
    collectionRevision: 'revision-next' });
  const growth = pullFixtures.page({ events: [first.events[0]!, extra], nextCursor: 'cursor-next-2',
    collectionRevision: 'revision-next' });
  return { first, growth };
}

async function blockOnExistingMapping(fixture: Awaited<ReturnType<typeof setup>>, page: unknown) {
  await fixture.store.putMapping(scope, mappingInput('native-blocker', 'node-created-1'));
  await fixture.applier.stage(page);
  await assert.rejects(() => fixture.applier.resume(), /recovery_required/);
  const exported = await fixture.store.exportScope(scope);
  assert.equal(exported.pullPages[0]?.state, 'blocked');
  assert.equal(exported.pullPages[0]?.recoveryCode, 'mapping_identity_conflict');
  return exported;
}

describe('T-04R2 duplicate pull events', () => {
  test('adopts equivalent blocked events into the growth page instead of a ConstraintError', async () => {
    const fixture = await setup();
    const { first, growth } = growthPages(fixture);
    const blocked = await blockOnExistingMapping(fixture, first);
    const blockedPageId = String(blocked.pullPages[0]?.pageId);
    assert.equal(blocked.pullEvents.length, 1);
    assert.equal(blocked.pullEvents[0]?.state, 'authority_committed');

    // Same chain head, new pageId, superset of the blocked page's events: no throw.
    await fixture.applier.stage(growth);
    const exported = await fixture.store.exportScope(scope);
    assert.deepEqual(exported.pullPages.map((page) => [page.pageId, page.state]),
      [[digest({ previousCursor: 'cursor-old', nextCursor: 'cursor-next-2',
        events: growth.events.map((event) => `${event.cursor}:${event.operation.opId}`) }), 'staged']]);
    assert.equal(exported.pullEvents.length, 2);
    const adopted = exported.pullEvents.find((event) => String(event.eventId).endsWith(':op-1'));
    assert.equal(adopted?.pageId, exported.pullPages[0]?.pageId);
    assert.equal(adopted?.state, 'authority_committed', 'the applied event is never re-staged');
    assert.equal(exported.pullEvents.find((event) => String(event.eventId).endsWith(':op-2'))?.state, 'staged');
    assert.ok((await fixture.store.exportDiagnostics()).records.some((row) =>
      row.kind === 'pull_page_handover' && row.pageId === blockedPageId
        && row.code === 'superseded_by_growth_page'));
    assert.equal((await fixture.store.auditIntegrity()).outcome, 'valid');
    fixture.store.close();
  });

  test('rejects a growth page that re-delivers the same eventId with different bytes', async () => {
    const fixture = await setup();
    const { first, growth } = growthPages(fixture);
    await blockOnExistingMapping(fixture, first);
    const mutated = pullFixtures.page({ events: [mutatedLeading('cursor-next'), growth.events[1]!],
      nextCursor: 'cursor-next-2', collectionRevision: 'revision-next' });
    await assert.rejects(() => fixture.applier.stage(mutated), /pull_event_conflict/);
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.pullEvents.length, 1, 'the conflicting transaction rolled back');
    assert.equal(exported.pullPages.length, 1);
    assert.equal(exported.pullPages[0]?.state, 'blocked');
    assert.equal(exported.scope?.lifecycle, 'recovery_required');
    assert.equal(exported.engine.recoveryFrozen, true);
    assert.equal(exported.engine.lastError, 'pull_event_conflict');
    assert.equal((await fixture.store.auditIntegrity()).outcome, 'valid');
    fixture.store.close();
  });

  test('refuses a re-signed growth page instead of applying the same operation twice', async () => {
    const fixture = await setup();
    const { first } = growthPages(fixture);
    await blockOnExistingMapping(fixture, first);
    // New session/expiry context: the server re-signs the leading event with fresh
    // cursor bytes, so its eventId changes while the operation stays the same.
    const resigned = pullFixtures.page({ events: [
      { ...(first.events[0] as Record<string, unknown>), cursor: 'cursor-next-b' },
      fixture.createEvent('Bookmark', 2),
    ], nextCursor: 'cursor-next-b-2', collectionRevision: 'revision-next' });
    await assert.rejects(() => fixture.applier.stage(resigned), /pull_event_conflict/);
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.pullPages.length, 1, 'no second blocked page');
    assert.equal(exported.pullEvents.length, 1);
    assert.equal(fixture.api.calls.filter((entry) => entry.kind === 'create').length, 1,
      'the operation is never applied twice');
    assert.equal(exported.scope?.lifecycle, 'recovery_required');
    assert.equal(exported.engine.lastError, 'pull_event_conflict');
    fixture.store.close();
  });

  test('keeps effect pages of an adopted event under the growth page', async () => {
    const fixture = await setup();
    const create = fixture.createEvent('Bookmark', 1) as Record<string, unknown>;
    const subtree = pullFixtures.subtreeEvent({ sequence: 50, collectionId: scope.collectionId,
      targetId: 'node-1', members: ['node-1', 'node-child'], paged: true });
    const first = pullFixtures.page({ events: [create, subtree], nextCursor: 'cursor-next',
      collectionRevision: 'revision-next' });
    // The growth page re-delivers the same events plus one more, so the adopted events
    // keep their original cursor bytes and only the trailing event moves.
    const subtreePages = (subtree as { readonly __effectPages?: readonly unknown[] }).__effectPages ?? [];
    const growth = pullFixtures.page({ events: [first.events[0]!, { ...first.events[1]!, __effectPages: subtreePages },
      fixture.createEvent('Bookmark', 3)], nextCursor: 'cursor-next-2', collectionRevision: 'revision-next' });
    const blocked = await blockOnExistingMapping(fixture, first);
    const blockedPageId = String(blocked.pullPages[0]?.pageId);
    assert.equal(blocked.effectPages.length, 1);
    assert.equal(blocked.effectPages[0]?.pageId, blockedPageId);
    assert.equal(blocked.pullEvents.length, 2);

    await fixture.applier.stage(growth);
    const exported = await fixture.store.exportScope(scope);
    const pageId = String(exported.pullPages[0]?.pageId);
    assert.equal(exported.effectPages.length, 1);
    assert.equal(exported.effectPages[0]?.pageId, pageId);
    assert.equal(exported.effectPages[0]?.eventId, blocked.effectPages[0]?.eventId);
    assert.equal(exported.pullEvents.length, 3);
    assert.ok(exported.pullEvents.every((event) => event.pageId === pageId));
    assert.equal((await fixture.store.auditIntegrity()).outcome, 'valid');
    fixture.store.close();
  });

  test('keeps the discontinuous chain-head guard', async () => {
    const fixture = await setup();
    await assert.rejects(() => fixture.store.stagePullPage(scope, { pageId: 'detached',
      previousCursor: 'cursor-other', nextCursor: 'cursor-next', collectionRevision: 'revision-next',
      pageDigest: 'sha256:detached', events: [] }), /pull_cursor_discontinuous/);
    fixture.store.close();
  });
});

describe('T-04R2 freeze trigger surface', () => {
  test('freezes the identity-conflict family and leaves transport failures retryable', () => {
    for (const code of ['pull_event_conflict', 'recovery_capability_invalid', 'pull_page_reuse',
      'recovery_capability_premature', 'recovery_required', 'snapshot_chain_invalid', 'snapshot_graph_incomplete']) {
      assert.equal(shouldFreezePullApply(new Error(code)), true, code);
    }
    for (const code of ['pull_failed', 'rate_limited', 'network_unavailable', 'pull_page_pending',
      'pull_cursor_discontinuous', 'pull_page_incomplete', 'snapshot_http_503', 'payload_too_large']) {
      assert.equal(shouldFreezePullApply(new Error(code)), false, code);
    }
  });
});

describe('T-04R2 engine-level growth page (acceptance §2 reproduction)', () => {
  test('a mapping identity conflict preserves its blocked page until explicit Rebuild', async () => {
    const { fixture, engine, clock, forced, pullCursors } = await engineFixture((call) => {
      const { first, growth } = growthPages(fixture);
      return Response.json(call === 1 ? first : growth);
    });
    await fixture.store.putMapping(scope, mappingInput('native-blocker', 'node-created-1'));

    for (let wake = 0; wake < 4; wake += 1) {
      await engine.wake('manual');
      const exported = await fixture.store.exportScope(scope);
      // The old wedge surfaced a raw ConstraintError under an `active` lifecycle while
      // retrying the same cursor. Every wake must instead stay frozen in recovery.
      assert.notEqual(exported.engine.lastError, 'constraint_error', `wake ${wake}`);
      assert.notEqual(exported.engine.phase, 'offline', `wake ${wake}`);
      assert.equal(exported.scope?.lifecycle, 'recovery_required', `wake ${wake}`);
      assert.equal(exported.scope?.metadata?.recoveryCode, 'mapping_identity_conflict', `wake ${wake}`);
      assert.equal(exported.engine.recoveryFrozen, true, `wake ${wake}`);
      assert.equal(exported.engine.authorityRefreshRequired, true, `wake ${wake}`);
      clock.now += 600_000;
    }
    assert.deepEqual(pullCursors, ['cursor-old']);
    assert.deepEqual(forced, [false]);
    assert.equal(fixture.api.calls.filter((entry) => entry.kind === 'create').length, 1);
    assert.equal((await fixture.store.listPullPages(scope))[0]?.state, 'blocked');
    // Removing the blocker cannot silently authorize a previously unproven identity.
    await fixture.store.deleteMapping(scope, 'native-blocker');
    clock.now += 600_000;
    await engine.wake('manual');
    const stopped = await fixture.store.exportScope(scope);
    assert.equal(stopped.scope?.lifecycle, 'recovery_required');
    assert.equal(stopped.engine.recoveryFrozen, true);
    assert.equal(stopped.scope?.metadata?.recoveryCode, 'mapping_identity_conflict');
    assert.deepEqual(pullCursors, ['cursor-old']);
    assert.equal((await fixture.store.auditIntegrity()).outcome, 'valid');
    fixture.store.close();
  });

  test('a rebuild-only mapping conflict cannot be replaced by a byte-conflicting growth page', async () => {
    const { fixture, engine, clock, forced } = await engineFixture((call) => {
      const { first, growth } = growthPages(fixture);
      if (call === 1) return Response.json(first);
      return Response.json(pullFixtures.page({ events: [mutatedLeading('cursor-next'), growth.events[1]!],
        nextCursor: 'cursor-next-2', collectionRevision: 'revision-next' }));
    });
    await fixture.store.putMapping(scope, mappingInput('native-blocker', 'node-created-1'));
    await engine.wake('manual');
    clock.now += 600_000;
    await engine.wake('manual');
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.engine.lastError, 'recovery_required');
    assert.equal(exported.engine.phase, 'recovery');
    assert.equal(exported.engine.recoveryFrozen, true);
    assert.equal(exported.engine.authorityRefreshRequired, true);
    assert.equal(exported.scope?.lifecycle, 'recovery_required');
    assert.equal(exported.scope?.metadata?.recoveryCode, 'mapping_identity_conflict');
    assert.equal(exported.pullEvents.length, 1);
    assert.equal(exported.pullPages[0]?.state, 'blocked');
    assert.equal(exported.engine.lastError === 'constraint_error', false);
    assert.deepEqual(forced, [false]);
    fixture.store.close();
  });
});
