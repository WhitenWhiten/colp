import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { createReplicaRebuilder, REPLICA_REBUILD_JOURNAL, type ReplicaRebuildDeps } from '../src/replica-rebuild.js';
import { readReplicaRepairCapability } from '../src/replica-repair-capability.js';
import { withRebuildIdentityHints } from '../src/replica-rebuild-identity.js';
import { fenceReplicaOnServer, type ReplicaFenceDeps } from '../src/sw/replica-fence.js';
import { handleSyncAttentionRequest } from '../src/sw/sync-attention.js';
import type { WakeFailure } from '../src/sw/wake-failure.js';
import { setup } from './replica-rebuild-harness.js';

/**
 * K3: "Reset sync on this device" is possible from every stuck state. A change the server may own makes it
 * server-fenced (the old replica is retired on the server first, so archiving the uncertain upload loses
 * nothing and cannot duplicate it later); offline that is a named reason, not a hidden button. A Reset that
 * fails before anything is archived leaves no journal behind (W2A-02), and a pending one can be given up.
 */
type Fixture = Awaited<ReturnType<typeof setup>>;

async function calm(f: Fixture) {
  await f.store.transitionEngine(f.scope, { phase: 'sleeping', recoveryFrozen: false, authorityRefreshRequired: false,
    updatedAt: 2000, notBefore: 0 });
}
/** The queued change was sent and its answer lost: its exact bytes stay bound. */
async function sendAndLose(f: Fixture, code = 'push_response_invalid', attempt = 10) {
  const lease = await f.store.acquireLease(f.scope, 'test', 2000, 60_000);
  const row = (await f.store.claimNextQueue(f.scope, 'test', lease.fence, 2000))!;
  await f.store.bindPushAttempt(f.scope, row.sequence, 'test', lease.fence, { sessionId: 'old', batchId: row.batchId,
    idempotencyKey: row.idempotencyKey, endpointIdentity: 'syncPush', mediaType: 'application/json',
    body: JSON.stringify({ sessionId: 'old', batchId: row.batchId, atomic: false, operations: [row.payload] }), bodyDigest: 'sha256:uncertain' });
  await f.store.settleClaimedPush(f.scope, row.sequence, 'test', lease.fence, { outcome: 'unknown',
    retry: { attempt, notBefore: 0 }, recovery: { code } });
  return row;
}
const rebuilderWith = (f: Fixture, extra: Partial<ReplicaRebuildDeps>) => createReplicaRebuilder({ ...f.deps, ...extra });
async function confirm(rebuilder: ReturnType<typeof createReplicaRebuilder>) {
  const preview = await rebuilder.handle({ kind: 'known.scope.rebuild.preview' });
  assert.ok(preview.ok && 'preview' in preview);
  return rebuilder.handle({ kind: 'known.scope.rebuild.confirm', userGesture: true, replicaId: preview.preview.replicaId,
    generation: preview.preview.generation, revision: preview.preview.revision, targetFence: preview.preview.targetFence });
}

