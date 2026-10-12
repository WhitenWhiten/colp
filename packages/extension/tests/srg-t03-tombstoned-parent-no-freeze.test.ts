/**
 * A-06 joint acceptance (2026-09-12 sync audit claim verification): "S6 墓碑父改挂 … 服务端 422 路径触发时**不**整库冻结（与 A-04 联验）".
 *
 * The two halves of that sentence were verified separately and never together:
 *
 * - SR-05 (`15cef125`) pinned "a `rejected` drain outcome no longer freezes the
 *   replica and the wake still Pulls" (`solution.md` §S4, `acceptance.md:46`), but
 *   through the engine harness's **fake** Push peer, which only replays an outcome
 *   string (`durable-sync-engine-harness.ts` `push.drain()`).
 * - SR-07 (`2cfb72ca`) pinned "a queued create under a tombstoned parent is
 *   re-anchored or settles `rejected` with `tombstoned_parent_no_anchor`"
 *   (`solution.md` §S6), but through the **real** worker with no engine
 *   (`srg-t03-delete-recovery.test.ts` D-03/D-03b; D-03b's own comment says
 *   "Whether the engine then skips its freeze cycle is A-04's joint check").
 *
 * The seam between them is exactly where the risk lives: SR-07's no-anchor branch
 * settles the row `rejected` but returns the drain outcome `'terminal'`
 * (`tombstone-parent-rebase.ts`), so the engine walks its ordinary terminal path;
 * while a server-side semantic refusal (`invalid_document`, 422,
 * `problems.ts:40` `retryable: false` → `classifyPushProblem` → `'rejected'`,
 * `push-authority.ts:58`) settles the row through `outbound-push-worker.ts:340-344`
 * and returns `'rejected'`. Only the second outcome reaches the SR-05 branch
 * (`durable-sync-engine.ts:212-227`). Neither combination had ever been executed.
 *
 * This file therefore drives ONE store with a real `createOutboundPushWorker` and a
 * real `createDurableSyncEngine` (`tests/kns-04-push-harness.ts` `pushOptions`
 * pattern for the worker; `tests/durable-sync-engine-harness.ts` wiring for the
 * engine — read-only reference, that harness is NOT modified). The assertions pin
 * observable facts only: drain outcomes, durable queue row `status`/`recovery.code`,
 * engine state fields, scope lifecycle, the fetch call log, and a fresh-lease
 * `claimNextQueue` probe.
 */
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import type { SyncPullV02 } from '@know-n/colp/types';
import { describe, test } from 'vitest';
import { createDurableSyncEngine } from '../src/durable-sync-engine.js';
import { queueStatusProjection } from '../src/engine-public-stability.js';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { createPullApplier, type PullBookmarkApi } from '../src/pull-applier.js';
import { classifyPushProblem } from '../src/push-authority.js';
import { createSyncStateStore, type JsonObject, type SyncScope } from '../src/sync-state-store.js';
import { pullFixtures as reviewPullFixtures } from './pull-effect-fixtures.js';
import { endpoints } from './kns-04-push-harness.js';

const scope: SyncScope = Object.freeze({
  environment: 'production', serverId: 'server-a06', serverOrigin: 'https://known.example',
  accountId: 'account-a06', browserProfileId: 'profile-a06', collectionId: 'collection-a06',
  replicaId: 'replica-a06', generation: 1,
});

/** The live set `firstLiveQueueRow` claims from (`queue-live-work.ts` LIVE_STATUSES). */
const LIVE_STATUSES = ['pending', 'claimed', 'deferred', 'unknown', 'gap', 'blocked'] as const;

