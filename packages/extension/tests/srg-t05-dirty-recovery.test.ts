/**
 * T-05 / F105 + F006 (extension side).
 *
 * F105: a recovery that starts from a *dirty* pre-recovery Pull world (a blocked page, a staged
 * page whose intent was prepared but never applied, and the unexpired intent itself) must clear
 * that world in the cutover and then keep pulling normally. The test drives the real durable
 * engine with the real Pull applier and the real state repositories; only Chrome and the network
 * are stand-ins.
 *
 * F006: a cursor-window expiry must give the stalled recovery a rebuild path - the staged chain
 * is discarded (with durable diagnostic evidence) and the next recovery starts at page 0 - while
 * every other freeze code keeps the staged chain untouched.
 */
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, test } from 'vitest';
import { createDurableSyncEngine } from '../src/durable-sync-engine.js';
import { createPullApplier, type PullBookmarkApi } from '../src/pull-applier.js';
import type { PullApplierOptions } from '../src/pull-applier-types.js';
import { freezePullApply, freezeScopeRecovery } from '../src/pull-recovery-freeze.js';
import { createSyncStateStore, type PullEventInput } from '../src/sync-state-store.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import { ack, json, problem, recoverySnapshot, scope } from './durable-sync-engine-harness.js';

type ChromeNode = { id: string; parentId?: string; title?: string; url?: string };
const expiry = '2099-01-01T00:00:00Z';

/** Minimal Chrome stand-in: the real Pull applier drives it through `api`. */
function chromeApi(nodes: Map<string, ChromeNode>) {
  const calls: Array<{ kind: string; id: string }> = [];
  const api: PullBookmarkApi & { readonly calls: typeof calls } = {
    calls,
    async create(input) {
      const id = `pull-created-${calls.length}`;
      nodes.set(id, { id, ...(typeof input.parentId === 'string' ? { parentId: input.parentId } : {}),
        title: typeof input.title === 'string' ? input.title : '',
        ...(typeof input.url === 'string' ? { url: input.url } : {}) });
      calls.push({ kind: 'create', id }); return { id };
    },
    async update(id, changes) { nodes.set(id, { ...nodes.get(id), ...changes } as ChromeNode); calls.push({ kind: 'update', id }); },
    async move(id, destination) { nodes.set(id, { ...nodes.get(id), ...destination } as ChromeNode); calls.push({ kind: 'move', id }); },
    async remove(id) { nodes.delete(id); calls.push({ kind: 'remove', id }); },
    async removeTree(id) {
      for (const node of [...nodes.values()]) if (node.parentId === id) nodes.delete(node.id);
      nodes.delete(id); calls.push({ kind: 'removeTree', id });
    },
    async get(id) {
      const node = nodes.get(id);
      return node ? [{ id: node.id, title: node.title ?? '',
        ...(node.parentId ? { parentId: node.parentId } : {}), ...(node.url ? { url: node.url } : {}) }] : [];
    },
    async getChildren(id) {
      return [...nodes.values()].filter((node) => node.parentId === id).map((node) => ({ id: node.id,
        title: node.title ?? '', ...(node.parentId ? { parentId: node.parentId } : {}), ...(node.url ? { url: node.url } : {}) }));
    },
  };
  return api;
}