describe('what the Reset can do from each state', () => {
  test('a calm replica needs none; a frozen one resets locally', async () => {
    const f = await setup();
    try {
      const frozen = await readReplicaRepairCapability(f.store, f.scope);
      assert.deepEqual([frozen.rebuildAvailable, frozen.rebuildMode, frozen.rebuildBlockedReason, frozen.reason], [true, 'local', undefined, undefined]);
      await calm(f);
      const idle = await readReplicaRepairCapability(f.store, f.scope);
      assert.deepEqual([idle.rebuildAvailable, idle.rebuildMode, idle.reason], [false, 'local', 'rebuild_not_required']);
    } finally { f.store.close(); }
  });

  test('a sent upload that is not settled makes it server-fenced, and offline that is a named reason', async () => {
    const f = await setup();
    try {
      await calm(f); await sendAndLose(f);
      const online = await readReplicaRepairCapability(f.store, f.scope, undefined, { online: () => true });
      assert.deepEqual([online.rebuildAvailable, online.rebuildMode, online.rebuildBlockedReason], [true, 'server_fenced', undefined]);
      const offline = await readReplicaRepairCapability(f.store, f.scope, undefined, { online: () => false });
      assert.deepEqual([offline.rebuildAvailable, offline.rebuildMode, offline.rebuildBlockedReason, offline.reason],
        [false, 'server_fenced', 'offline', 'offline']);
    } finally { f.store.close(); }
  });

  test('a stalled upload under a calm engine offers the Reset (it had no exit)', async () => {
    const f = await setup();
    try {
      await calm(f);
      assert.equal((await readReplicaRepairCapability(f.store, f.scope)).rebuildAvailable, false, 'nothing is stuck yet');
      await sendAndLose(f, 'push_response_invalid', 8);
      const stalled = await readReplicaRepairCapability(f.store, f.scope);
      assert.deepEqual([stalled.rebuildAvailable, stalled.rebuildMode], [true, 'server_fenced']);
    } finally { f.store.close(); }
  });

  test('a state that cannot be read is still a stuck state with a way out', async () => {
    const f = await setup();
    try {
      const unreadable = { ...f.store, getEngineState: async () => { throw new Error('corruption_detected'); } } as typeof f.store;
      const online = await readReplicaRepairCapability(unreadable, f.scope, undefined, { online: () => true });
      assert.deepEqual([online.rebuildAvailable, online.rebuildMode, online.unreadable], [true, 'server_fenced', true]);
      const offline = await readReplicaRepairCapability(unreadable, f.scope, undefined, { online: () => false });
      assert.deepEqual([offline.rebuildAvailable, offline.rebuildBlockedReason], [false, 'offline']);
    } finally { f.store.close(); }
  });

  test('an unknown native side effect is settled by its own decision, not by a Reset', async () => {
    const f = await setup();
    try {
      const store = { ...f.store, listApplyIntents: f.store.listApplyIntents } as typeof f.store;
      const blocked = await readReplicaRepairCapability(store, f.scope, { waits: [{ waitReason: 'native_result_unknown' }],
        operationalTotal: 1, local: [], queue: [], pull: [], bootstrap: [], deletes: [], total: 1 } as never);
      assert.deepEqual([blocked.rebuildAvailable, blocked.rebuildBlockedReason], [false, 'native_outcome_unsettled']);
    } finally { f.store.close(); }
  });
});

describe('the Reset that retires the old replica on the server first', () => {
  test('a reset with nothing sent is local; the fence is tried but may fail without stopping it', async () => {
    const f = await setup(); let fenced = 0;
    try {
      const rebuilder = rebuilderWith(f, { fence: async () => { fenced += 1; throw new Error('offline'); } });
      const preview = await rebuilder.handle({ kind: 'known.scope.rebuild.preview' });
      assert.ok(preview.ok && 'preview' in preview && preview.preview.mode === 'local');
      assert.deepEqual(await confirm(rebuilder), { ok: true, result: 'setup_required' });
      assert.equal(fenced, 1);
      assert.equal((await f.store.exportArchive(f.scope)).reason, 'user_replica_rebuild');
      assert.equal(f.registrations, 1);
    } finally { f.store.close(); }
  });

  test('with an upload that may be on the server the fence comes first and the archive keeps the upload', async () => {
    const f = await setup(); const order: string[] = [];
    try {
      await calm(f); const sent = await sendAndLose(f);
      const rebuilder = rebuilderWith(f, { fence: async () => {
        order.push(await f.store.exportArchive(f.scope).then(() => 'archived-before-fence', () => 'fence-before-archive'));
        return 'fenced'; } });
      const preview = await rebuilder.handle({ kind: 'known.scope.rebuild.preview' });
      assert.ok(preview.ok && 'preview' in preview && preview.preview.mode === 'server_fenced');
      assert.deepEqual(await confirm(rebuilder), { ok: true, result: 'setup_required' });
      assert.deepEqual(order, ['fence-before-archive']);
      const archive = await f.store.exportArchive(f.scope);
      assert.ok((archive.queue as { opId: string; status: string; attempt?: unknown }[])
        .some(saved => saved.opId === sent.opId && saved.status === 'unknown' && saved.attempt), 'the uncertain upload is archived, never replayed');
      assert.equal(f.registrations, 1);
    } finally { f.store.close(); }
  });

  test('offline, or without a fence to use, nothing changes and no journal is left', async () => {
    const f = await setup();
    try {
      await calm(f); await sendAndLose(f);
      for (const [fence, code] of [[async () => { throw new Error('offline'); }, 'offline'], [undefined, 'fence_unavailable']] as const) {
        const rebuilder = rebuilderWith(f, fence ? { fence } : {});
        assert.deepEqual(await confirm(rebuilder), { ok: false, code });
        assert.equal(await rebuilder.hasPending(), false);
        assert.equal((await f.store.getScope(f.scope))?.lifecycle, 'active');
        await assert.rejects(() => f.store.exportArchive(f.scope), /archive_not_found/u);
      }
      assert.equal(f.registrations, 0);
    } finally { f.store.close(); }
  });

  test('a replica the server already retired counts as fenced', async () => {
    const f = await setup();
    try {
      await calm(f); await sendAndLose(f);
      assert.deepEqual(await confirm(rebuilderWith(f, { fence: async () => 'already_retired' })), { ok: true, result: 'setup_required' });
    } finally { f.store.close(); }
  });
});