function json(status: number, body: unknown, headers: Readonly<Record<string, string>> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/**
 * The real COLP refusal shape the Push wire parses (`sync-push-wire.ts` `parseColpProblem`):
 * `packages/server/src/transport/colp-sync/sync-push-routes.ts` `sendProblem` →
 * `packages/node/src/server/publication-problems.ts:75,82`, which serializes the registry `retryable`
 * and a hyphenated `type` (same shape the backend fixture
 * `packages/server/tests/fixtures/sync/push-response-bytes.ts` records for `sequence_gap`).
 */
function problem(status: number, code: string, extra: Readonly<Record<string, unknown>> = {}) {
  return new Response(JSON.stringify({
    type: `https://know-n.com/colp/problems/${code.replaceAll('_', '-')}`, title: code, status, code, ...extra,
  }), { status, headers: { 'Content-Type': 'application/problem+json' } });
}

/** The Ack-only Pull page (`durable-sync-engine-harness.ts` `emptyPullPage` shape). */
function emptyPullPage(nextCursor: string) {
  return { events: [], nextCursor, hasMore: false, collectionRevision: 'revision-1',
    recommendedPullAfterSeconds: 30 };
}
function ackBody(cursor: string) {
  return { replicaId: scope.replicaId, ackedCursor: cursor, ackedAt: '2026-07-28T00:00:00Z' };
}
function mapping(nativeId: string, colpId: string, nodeKind: 'folder' | 'bookmark') {
  return { nativeId, colpId, rootNativeId: 'native-root', nodeKind,
    projection: { revision: 'revision-r1', ...(nodeKind === 'folder' ? { childrenRevision: 'children-r1' } : {}),
      digest: `sha256:${colpId}`, content: { title: colpId } } };
}

/** The one Session envelope both peers accept (engine `sessionAuthority`, worker `assertSession`). */
function sessionEnvelope() {
  return { credential: { accessToken: 'access-token-a06' },
    session: { sessionId: 'session-a06', credentialAuthorityDigest: 'a'.repeat(64),
      expiresAt: '2099-01-01T00:00:00Z', scope: 'collection' as const,
      collection: { collectionId: scope.collectionId, serverCursor: 'cursor-0', serverRevision: 'revision-0' },
      replicaLease: { leaseId: 'lease-a06', generation: '1', state: 'active' as const,
        expiresAt: '2099-01-01T00:00:00Z' },
      acceptedProtocolVersion: '0.2' as const, snapshotRequired: false,
      conversionPolicy: { separator: 'preserve_remote' as const } } };
}

/** A Chrome stand-in for the real applier; the Ack-only pages below never call it. */
function standInChrome(): PullBookmarkApi & { readonly calls: string[] } {
  const nodes = new Map<string, { id: string; parentId?: string; title?: string; url?: string }>();
  const calls: string[] = [];
  const removeTree = async (id: string): Promise<void> => {
    calls.push(`removeTree:${id}`);
    for (const child of [...nodes.values()].filter((node) => node.parentId === id)) await removeTree(child.id);
    nodes.delete(id);
  };
  return { calls,
    async create(input) { calls.push('create'); const id = `native-${nodes.size + 1}`;
      nodes.set(id, { id, parentId: input.parentId, title: input.title, url: input.url }); return { id }; },
    async update(id, changes) { calls.push(`update:${id}`); const node = nodes.get(id);
      if (node) nodes.set(id, { ...node, ...changes }); },
    async move(id, destination) { calls.push(`move:${id}`); const node = nodes.get(id);
      if (node) nodes.set(id, { ...node, parentId: destination.parentId ?? node.parentId }); },
    async remove(id) { calls.push(`remove:${id}`); nodes.delete(id); },
    removeTree,
    async get(id) { const node = nodes.get(id); return node ? [node] : []; },
    async getChildren(id) { return [...nodes.values()].filter((node) => node.parentId === id); } };
}

/** A fully stamped create row: an unstamped payload is refused as out of scope before rebasing. */
async function enqueueCreate(store: ReturnType<typeof createSyncStateStore>, opId: string, sequence: number,
  parentId: string) {
  const payload: JsonObject = { opId, replicaId: scope.replicaId, sequence, collectionId: scope.collectionId,
    type: 'create_node', baseRevision: null, occurredAt: '2026-07-27T00:00:00.000Z', dependencies: [],
    payload: { parentId, node: { kind: 'bookmark', title: 'Already queued', url: 'https://example.test/queued' } } };
  return store.allocateSequenceAndEnqueue(scope, { opId, batchId: `batch-${opId}`, idempotencyKey: `key-${opId}`,
    digest: `sha256:${opId}`, endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: null,
    operationRevision: `local-${opId}`, status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload },
  { allowUnstamped: true });
}

async function setupA06() {
  const store = createSyncStateStore({ indexedDB: new IDBFactory() });
  await store.registerScope({ ...scope, lifecycle: 'active',
    lease: { leaseId: 'lease-a06', expiresAt: Date.parse('2099-01-01T00:00:00Z') },
    checkpoint: { serverRevision: 'revision-0', cursor: 'cursor-0' },
    selectedRoots: ['root-colp'], rootStatus: 'ready', firstRun: 'completed' });
  await store.putMapping(scope, mapping('native-root', 'root-colp', 'folder'));
  const clock = { now: 1_000 };
  const order: string[] = []; const scheduled: number[] = []; const drainOutcomes: string[] = [];
  const pushRequests: Array<{ readonly url: string; readonly body: string }> = [];
  const pullRequests: string[] = [];
  const pushResponses: Response[] = [];
  const pullResponses: Array<Response | Promise<Response>> = [];
  const ackResponses: Array<Response | Promise<Response>> = [];
  // Probe seam: the engine resolves its transport at the top of `pull()`
  // (`durable-sync-engine.ts:262`), i.e. after the Push phase and before the Pull
  // transition that clears `lastError`. Entry 0 is therefore the state the engine
  // decided to keep pulling from; later entries are the Ack transport resolution
  // (`:410`) with `lastError` already cleared by `transition('pulling')`.
  const statesAtEngineTransport: Array<Awaited<ReturnType<typeof store.getEngineState>>> = [];
  const chrome = standInChrome();
  const sessions = { async get() { return sessionEnvelope(); } };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/push')) {
      order.push('push'); pushRequests.push({ url, body: String(init?.body) });
      const response = pushResponses.shift(); if (!response) throw new Error('push_response_missing'); return response;
    }
    if (url.includes('/pull')) {
      const cursor = new URL(url).searchParams.get('cursor') ?? '';
      order.push(`pull:${cursor}`); pullRequests.push(url);
      const response = pullResponses.shift(); if (!response) throw new Error('pull_response_missing'); return await response;
    }
    if (url.includes('/ack')) {
      const body = JSON.parse(String(init?.body)) as { readonly cursor?: string };
      order.push(`ack:${String(body.cursor)}`);
      const response = ackResponses.shift(); if (!response) throw new Error('ack_response_missing'); return await response;
    }
    throw new Error(`unexpected_fetch:${url}`);
  }) as typeof fetch;
  const worker = createOutboundPushWorker({ scope, store, endpoints: async () => endpoints, sessions,
    fetch: fetchImpl, now: () => clock.now, random: () => 0,
  ownerId: () => 'owner-a06-push', schedule: () => undefined });
  const applier = createPullApplier({ scope, store, api: chrome,
    session: { acceptedProtocolVersion: '0.2', sessionId: 'session-a06', collectionId: scope.collectionId,
      conversionPolicy: { separator: 'preserve_remote' } },
    effectPageTemplate: endpoints.syncEffectPages, effectPageAuthority: endpoints.effectPageAuthority,
    endpoints: { syncPull: endpoints.syncPull, syncEffectPages: endpoints.syncEffectPages },
    credential: { accessToken: 'access-token-a06' }, origin: 'chrome-extension://known-extension',
    now: () => clock.now, fetch: fetchImpl });
  const engine = createDurableSyncEngine({ scope, store, origin: 'chrome-extension://known-extension',
    endpoints: async () => { statesAtEngineTransport.push(await store.getEngineState(scope)); return endpoints; },
    sessions,
    pullApplier: {
      async stage(page: SyncPullV02, authority?: { readonly reissued?: boolean }) {
        order.push(`stage:${page.nextCursor}:reissued=${authority?.reissued === true}`);
        return applier.stage(page, authority);
      },
      async resume() { order.push('resume'); return applier.resume(); },
    },
    pushWorker: { async drain(onNetworkResponse?: () => void | Promise<void>) {
      const outcome = await worker.drain(onNetworkResponse); drainOutcomes.push(outcome.outcome); return outcome;
    } },
    now: () => clock.now, random: () => 0.5, schedule: (delay: number) => scheduled.push(delay),
    snapshotProjector: async () => { throw new Error('snapshot_projector_unexpected'); }, fetch: fetchImpl });
  await store.transitionEngine(scope, { phase: 'sleeping', updatedAt: clock.now, recoveryFrozen: false,
    notBefore: 0, authorityRefreshRequired: false });
  return { store, clock, order, scheduled, drainOutcomes, pushRequests, pullRequests, pushResponses,
    pullResponses, ackResponses, statesAtEngineTransport, chrome, engine };
}