/** The real durable engine over a real store, with the real applier and a routed fake network. */
async function createFixture() {
  const store = createSyncStateStore({ indexedDB: new IDBFactory() });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-t05', expiresAt: Date.parse(expiry) },
    checkpoint: { serverRevision: 'revision-0', cursor: 'cursor-0' }, selectedRoots: [],
    firstRun: 'running', rootStatus: 'ready' });
  const chromeNodes = new Map<string, ChromeNode>([['native-root', { id: 'native-root', title: 'Root' }]]);
  const api = chromeApi(chromeNodes);
  const clock = { now: 1_000 };
  const scheduled: number[] = [];
  const pullResponses: Response[] = []; const snapshotResponses: Response[] = []; const ackResponses: Response[] = [];
  const snapshotRequests: string[] = []; const pullRequests: string[] = [];
  const forcedSessions: Array<{ sessionId?: string; state: 'active'; snapshotRequired: boolean; cursor: string }> = [];
  let activeSessionId = 'session-engine'; let activeSnapshotRequired = false; let activeCursor = 'cursor-0';
  let recovered = false;
  const applierOptions: PullApplierOptions = { scope, store, api,
    session: { acceptedProtocolVersion: '0.2' as const, sessionId: 'session-engine', collectionId: scope.collectionId,
      conversionPolicy: { separator: 'preserve_remote' as const } },
    effectPageTemplate: 'https://known.example/effects/{effectId}/pages/{pageNumber}',
    effectPageAuthority: 'https://known.example', now: () => clock.now };
  const engine = createDurableSyncEngine({ scope, store, origin: 'chrome-extension://known-extension',
    endpoints: async () => ({ syncPull: 'https://known.example/v1/pull', syncAck: 'https://known.example/v1/ack',
      syncSnapshot: 'https://known.example/v1/snapshot' }),
    sessions: { async get(force = false) {
      const classified = force ? forcedSessions.shift() : undefined;
      if (force && (recovered || classified)) {
        activeSessionId = classified?.sessionId ?? 'session-renewed';
        activeSnapshotRequired = classified?.snapshotRequired ?? false;
        activeCursor = classified?.cursor ?? 'cursor-recovered';
      }
      return { credential: { accessToken: 'access-token' }, session: { sessionId: activeSessionId,
        credentialAuthorityDigest: 'a'.repeat(64), expiresAt: expiry,
        scope: 'collection' as const, acceptedProtocolVersion: '0.2' as const, snapshotRequired: activeSnapshotRequired,
        conversionPolicy: { separator: 'preserve_remote' as const },
        collection: { collectionId: scope.collectionId, serverCursor: activeCursor,
          serverRevision: `revision-${activeCursor}` },
        replicaLease: { leaseId: 'lease-t05', generation: '1', state: classified?.state ?? 'active',
          expiresAt: expiry } } };
    } },
    pullApplier: createPullApplier(applierOptions), pushWorker: { async drain() { return { outcome: 'idle' }; } },
    snapshotProjector: async (plans) => plans.map((plan) => ({ ...plan,
      nativeId: plan.parentColpId ? `snapshot:${plan.colpId}` : 'native-root', rootNativeId: 'native-root',
      ...(plan.parentColpId ? { parentNativeId: 'native-root' } : {}) })),
    now: () => clock.now, random: () => 0.5, schedule: (delay: number) => scheduled.push(delay),
    boundary: () => undefined,
    fetch: async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/pull')) { pullRequests.push(url); return pullResponses.shift()!; }
      // Recovery reads open conflicts before its bootstrap Ack (8064b521a); none are open here.
      if (url.includes('/snapshot/conflicts')) {
        return json(200, { snapshotId: new URL(url).searchParams.get('snapshotId'), offset: 0, limit: 50,
          conflictCount: 0, conflicts: [], nextOffset: null });
      }
      if (url.includes('/snapshot')) { snapshotRequests.push(url); return snapshotResponses.shift()!; }
      const response = ackResponses.shift()!; if (response.status === 200) recovered = true; return response;
    } });
  return { store, api, applierOptions, clock, engine, forcedSessions, pullResponses, snapshotResponses, ackResponses,
    snapshotRequests, pullRequests, scheduled, chromeNodes };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

function stagedEventInput(eventId: string, event: unknown, cursor: string) {
  const value = event as { readonly operation: { readonly opId: string };
    readonly effect: { readonly effectId: string; readonly effectDigest: string;
      readonly operationDigest: string; readonly kind: string } };
  return { eventId, cursor, operationId: value.operation.opId, effectId: value.effect.effectId,
    effectDigest: value.effect.effectDigest, operationDigest: value.effect.operationDigest,
    kind: value.effect.kind, payload: event as PullEventInput['payload'] };
}