describe('a reset that cannot finish does not stop sync (W2A-02)', () => {
  test('a reset that fails before anything is archived leaves no journal', async () => {
    const f = await setup();
    try {
      const failing = { ...f.store, retireScope: async () => { throw new Error('quota_exceeded'); } } as typeof f.store;
      const rebuilder = rebuilderWith(f, { store: failing });
      assert.deepEqual(await confirm(rebuilder), { ok: false, code: 'quota_exceeded' });
      assert.equal(await rebuilder.hasPending(), false, 'nothing is left to stop every wake');
      assert.equal((await f.journal.get(REPLICA_REBUILD_JOURNAL))[REPLICA_REBUILD_JOURNAL], undefined);
      assert.equal((await f.store.getScope(f.scope))?.lifecycle, 'active');
    } finally { f.store.close(); }
  });

  test('a pending reset that keeps failing can be given up; one already archived can only finish', async () => {
    const f = await setup();
    try {
      const failing = { ...f.store, retireScope: async () => { throw new Error('quota_exceeded'); } } as typeof f.store;
      const authority = await f.credentials.fence.capture(); const binding = (await f.credentials.loadBinding())!;
      await f.journal.set({ [REPLICA_REBUILD_JOURNAL]: { scope: f.scope, preview: f.preview, authorityGeneration: authority.generation,
        nextBinding: { ...binding, replicaId: 'replica-next', generation: '1' } } });
      const rebuilder = rebuilderWith(f, { store: failing });
      await assert.rejects(() => rebuilder.resume(), /quota_exceeded/u);
      await assert.rejects(() => rebuilder.resume(), /quota_exceeded/u);
      assert.equal(await rebuilder.hasPending(), true);
      assert.equal(await rebuilder.canCancelPending(), true);
      const attention = await handleSyncAttentionRequest({ scope: async () => f.scope, store: f.store,
        rebuildPending: () => rebuilder.hasPending(), rebuildCancelAvailable: () => rebuilder.canCancelPending(),
        wakeFailures: async () => [{ stage: 'rebuild_resume', code: 'quota_exceeded', count: 4, firstAt: 1, lastAt: 2 } satisfies WakeFailure] });
      assert.ok(attention.ok);
      assert.deepEqual([attention.attention.terminalCode, attention.attention.rebuildCancelAvailable, attention.attention.issueCount],
        ['replica_rebuild_pending', true, 1]);
      assert.deepEqual([attention.attention.issues?.[0]?.code, attention.attention.issues?.[0]?.stage, attention.attention.issues?.[0]?.rootCause],
        ['sync_step_failed', 'rebuild_resume', 'quota_exceeded']);
      assert.deepEqual(await rebuilder.handle({ kind: 'known.scope.rebuild.cancel', userGesture: true }), { ok: true, result: 'cancelled' });
      assert.equal(await rebuilder.hasPending(), false);
      assert.equal((await f.store.getScope(f.scope))?.lifecycle, 'active', 'sync goes on as it was');
      assert.deepEqual(await rebuilder.handle({ kind: 'known.scope.rebuild.cancel', userGesture: true }), { ok: true, result: 'cancelled' }, 'nothing to cancel is not an error');
    } finally { f.store.close(); }
  });

  test('once the old scope is archived the reset cannot be cancelled, only finished', async () => {
    const f = await setup();
    try {
      f.setOffline(true);
      assert.equal((await f.rebuilder.rebuildServerRetired(f.scope)).outcome, 'failed');
      assert.equal(await f.rebuilder.hasPending(), true);
      assert.equal(await f.rebuilder.canCancelPending(), false);
      assert.deepEqual(await f.rebuilder.handle({ kind: 'known.scope.rebuild.cancel', userGesture: true }), { ok: false, code: 'rebuild_not_cancellable' });
      assert.equal(await f.rebuilder.hasPending(), true);
      f.setOffline(false);
      assert.equal(await f.rebuilder.resume(), true);
    } finally { f.store.close(); }
  });
});

