import assert from 'node:assert/strict';
import { IDBObjectStore } from 'fake-indexeddb';
import { test, vi } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { REPLICA_REBUILD_JOURNAL } from '../src/replica-rebuild.js';
import { scopeKey } from '../src/sync-state/scope-key.js';
import { STORES } from '../src/sync-state/schema.js';
import { enqueueAuditEdit, scopeAuditFixture } from './sw-scope-audit-fixture.js';

async function uncertainMetadataUpload() {
  const f = await scopeAuditFixture();
  await enqueueAuditEdit(f, true);
  const { createOutboundPushWorker } = await import('../src/outbound-push-worker.js');
  const { createSyncEffectAuthority } = await import('../src/sync-effect-authority.js');
  const { createMetadataSyncPolicyStore } = await import('../src/metadata-sync-policy.js');
  const { fetchSyncEndpoints } = await import('../src/manifest-client.js');
  const policy = createMetadataSyncPolicyStore(new MemoryStorageArea());
  await policy.write(f.scope, true);
  const context = await f.store.fence.capture();
  // Every native method is an external failure port: rebuilding this upload
  // must not mutate any bookmark. Transport still uses the real effect gate.
  const forbidden = async (): Promise<never> => { throw new Error('unexpected native mutation'); };
  const effects = createSyncEffectAuthority({ context, scope: f.scope,
    assertWritable: f.store.assertWritable, currentScope: f.api.currentSyncScope,
    api: { get: forbidden, getChildren: forbidden, create: forbidden, update: forbidden,
      move: forbidden, remove: forbidden, removeTree: forbidden }, metadataPolicy: policy });
  let clock = Date.now();
  f.handleHTTP(async url => {
    if (url === `${f.build.serverOrigin}/v1/push`) throw new TypeError('Failed to fetch');
    return undefined;
  });
  const worker = createOutboundPushWorker({ scope: f.scope, store: f.syncState,
    endpoints: () => fetchSyncEndpoints(f.build), sessions: { get: () => f.api.pushSessionAuthority() }, fetch: effects.fetch,
    now: () => clock, random: () => 0, ownerId: () => 'sw-rebuild-audit', schedule: () => undefined,
    allowRecoveryFrozenPush: () => true });
  assert.equal((await worker.drain()).outcome, 'unknown');
  const unknown = (await f.syncState.listQueue(f.scope, 'unknown'))[0]!;
  assert.ok(unknown.attempt, 'the real send persists an uncertain immutable transport attempt');
  await policy.write(f.scope, false);
  clock = unknown.retry.notBefore;
  assert.equal((await worker.drain()).outcome, 'recovery');
  const original = await f.syncState.listQueue(f.scope);
  assert.equal(original[0]?.status, 'blocked');
  assert.deepEqual(original[0]?.attempt, unknown.attempt);
  assert.equal(f.calls('/v1/push').length, 1);
  return { ...f, original };
}

async function confirmRequest() {
  const { replicaRebuilder } = await import('../src/sw/scope-rebuild.js');
  const preview = await replicaRebuilder().handle({ kind: 'known.scope.rebuild.preview' });
  assert.ok(preview.ok && 'preview' in preview);
  const { replicaId, generation, revision, targetFence } = preview.preview;
  return { preview: preview.preview, request: { kind: 'known.scope.rebuild.confirm' as const,
    userGesture: true as const, replicaId, generation, revision, targetFence } };
}