function intentInput(eventId: string, event: unknown, correlationId: string) {
  const value = event as { readonly operation: { readonly opId: string };
    readonly effect: { readonly effectId: string } };
  return { intentId: `intent:${eventId}`, correlationId, operationId: value.operation.opId,
    eventId, effectId: value.effect.effectId,
    expected: { kind: 'create', nativeId: `pending:${value.effect.effectId}` },
    expiresAt: Date.now() + 300_000, state: 'intent_prepared', generation: scope.generation };
}

function bookmarkEvent(sequence: number) {
  return pullFixtures.createEvent({ kind: 'Bookmark', sequence,
    collectionId: scope.collectionId, parentId: 'root-server' });
}

/**
 * Reproduces the durable state a real interrupted Pull leaves behind: the mapping owner of an
 * incoming create blocks its page, and a second page carries a prepared-but-unapplied event.
 * Every write goes through the production repository entry points.
 */
async function seedPreRecoveryDirt(fixture: Fixture) {
  const store = fixture.store;
  await store.putMapping(scope, { nativeId: 'native-root', colpId: 'root-server', rootNativeId: 'native-root',
    nodeKind: 'folder', projection: { revision: 'revision-old', childrenRevision: 'children-old',
      digest: 'sha256:root-server', content: { title: 'Root' } } });
  await store.putMapping(scope, { nativeId: 'native-blocker', colpId: 'node-created-21', rootNativeId: 'native-root',
    nodeKind: 'bookmark', parentNativeId: 'native-root', projection: { revision: 'revision-old',
      digest: 'sha256:blocker', content: { title: 'Occupied', url: 'https://example.test/occupied' } } });

  const staged = bookmarkEvent(22);
  await store.stagePullPage(scope, { pageId: 'page-staged', previousCursor: 'cursor-0', nextCursor: 'cursor-staged',
    collectionRevision: 'revision-dirty', pageDigest: 'sha256:staged',
    events: [stagedEventInput('event-staged', staged, 'cursor-staged')] });
  await store.preparePullIntent(scope, 'event-staged', intentInput('event-staged', staged, 'correlation-staged'));

  const blocked = bookmarkEvent(21);
  await store.stagePullPage(scope, { pageId: 'page-blocked', previousCursor: 'cursor-0', nextCursor: 'cursor-blocked',
    collectionRevision: 'revision-dirty', pageDigest: 'sha256:blocked',
    events: [stagedEventInput('event-blocked', blocked, 'cursor-blocked')] });
  await store.preparePullIntent(scope, 'event-blocked', intentInput('event-blocked', blocked, 'correlation-blocked'));
  await store.commitPullEvent(scope, 'event-blocked', { mappings: [{ nativeId: 'native-race',
    colpId: 'node-created-21', rootNativeId: 'native-root', nodeKind: 'bookmark', parentNativeId: 'native-root',
    projection: { revision: 'revision-dirty', digest: 'sha256:race',
      content: { title: 'Remote', url: 'https://example.test/' } } }] });
  await assert.rejects(() => store.completePullPage(scope, 'page-blocked'), /recovery_required/u);
  await freezeScopeRecovery(store, scope, 'recovery_required', () => fixture.clock.now);
}

async function stageIncompleteSnapshotChain(store: Fixture['store']) {
  // Same identity as the Snapshot the next recovery serves (`snapshot-engine`), so only the
  // cursor-window escalation - not the Snapshot-identity mismatch - decides to rebuild.
  await store.stageRecoveryPage(scope, { snapshotId: 'snapshot-engine', sessionId: 'session-engine',
    revision: 'revision-stale', syncCursor: 'cursor-stale', identityDigest: 'identity-stale',
    rootNodeId: 'root-server', page: 0, pageDigest: 'sha256:stale', previousPageDigest: null,
    nextCursor: 'cursor-stale-1', complete: false, nodes: [] });
}

function diagnosticRecords(fixture: Fixture) {
  return fixture.store.exportDiagnostics().then((exported) => exported.records as Array<Record<string, unknown>>);
}