describe('retiring the replica on the server', () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const make = (statuses: number[], overrides: Partial<ReplicaFenceDeps> = {}) => {
    calls.length = 0; let refreshes = 0;
    const deps: ReplicaFenceDeps = { endpoint: async () => 'https://known.example/colp/v0.1/sync/retire', origin: 'chrome-extension://x',
      authority: async (refresh) => { if (refresh) refreshes += 1; return { credential: { accessToken: 'token' }, session: { sessionId: refresh ? 'session-fresh' : 'session-stored' } }; },
      fetch: async (input, init) => { calls.push({ url: String(input), init: init ?? {} }); return new Response(null, { status: statuses[calls.length - 1] ?? 204 }); },
      assertHost: async () => undefined, ...overrides };
    return { deps, refreshes: () => refreshes };
  };
  const reason = async (deps: ReplicaFenceDeps) => fenceReplicaOnServer(deps).then(() => 'ok', (error: Error) => error.message);

  test('204 is a fence, and the request carries the Session and origin of this replica', async () => {
    const { deps } = make([204]);
    assert.equal(await fenceReplicaOnServer(deps), 'fenced');
    const headers = new Headers(calls[0]!.init.headers);
    assert.equal(calls[0]!.init.method, 'DELETE');
    assert.deepEqual([headers.get('Known-Sync-Session'), headers.get('Origin'), headers.get('Authorization')],
      ['session-stored', 'chrome-extension://x', 'Bearer token']);
    assert.match(headers.get('Idempotency-Key') ?? '', /^[0-9a-f-]{36}$/u);
  });

  test('a replica the server already retired is fenced; an unknown stored Session is replaced once', async () => {
    assert.equal(await fenceReplicaOnServer(make([410]).deps), 'already_retired');
    const retry = make([404, 204]);
    assert.equal(await fenceReplicaOnServer(retry.deps), 'fenced');
    assert.deepEqual(calls.map(call => new Headers(call.init.headers).get('Known-Sync-Session')), ['session-stored', 'session-fresh']);
    assert.equal(retry.refreshes(), 1);
    assert.equal(await reason(make([404, 404]).deps), 'fence_refused');
    assert.equal(await fenceReplicaOnServer(make([], { authority: async () => { throw Object.assign(new Error('replica_retired'), { code: 'replica_retired' }); } }).deps), 'already_retired');
  });

  test('every other failure is a named reason', async () => {
    assert.equal(await reason(make([401]).deps), 'fence_unauthorized');
    assert.equal(await reason(make([429]).deps), 'rate_limited');
    assert.equal(await reason(make([503]).deps), 'server_unavailable');
    assert.equal(await reason(make([400]).deps), 'fence_refused');
    assert.equal(await reason(make([], { fetch: async () => { throw new TypeError('Failed to fetch'); } }).deps), 'offline');
    assert.equal(await reason(make([], { authority: async () => { throw new TypeError('Failed to fetch'); } }).deps), 'offline');
    assert.equal(await reason(make([], { authority: async () => { throw new Error('session_expired'); } }).deps), 'fence_session_unavailable');
    assert.equal(await reason(make([], { endpoint: async () => { throw new TypeError('Failed to fetch'); } }).deps), 'offline');
  });
});