test('the SW Reset factory retires the exact uncertain upload before archive and replacement Session admission', async () => {
  const f = await uncertainMetadataUpload();
  const prior = await f.store.loadSession(); assert.ok(prior);
  const { replicaRebuilder } = await import('../src/sw/scope-rebuild.js');
  const { preview, request } = await confirmRequest();
  assert.equal(preview.retirementRequired, true);
  assert.equal(preview.queuedOperations, 1);
  assert.equal(f.calls('/extensions/sync-retire').length, 0, 'preview does not retire or resend');
  f.handleHTTP(async (url, init) => {
    if (url !== `${f.build.serverOrigin}/extensions/sync-retire`) return undefined;
    assert.deepEqual(await f.syncState.listQueue(f.scope), f.original);
    assert.deepEqual(await f.store.loadBinding(), f.binding);
    await assert.rejects(f.syncState.exportArchive(f.scope), /archive_not_found/u);
    assert.ok((await f.local.get(REPLICA_REBUILD_JOURNAL))[REPLICA_REBUILD_JOURNAL]);
    assert.equal(init?.method, 'DELETE'); assert.equal(init?.body, undefined);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Known-Sync-Session'), prior.sessionId);
    assert.equal(headers.get('Known-Sync-Replica-Proof'), prior.sessionId);
    return new Response(null, { status: 204 });
  });
  f.sw.bookmarkEventScopeKey = 'obsolete';
  f.sw.rootViewTokens = { scopeKey: 'obsolete', viewId: 'obsolete', entries: new Map() };
  assert.deepEqual(await replicaRebuilder().handle(request), { ok: true, result: 'setup_required' });
  const next = await f.api.currentSyncScope();
  assert.notEqual(next.replicaId, f.scope.replicaId);
  assert.equal(next.browserProfileId, f.scope.browserProfileId);
  assert.equal(next.generation, 1, 'a new replica starts its own generation sequence');
  assert.deepEqual((await f.syncState.exportArchive(f.scope)).queue, f.original);
  assert.deepEqual((await f.syncState.exportArchive(f.scope)).receipts, []);
  assert.equal(await f.syncState.getScope(f.scope), null);
  assert.deepEqual((await f.syncState.getScope(next))?.selectedRoots, []);
  assert.equal((await f.syncState.getScope(next))?.firstRun, 'none');
  assert.equal(f.calls('/v1/push').length, 1, 'Reset never resends opted-out metadata');
  assert.equal(f.calls('/v1/session').length, 2, 'only the original and the new replica are admitted');
  assert.equal(f.calls('/extensions/sync-retire').length, 1);
  assert.equal(f.sw.bookmarkEventScopeKey, undefined); assert.equal(f.sw.rootViewTokens, undefined);
  assert.equal((await f.local.get(REPLICA_REBUILD_JOURNAL))[REPLICA_REBUILD_JOURNAL], undefined);
  assert.equal(await replicaRebuilder().resume(), false);
});

test('after a lost retirement response the real SW factory restores account credentials and replays the pinned DELETE', async () => {
  const f = await uncertainMetadataUpload();
  const { replicaRebuilder } = await import('../src/sw/scope-rebuild.js');
  f.handleHTTP(async url => {
    if (url.endsWith('/extensions/sync-retire')) throw new TypeError('Failed to fetch');
    return undefined;
  });
  assert.deepEqual(await replicaRebuilder().handle((await confirmRequest()).request), { ok: false, code: 'retirement_pending' });
  const journal = await f.local.get(REPLICA_REBUILD_JOURNAL);
  assert.deepEqual(await f.syncState.listQueue(f.scope), f.original);
  assert.deepEqual(await f.store.loadBinding(), f.binding);
  await f.store.clearCredential(); await f.store.clearSession();
  f.syncState.close(); // full IDB reopen; persistent Chrome identity/journal remain
  f.sw.bindingPromise = undefined;
  assert.deepEqual(await replicaRebuilder().pendingStatus(), { available: false, reason: 'rebuild_authentication_required' });
  f.handleHTTP(async () => undefined);
  assert.equal(await replicaRebuilder().resume(), true);
  const deletes = f.calls('/extensions/sync-retire'); assert.equal(deletes.length, 2);
  const first = new Headers(deletes[0]![1]?.headers), replay = new Headers(deletes[1]![1]?.headers);
  for (const key of ['Known-Sync-Session', 'Known-Sync-Replica-Proof', 'Idempotency-Key']) {
    assert.equal(first.get(key), replay.get(key));
  }
  assert.equal(f.calls('/v1/push').length, 1);
  assert.equal(f.calls('/v1/session').length, 2, 'there is no extra old-replica mint after response loss');
  assert.ok(f.calls('/api/v1/auth/get-session').length > 0, 'real cookie restoration reaches the account server');
  assert.ok(journal[REPLICA_REBUILD_JOURNAL]);
  assert.deepEqual((await f.syncState.exportArchive(f.scope)).queue, f.original);
  assert.equal((await f.local.get(REPLICA_REBUILD_JOURNAL))[REPLICA_REBUILD_JOURNAL], undefined);
});

/** Inject a disk failure after the real Session write and before its scope
 * registration. No hand-authored rebuild journal or owner replacement. */