describe('T-05 F105: recovery from a dirty pre-recovery Pull world', () => {
  test('clears blocked pages, staged events and intents, then pulls on', async () => {
    const fixture = await createFixture();
    await seedPreRecoveryDirt(fixture);

    // The blocked page froze the scope; the authority refresh runs the Snapshot recovery.
    fixture.forcedSessions.push({ sessionId: 'session-engine', state: 'active', snapshotRequired: true, cursor: 'cursor-0' });
    fixture.snapshotResponses.push(json(200, recoverySnapshot(1, false, null)));
    fixture.ackResponses.push(json(200, ack('bootstrap-cursor')));
    await fixture.engine.wake('manual');

    const recovered = await fixture.store.exportScope(scope);
    assert.equal(recovered.scope?.lifecycle, 'active');
    assert.equal(recovered.engine.recoveryFrozen, false);
    assert.equal(recovered.cursor?.cursor, 'cursor-recovered');
    assert.equal(recovered.pullPages.length, 0, 'no blocked or staged page survives the cutover');
    assert.equal(recovered.pullEvents.length, 0, 'no pre-recovery event is left for resumeApply');
    assert.equal(recovered.intents.length, 0, 'no pre-recovery apply intent survives to block correlation');
    assert.equal(recovered.ackIntents.filter((intent) => intent.kind === 'bootstrap').length, 1);
    const discarded = (await diagnosticRecords(fixture)).filter((row) => row.kind === 'recovery_pre_apply_state_discarded');
    assert.equal(discarded.length, 1);
    assert.deepEqual({ pages: discarded[0]?.pageCount, blocked: discarded[0]?.blockedPageCount,
      events: discarded[0]?.eventCount, intents: discarded[0]?.intentCount },
    { pages: 2, blocked: 1, events: 2, intents: 2 });

    // The next inbound Pull applies its own event only: nothing pre-recovery reaches Chrome.
    fixture.clock.now += 600_000;
    fixture.pullResponses.push(json(200, pullFixtures.page({ events: [bookmarkEvent(40)],
      nextCursor: 'cursor-after-recovery', collectionRevision: 'revision-after' })));
    fixture.ackResponses.push(json(200, ack('cursor-after-recovery')));
    await fixture.engine.wake('manual');

    const advanced = await fixture.store.exportScope(scope);
    assert.equal(advanced.cursor?.cursor, 'cursor-after-recovery');
    assert.equal(advanced.engine.recoveryFrozen, false);
    assert.notEqual(advanced.engine.lastError, 'intent_correlation_active');
    assert.equal((await fixture.store.getMappingByColpId(scope, 'node-created-40'))?.nativeId, 'pull-created-0');
    assert.equal(await fixture.store.getMappingByColpId(scope, 'node-created-22'), null,
      'the leftover staged event was never applied after the cutover');
    assert.deepEqual(fixture.api.calls, [{ kind: 'create', id: 'pull-created-0' }]);
    assert.deepEqual((await fixture.store.listPullPages(scope)).map((page) => page.state), ['page_complete']);
    assert.equal((await fixture.store.auditIntegrity()).outcome, 'valid', 'the cutover discard must leave a structurally sound store');
  }, 30_000);
});