type Fixture = Awaited<ReturnType<typeof setupA06>>;

async function liveQueueRows(store: Fixture['store']) {
  const rows = await Promise.all(LIVE_STATUSES.map((status) => store.listQueue(scope, status)));
  return rows.flat();
}
async function rowFor(store: Fixture['store'], opId: string) {
  const row = (await store.listQueue(scope)).find((item) => item.opId === opId);
  assert.ok(row, `queue row ${opId} must survive settlement (sequence-hole contract)`);
  return row;
}
async function diagnostic(store: Fixture['store'], kind: string, code: string) {
  const exported = await store.exportDiagnostics();
  return (exported.records as readonly Record<string, unknown>[])
    .find((row) => row.kind === kind && row.code === code);
}

describe('A-06 tombstoned-parent / 422 rejection never freezes the replica (real worker + real engine)', () => {
  test('(a) an unanchorable tombstoned-parent create settles rejected and the same wake still pulls', async () => {
    const fixture = await setupA06();
    await fixture.store.putMapping(scope, mapping('native-node', 'node-1', 'folder'));
    // The durable tombstone fact on its own (the same seed as D-03b): no keep-local
    // pass has run, so the mapping is not `unmounted:` yet.
    await fixture.store.putRemoteObservation(scope, { colpId: 'node-1', remoteRevision: 'revision-deleted',
      cursor: 'cursor-deleted', kind: 'tombstone', payload: { deleted: true },
      sourceDigest: 'sha256:tombstone-node-1', observedAt: 20 });
    // No mount at all: `createRebaseAnchor` has no legal target to re-point the create at.
    assert.deepEqual(await fixture.store.listMountBindings(scope), []);
    await enqueueCreate(fixture.store, 'queued-no-anchor', 1, 'node-1');
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-1'), { 'Known-Sync-Cursor-Reissued': 'true' }));
    fixture.ackResponses.push(json(200, ackBody('cursor-1')));

    await fixture.engine.wake('manual');

    // SR-07 (S6): the row settled rejected from the local tombstone fact, before any
    // byte-bound attempt, and left its diagnostic.
    const row = await rowFor(fixture.store, 'queued-no-anchor');
    assert.equal(row.status, 'rejected');
    assert.equal(row.recovery?.code, 'tombstoned_parent_no_anchor');
    assert.equal((row.payload.payload as { readonly parentId?: string }).parentId, 'node-1');
    assert.equal(fixture.pushRequests.length, 0, 'an unanchorable row settles before any Push request is bound');
    assert.ok(await diagnostic(fixture.store, 'tombstoned_parent_rebase', 'tombstoned_parent_no_anchor'));
    // …and the drain outcome SR-07 produces for it is 'terminal', not 'rejected'.
    assert.deepEqual(fixture.drainOutcomes, ['terminal']);

    // A-06 joint: that same wake did not freeze the replica and did Pull the accepted facts.
    const state = (await fixture.store.getEngineState(scope))!;
    assert.equal(state.recoveryFrozen, false);
    assert.notEqual(state.phase, 'recovery');
    assert.equal(state.phase, 'sleeping');
    assert.equal(state.authorityRefreshRequired, false);
    assert.equal((await fixture.store.getScope(scope))?.lifecycle, 'active');
    // A freeze would have rescheduled on the 1s recovery cadence instead of sleeping.
    assert.deepEqual(fixture.scheduled, [30_000]);
    assert.deepEqual(fixture.order,
      ['resume', 'pull:cursor-0', 'stage:cursor-1:reissued=true', 'resume', 'ack:cursor-1']);
    assert.equal(fixture.pullRequests.length, 1, 'the rejected row must not starve the Pull of accepted facts');
    assert.equal((await fixture.store.getCursor(scope))?.cursor, 'cursor-1');
    // The rejection stays user-visible through the durable row, which is what
    // `sw/engine.ts` reads for `rejectedPending` (SR-05 keeps this fact).
    assert.equal(queueStatusProjection(await fixture.store.listQueue(scope)), 'rejected');

    // Not re-claimed: no live row, no fresh claim, and the next wake pushes nothing.
    assert.deepEqual(await liveQueueRows(fixture.store), []);
    const probe = await fixture.store.acquireLease(scope, 'a06-probe', state.notBefore, 60_000);
    assert.equal(probe.outcome, 'acquired');
    assert.equal(await fixture.store.claimNextQueue(scope, 'a06-probe', probe.fence!, state.notBefore), null);
    fixture.clock.now = state.notBefore;
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-2'), { 'Known-Sync-Cursor-Reissued': 'true' }));
    fixture.ackResponses.push(json(200, ackBody('cursor-2')));
    await fixture.engine.wake('manual');
    assert.deepEqual(fixture.drainOutcomes, ['terminal'], 'a settled row is never re-drained');
    assert.equal(fixture.pushRequests.length, 0);
    assert.deepEqual(fixture.order.slice(5),
      ['resume', 'pull:cursor-1', 'stage:cursor-2:reissued=true', 'resume', 'ack:cursor-2']);
    assert.equal((await fixture.store.getCursor(scope))?.cursor, 'cursor-2');
    assert.equal((await rowFor(fixture.store, 'queued-no-anchor')).status, 'rejected');
  });

  test('(b) a server 422 invalid_document settles the row rejected and the same wake still pulls', async () => {
    const fixture = await setupA06();
    await fixture.store.putMapping(scope, mapping('native-node', 'node-1', 'folder'));
    await enqueueCreate(fixture.store, 'queued-422', 1, 'node-1');
    // The provenance of the refusal this case pins: 422 / retryable:false and the
    // single ordered classifier that routes it to `outbound-push-worker.ts:340-344`.
    assert.equal(classifyPushProblem({ code: 'invalid_document', retryable: false, status: 422 }), 'rejected');
    fixture.pushResponses.push(problem(422, 'invalid_document', { retryable: false }));
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-1'), { 'Known-Sync-Cursor-Reissued': 'true' }));
    fixture.ackResponses.push(json(200, ackBody('cursor-1')));

    await fixture.engine.wake('manual');

    // SR-05 (S4): the worker settled that exact row as terminal rejected with the
    // server's code and reported 'rejected' to the engine.
    const row = await rowFor(fixture.store, 'queued-422');
    assert.equal(row.status, 'rejected');
    assert.equal(row.recovery?.code, 'invalid_document');
    assert.deepEqual(fixture.drainOutcomes, ['rejected']);
    assert.equal(fixture.pushRequests.length, 1);
    const sent = JSON.parse(fixture.pushRequests[0]!.body) as { readonly operations: readonly
      { readonly opId: string; readonly payload: { readonly parentId: string } }[] };
    // No local rewrite happened: the live parent was uploaded as authored, so the
    // rejection is the server's verdict, not a tombstone rebase.
    assert.equal(sent.operations[0]!.opId, 'queued-422');
    assert.equal(sent.operations[0]!.payload.parentId, 'node-1');
    assert.equal(row.idempotencyKey, 'key-queued-422');
    assert.equal(await diagnostic(fixture.store, 'tombstoned_parent_rebase', 'tombstoned_parent_no_anchor'),
      undefined);

    // A-06 joint, first claim: a server-side semantic refusal settles the row, it does
    // NOT freeze the replica (the pre-SR-05 branch froze it and returned here).
    const state = (await fixture.store.getEngineState(scope))!;
    assert.equal(state.recoveryFrozen, false);
    assert.notEqual(state.phase, 'recovery');
    assert.equal(state.phase, 'sleeping');
    assert.equal(state.authorityRefreshRequired, false);
    assert.equal((await fixture.store.getScope(scope))?.lifecycle, 'active');
    // A freeze reschedules on the 1s recovery cadence instead of sleeping.
    assert.deepEqual(fixture.scheduled, [30_000]);
    // A-06 joint, second claim: the engine recorded the divergence on the row/wake and
    // went on to Pull in the same wake (`durable-sync-engine.ts:226` then `:230`).
    assert.ok(fixture.statesAtEngineTransport.length >= 1, 'the wake must reach the Pull transport');
    const enteringPull = fixture.statesAtEngineTransport[0]!;
    assert.equal(enteringPull.lastError, 'push_rejected');
    assert.equal(enteringPull.recoveryFrozen, false);
    assert.equal(enteringPull.authorityRefreshRequired, false);
    assert.deepEqual(fixture.order,
      ['push', 'resume', 'pull:cursor-0', 'stage:cursor-1:reissued=true', 'resume', 'ack:cursor-1']);
    assert.equal(fixture.pullRequests.length, 1, 'the 422 path must not skip this wake\'s Pull');
    assert.equal((await fixture.store.getCursor(scope))?.cursor, 'cursor-1');
    assert.equal(queueStatusProjection(await fixture.store.listQueue(scope)), 'rejected');

    // Not re-claimed on the next alarm either: still no live row and no new Push.
    assert.deepEqual(await liveQueueRows(fixture.store), []);
    const probe = await fixture.store.acquireLease(scope, 'a06-probe', state.notBefore, 60_000);
    assert.equal(probe.outcome, 'acquired');
    assert.equal(await fixture.store.claimNextQueue(scope, 'a06-probe', probe.fence!, state.notBefore), null);
    fixture.clock.now = state.notBefore;
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-2'), { 'Known-Sync-Cursor-Reissued': 'true' }));
    fixture.ackResponses.push(json(200, ackBody('cursor-2')));
    await fixture.engine.wake('manual');
    assert.deepEqual(fixture.drainOutcomes, ['rejected']);
    assert.equal(fixture.pushRequests.length, 1);
    assert.deepEqual(fixture.order.slice(6),
      ['resume', 'pull:cursor-1', 'stage:cursor-2:reissued=true', 'resume', 'ack:cursor-2']);
    assert.equal((await fixture.store.getCursor(scope))?.cursor, 'cursor-2');
    assert.equal((await rowFor(fixture.store, 'queued-422')).status, 'rejected');
  });
});