describe('archives of one scope', () => {
  test('exportArchive returns the newest, so an older retirement cannot hide the reset that just ran', async () => {
    const f = await setup();
    try {
      await f.store.retireScope(f.scope, { retiredAt: 100, reason: 'authority_fenced' });
      const first = await f.store.exportArchive(f.scope);
      const db = await f.store.open();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('retired_archives', 'readwrite');
        tx.objectStore('retired_archives').put({ ...first, retiredAt: 200, reason: 'user_replica_rebuild' });
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
      });
      assert.equal((await f.store.exportArchive(f.scope)).reason, 'user_replica_rebuild');
    } finally { f.store.close(); }
  });
});

describe('identity hints for the advanced first run (RB-07)', () => {
  test('a hint is kept only when both sides still have the node as the same kind, without a collision', () => {
    const stored = [{ nativeId: 'n-kept', colpId: 'c-kept' }];
    const hints = [
      { nativeId: 'n-1', colpId: 'c-1' },        // both sides, same kind: kept
      { nativeId: 'n-gone', colpId: 'c-2' },      // the browser node no longer exists
      { nativeId: 'n-3', colpId: 'c-gone' },      // the server node no longer exists
      { nativeId: 'n-4', colpId: 'c-4' },         // kind changed
      { nativeId: 'n-kept', colpId: 'c-5' },      // collides with a pairing the new replica already has
      { nativeId: 'n-6', colpId: 'c-kept' },
      { nativeId: 'n-7', colpId: 'root' }];       // the library root is never paired by a hint
    const local = ['n-1', 'n-3', 'n-4', 'n-kept', 'n-6', 'n-7'].map(nativeId => ({ nativeId, kind: nativeId === 'n-4' ? 'folder' : 'bookmark' }));
    const remote = ['c-1', 'c-2', 'c-4', 'c-5', 'c-kept', 'root'].map(nodeId => ({ nodeId, kind: 'bookmark' }));
    assert.deepEqual(withRebuildIdentityHints(stored, hints, local, remote, 'root'),
      [{ nativeId: 'n-kept', colpId: 'c-kept' }, { nativeId: 'n-1', colpId: 'c-1' }]);
  });
});

test('unreadable diagnostics and a failed preview export still reset through a fence without losing the queue', async () => {
  const f = await setup(); let fenced = 0;
  try {
    const store = { ...f.store,
      getEngineState: async () => { throw new Error('corruption_detected'); },
      exportScope: async () => { throw new Error('corruption_detected'); },
    } as typeof f.store;
    const rebuilder = rebuilderWith(f, { store, fence: async () => { fenced++; return 'fenced'; } });
    const preview = await rebuilder.handle({ kind: 'known.scope.rebuild.preview' });
    assert.ok(preview.ok && 'preview' in preview);
    assert.equal(preview.preview.mode, 'server_fenced');
    assert.equal(preview.preview.revision, 0);
    assert.equal(preview.preview.queuedOperations, 0, 'unreadable preview counts do not replace the raw archive');
    assert.deepEqual(await confirm(rebuilder), { ok: true, result: 'setup_required' });
    assert.equal(fenced, 1);
    const archive = await f.store.exportArchive(f.scope);
    assert.ok((archive.queue as { opId: string }[]).some(row => row.opId === 'queued'));
    assert.equal(f.registrations, 1);
  } finally { f.store.close(); }
});