async function crashAfterReplacementSession() {
  const f = await scopeAuditFixture();
  await f.syncState.transitionEngine(f.scope, { phase: 'recovery', recoveryFrozen: true,
    authorityRefreshRequired: true, updatedAt: Date.now(), notBefore: 0, lastError: 'payload_too_large' });
  const oldSession = await f.store.loadSession(); assert.ok(oldSession);
  const database = await f.syncState.open(); const transaction = database.transaction.bind(database);
  let failRegistration = false;
  const set = f.sessionArea.set.bind(f.sessionArea);
  const storage = vi.spyOn(f.sessionArea, 'set').mockImplementation(async items => {
    await set(items);
    const stored = items['known.auth.session.v1'] as { sessionId?: string } | undefined;
    if (stored?.sessionId && stored.sessionId !== oldSession.sessionId) failRegistration = true;
  });
  const disk = vi.spyOn(database, 'transaction').mockImplementation((names, mode, options) => {
    if (failRegistration && mode === 'readwrite' && Array.from(typeof names === 'string' ? [names] : names).includes(STORES.scopes)) {
      throw new DOMException('disk quota at scope admission', 'QuotaExceededError');
    }
    return transaction(names, mode, options);
  });
  try {
    const { replicaRebuilder } = await import('../src/sw/scope-rebuild.js');
    assert.equal((await replicaRebuilder().handle((await confirmRequest()).request)).ok, false);
    assert.equal(failRegistration, true);
  } finally { disk.mockRestore(); storage.mockRestore(); }
  const binding = await f.store.loadBinding(); assert.ok(binding);
  const next = { ...f.scope, replicaId: binding.replicaId, generation: Number(binding.generation) };
  assert.notEqual(next.replicaId, f.scope.replicaId);
  const session = await f.store.loadSession(); assert.ok(session);
  assert.notEqual(session.sessionId, oldSession.sessionId);
  assert.equal(await f.syncState.getScope(next), null);
  const archive = await f.syncState.exportArchive(f.scope);
  const journal = await f.local.get(REPLICA_REBUILD_JOURNAL); assert.ok(journal[REPLICA_REBUILD_JOURNAL]);
  f.syncState.close(); f.sw.bindingPromise = undefined;
  return { ...f, next, session, archive, journal };
}

test('restarting after Session publication registers the exact missing IDB scope without a second mint', async () => {
  const f = await crashAfterReplacementSession();
  const { replicaRebuilder } = await import('../src/sw/scope-rebuild.js');
  f.network.mockClear();
  assert.equal(await replicaRebuilder().resume(), true);
  assert.deepEqual(await f.api.currentSyncScope(), f.next);
  const registered = await f.syncState.getScope(f.next); assert.ok(registered);
  assert.equal(registered.lease.leaseId, f.session.replicaLease.leaseId);
  assert.deepEqual(registered.selectedRoots, []);
  assert.equal(registered.firstRun, 'none');
  assert.equal(f.calls('/v1/session').length, 0);
  assert.deepEqual(await f.syncState.exportArchive(f.scope), f.archive);
  assert.equal((await f.local.get(REPLICA_REBUILD_JOURNAL))[REPLICA_REBUILD_JOURNAL], undefined);
});

for (const secret of ['credential', 'session'] as const) {
  test(`a concurrent ${secret} clear during resumed scope admission preserves the rebuild journal and archive`, async () => {
    const f = await crashAfterReplacementSession();
    const { replicaRebuilder } = await import('../src/sw/scope-rebuild.js');
    let removed = false;
    const original = IDBObjectStore.prototype.get;
    const read = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key) {
      const request = original.call(this, key);
      if (!removed && this.name === STORES.scopes && key === scopeKey(f.next)) {
        request.addEventListener('success', () => {
          if (request.result !== undefined || removed) return;
          removed = true;
          // Chrome storage is an independent commit: logout/session expiry can
          // complete while the IDB scope lookup is in flight.
          void f.sessionArea.remove(`known.auth.${secret}.v1`);
        });
      }
      return request;
    });
    f.network.mockClear();
    try { await assert.rejects(replicaRebuilder().resume(), /not_connected/u); }
    finally { read.mockRestore(); }
    assert.equal(removed, true);
    assert.equal(await f.syncState.getScope(f.next), null);
    assert.deepEqual(await f.local.get(REPLICA_REBUILD_JOURNAL), f.journal);
    assert.deepEqual(await f.syncState.exportArchive(f.scope), f.archive);
    assert.equal(f.calls('/v1/session').length, 0);
    await f.store.saveCredential(f.credential); await f.store.saveSession(f.session);
    assert.equal(await replicaRebuilder().resume(), true);
    assert.ok(await f.syncState.getScope(f.next));
    assert.deepEqual(await f.syncState.exportArchive(f.scope), f.archive);
    assert.equal(f.calls('/v1/session').length, 0);
  });
}