describe('T-05 F006: cursor-window expiry gives recovery a rebuild path', () => {
  test('discards the staged chain and rebuilds the Snapshot from page 0', async () => {
    const fixture = await createFixture();
    await stageIncompleteSnapshotChain(fixture.store);

    await freezePullApply(fixture.applierOptions, 'sync_cursor_expired');

    assert.equal(await fixture.store.hasRecoveryStaging(scope), false, 'the lapsed chain is discarded');
    const engineState = await fixture.store.getEngineState(scope);
    assert.equal(engineState?.recoveryFrozen, true);
    assert.equal(engineState?.authorityRefreshRequired, true);
    assert.equal(engineState?.lastError, 'sync_cursor_expired');
    assert.equal((await diagnosticRecords(fixture)).some((row) => row.kind === 'recovery_staging_discarded'
      && row.code === 'sync_cursor_expired'), true);

    fixture.forcedSessions.push({ sessionId: 'session-engine', state: 'active', snapshotRequired: true, cursor: 'cursor-0' });
    fixture.snapshotResponses.push(json(200, recoverySnapshot(1, false, null)));
    fixture.ackResponses.push(json(200, ack('bootstrap-cursor')));
    await fixture.engine.wake('manual');

    assert.deepEqual(fixture.snapshotRequests.map((url) => new URL(url).searchParams.get('pageCursor')),
      [null], 'the rebuilt chain starts at page 0 instead of resuming the discarded cursor');
    const recovered = await fixture.store.exportScope(scope);
    assert.equal(recovered.scope?.lifecycle, 'active');
    assert.equal(recovered.engine.recoveryFrozen, false);
    assert.equal(recovered.cursor?.cursor, 'cursor-recovered');
  }, 30_000);

  test('a Snapshot denial naming the lapsed cursor rebuilds the chain in the same wake', async () => {
    const fixture = await createFixture();
    await stageIncompleteSnapshotChain(fixture.store);

    // Production shape: the engine enters recovery under a fresh mandate, resumes the staged
    // chain, and the server denies that page cursor with `sync_cursor_expired`
    // (`snapshotFailure` renders it `snapshot_410_sync_cursor_expired`).
    await freezeScopeRecovery(fixture.store, scope, 'sync_cursor_expired', () => fixture.clock.now);
    fixture.forcedSessions.push({ sessionId: 'session-engine', state: 'active', snapshotRequired: true, cursor: 'cursor-0' });
    fixture.snapshotResponses.push(problem(410, 'sync_cursor_expired', {}),
      json(200, recoverySnapshot(1, false, null)));
    fixture.ackResponses.push(json(200, ack('bootstrap-cursor')));
    await fixture.engine.wake('manual');

    assert.deepEqual(fixture.snapshotRequests.map((url) => new URL(url).searchParams.get('pageCursor')),
      ['cursor-stale-1', null], 'the second attempt drops the lapsed cursor and starts at page 0');
    const recovered = await fixture.store.exportScope(scope);
    assert.equal(recovered.scope?.lifecycle, 'active');
    assert.equal(recovered.engine.recoveryFrozen, false);
    assert.equal(recovered.cursor?.cursor, 'cursor-recovered');
    assert.equal(recovered.engine.lastError, undefined);
    assert.equal((await diagnosticRecords(fixture)).some((row) => row.kind === 'recovery_staging_discarded'
      && row.code === 'snapshot_410_sync_cursor_expired'), true);
  }, 30_000);

  test('a bootstrap Ack denied for the lapsed capability drops the staging and recovers next wake', async () => {
    const fixture = await createFixture();
    // Complete pre-recovery chain whose capability window already lapsed: the cutover commits it
    // locally, the Ack denies it, and nothing can ever consume that chain again.
    await fixture.store.stageRecoveryPage(scope, { snapshotId: 'snapshot-engine', sessionId: 'session-engine',
      revision: 'revision-snapshot', syncCursor: 'cursor-lapsed', identityDigest: 'identity-lapsed',
      rootNodeId: 'root-server', page: 0, pageDigest: 'sha256:lapsed', previousPageDigest: null,
      nextCursor: null, complete: true, capability: 'src1.recovery-capability',
      nodes: [{ colpId: 'root-server', parentId: null, position: 'a', kind: 'Folder',
        payloadDigest: 'sha256:root-server',
        mapping: { nativeId: 'native-root', colpId: 'root-server', rootNativeId: 'native-root', nodeKind: 'folder',
          projection: { revision: 'revision-snapshot', childrenRevision: 'children-root',
            digest: 'sha256:root-server', content: { title: 'Root' } } } }] });
    await freezeScopeRecovery(fixture.store, scope, 'sync_cursor_expired', () => fixture.clock.now);
    fixture.forcedSessions.push({ sessionId: 'session-engine', state: 'active', snapshotRequired: true, cursor: 'cursor-0' });
    fixture.ackResponses.push(problem(410, 'sync_cursor_expired', {}));
    await fixture.engine.wake('manual');

    const lapsed = await fixture.store.exportScope(scope);
    assert.equal(await fixture.store.hasRecoveryStaging(scope), false, 'the uncommittable chain is dropped');
    assert.equal(lapsed.engine.recoveryFrozen, true);
    assert.equal(lapsed.engine.lastError, 'sync_cursor_expired');

    // The next wake rebuilds the Snapshot from page 0 and completes the Ack.
    fixture.clock.now += 600_000;
    fixture.forcedSessions.push({ sessionId: 'session-engine', state: 'active', snapshotRequired: true, cursor: 'cursor-0' });
    fixture.snapshotResponses.push(json(200, recoverySnapshot(1, false, null)));
    fixture.ackResponses.push(json(200, ack('bootstrap-cursor')));
    await fixture.engine.wake('manual');

    assert.deepEqual(fixture.snapshotRequests.map((url) => new URL(url).searchParams.get('pageCursor')), [null],
      'the rebuilt chain starts at page 0');
    const recovered = await fixture.store.exportScope(scope);
    assert.equal(recovered.scope?.lifecycle, 'active');
    assert.equal(recovered.engine.recoveryFrozen, false);
    assert.equal(recovered.cursor?.cursor, 'cursor-recovered');
    assert.deepEqual(recovered.ackIntents.filter((intent) => intent.kind === 'bootstrap')
      .map((intent) => [intent.state, intent.cursor]), [['complete', 'bootstrap-cursor']],
    'the Ack bound to the lapsed capability is gone instead of wedging every later wake');

    // A later wake must Pull, not replay the dead Ack intent.
    fixture.clock.now += 600_000;
    fixture.pullResponses.push(json(200, pullFixtures.page({ events: [bookmarkEvent(60)],
      nextCursor: 'cursor-after-lapse', collectionRevision: 'revision-after-lapse' })));
    fixture.ackResponses.push(json(200, ack('cursor-after-lapse')));
    await fixture.engine.wake('manual');
    assert.equal((await fixture.store.exportScope(scope)).cursor?.cursor, 'cursor-after-lapse');
  }, 30_000);

  test('a repeated Snapshot denial still freezes instead of looping', async () => {
    const fixture = await createFixture();
    await stageIncompleteSnapshotChain(fixture.store);
    await freezeScopeRecovery(fixture.store, scope, 'sync_cursor_expired', () => fixture.clock.now);
    fixture.forcedSessions.push({ sessionId: 'session-engine', state: 'active', snapshotRequired: true, cursor: 'cursor-0' });
    fixture.snapshotResponses.push(problem(410, 'sync_cursor_expired', {}),
      problem(410, 'sync_cursor_expired', {}));
    await fixture.engine.wake('manual');

    const state = await fixture.store.exportScope(scope);
    assert.equal(fixture.snapshotRequests.length, 2, 'the rebuild is attempted exactly once');
    assert.equal(state.engine.recoveryFrozen, true);
    assert.equal(state.engine.lastError, 'snapshot_410_sync_cursor_expired');
    assert.equal(await fixture.store.hasRecoveryStaging(scope), false);
  }, 30_000);

  test('other freeze codes keep the staged chain for the authority refresh', async () => {
    const fixture = await createFixture();
    await stageIncompleteSnapshotChain(fixture.store);

    await freezePullApply(fixture.applierOptions, 'pull_page_invalid');

    assert.equal(await fixture.store.hasRecoveryStaging(scope), true);
    assert.equal((await diagnosticRecords(fixture)).some((row) => row.kind === 'recovery_staging_discarded'), false);
    assert.equal((await fixture.store.getEngineState(scope))?.recoveryFrozen, true);
    assert.equal((await fixture.store.getEngineState(scope))?.lastError, 'pull_page_invalid');
  });
});