test('review: missing target must not repeat the same get after authority refresh', async () => {
  const f = await setupA06();
  await f.store.putMountBinding(scope, { mountId: 'review-mount', nativeRootId: 'native-root',
    remoteMountNodeId: 'root-colp', boundaryVersion: '1', materialized: true, status: 'active', rootRole: 'bookmarks-bar' });
  await f.store.putMapping(scope, { ...mapping('native-missing', 'node-1', 'bookmark'), parentNativeId: 'native-root' });
  let missingReads = 0;
  f.chrome.get = async (id) => {
    if (id === 'native-root') return [{ id, title: 'root-colp' }];
    missingReads += 1;
    throw new Error("Can't find bookmark for id.");
  };
  const event = reviewPullFixtures.mutationEvent({ kind: 'update', sequence: 1,
    collectionId: scope.collectionId, parentId: 'root-colp', targetId: 'node-1' });
  f.pullResponses.push(json(200, reviewPullFixtures.page({ events: [event], nextCursor: 'cursor-1', collectionRevision: 'revision-1' })));
  await f.engine.wake('manual');
  assert.equal((await f.store.getEngineState(scope))?.lastError, 'pull_apply_target_missing');
  const first = missingReads;
  for (let i = 0; i < 3; i++) {
    f.clock.now = (await f.store.getEngineState(scope))!.notBefore + 1;
    await f.engine.wake('manual');
  }
  assert.equal((await f.store.getEngineState(scope))?.lastError, 'pull_apply_target_missing');
  assert.equal((await f.store.listPullEvents(scope))[0]?.state, 'staged');
  assert.equal(f.pullRequests.length, 1);
  assert.equal(missingReads, first, 'engine wakes must not replay the unrecoverable native read');
});
