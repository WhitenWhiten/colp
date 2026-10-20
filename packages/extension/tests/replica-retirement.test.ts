import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { createReplicaRebuilder, pendingRebuildBlocksSession, REPLICA_REBUILD_JOURNAL } from '../src/replica-rebuild.js';
import { readReplicaRepairCapability } from '../src/replica-repair-capability.js';
import { handleSyncAttentionRequest } from '../src/sw/sync-attention.js';
import { setupRetirement } from './replica-retirement-harness.js';
import type { ReplicaRetirementIntent } from '../src/replica-retirement.js';

const fixtures: Awaited<ReturnType<typeof setupRetirement>>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
async function setup(reauthorization = true) { const f = await setupRetirement(reauthorization); fixtures.push(f); return f; }
async function intent(f: Awaited<ReturnType<typeof setup>>) {
  return (await f.journal.get(REPLICA_REBUILD_JOURNAL))[REPLICA_REBUILD_JOURNAL] as {
    retirement: { sessionId: string; idempotencyKey: string; confirmed?: true; reauthorization?: true } };
}

test('explicit reset retires the server before preserving unknown bytes and opening an unselected merge scope', async () => {
  const f = await setup();
  assert.equal((await readReplicaRepairCapability(f.store, f.scope)).reason, 'upload_outcome_unsettled');
  const preview = await f.rebuilder.handle({ kind: 'known.scope.rebuild.preview' });
  assert.ok(preview.ok && 'preview' in preview); assert.equal(preview.preview.retirementRequired, true);
  assert.equal(f.requests.length, 0);
  const attention = await handleSyncAttentionRequest({ scope: f.currentScope, store: f.store, serverRetirement: true });
  assert.ok(attention.ok); assert.equal(attention.attention.rebuildAvailable, true);
  f.setResponse(async init => {
    assert.equal((await intent(f)).retirement.confirmed, undefined);
    assert.deepEqual(await f.store.listQueue(f.scope), f.original);
    assert.deepEqual(await f.credentials.loadBinding(), f.binding);
    assert.equal(init.body, undefined); assert.equal(init.method, 'DELETE');
    assert.equal(new Headers(init.headers).get('Known-Sync-Replica-Proof'), f.session.sessionId);
    return new Response(null, { status: 204 });
  });
  assert.deepEqual(await f.rebuilder.handle(await f.request()), { ok: true, result: 'setup_required' });
  const archived = await f.store.exportArchive(f.scope);
  assert.deepEqual(archived.queue, f.original); assert.deepEqual(archived.receipts, []);
  assert.equal(archived.reason, 'user_replica_rebuild'); assert.equal(await f.store.getScope(f.scope), null);
  const next = await f.currentScope(); assert.notEqual(next.replicaId, f.scope.replicaId);
  assert.equal(next.browserProfileId, f.scope.browserProfileId);
  assert.equal((await f.store.getScope(next))?.firstRun, 'none');
  assert.deepEqual((await f.store.getScope(next))?.selectedRoots, []);
  assert.equal((await f.policy.read(next)).mode, 'local-only'); assert.equal(f.pushCalls, 1);
  assert.equal(f.requests.length, 1); assert.equal(await f.rebuilder.resume(), false);
  assert.deepEqual(await f.journal.get(null), {});
});

for (const status of [401, 403, 404, 409, 410, 500]) {
  test(`HTTP ${status} never proves retirement or archives/rotates the original queue`, async () => {
    const f = await setup(); f.setResponse(async () => new Response(null, { status }));
    assert.deepEqual(await f.rebuilder.handle(await f.request()), { ok: false, code:
      status === 401 ? 'retirement_authentication_required' : [403, 404].includes(status)
        ? 'retirement_authority_denied' : 'retirement_pending' });
    assert.deepEqual(await f.store.listQueue(f.scope), f.original);
    assert.deepEqual(await f.credentials.loadBinding(), f.binding);
    await assert.rejects(f.store.exportArchive(f.scope), /archive_not_found/);
    assert.equal((await intent(f)).retirement.confirmed, undefined);
    assert.equal(f.pushCalls, 1);
  });
}

test('a lost response and browser-session loss replay the fixed retirement using a refreshed current credential', async () => {
  const f = await setup(); f.setResponse(async () => { throw new Error('lost_after_server_commit'); });
  assert.deepEqual(await f.rebuilder.handle(await f.request()), { ok: false, code: 'retirement_pending' });
  const pinned = (await intent(f)).retirement;
  assert.equal(await pendingRebuildBlocksSession(f.journal, f.credential, f.binding), true);
  assert.doesNotMatch(JSON.stringify(await f.journal.get(null)), /controlled-credential/);
  await f.credentials.clearCredential(); await f.credentials.clearSession();
  const restarted = createReplicaRebuilder(f.deps);
  assert.deepEqual(await restarted.pendingStatus(), { available: false, reason: 'rebuild_authentication_required' });
  f.setResponse(async () => new Response(null, { status: 204 }));
  assert.equal(await restarted.resume(), true);
  assert.equal(f.restorations, 1); assert.equal(f.authorityCalls, 0);
  for (const request of f.requests) {
    const headers = new Headers(request.init.headers);
    assert.equal(headers.get('Known-Sync-Session'), pinned.sessionId);
    assert.equal(headers.get('Known-Sync-Replica-Proof'), pinned.sessionId);
    assert.equal(headers.get('Idempotency-Key'), pinned.idempotencyKey);
    assert.equal(request.init.body, undefined);
  }
  assert.notEqual(new Headers(f.requests[0]!.init.headers).get('Authorization'),
    new Headers(f.requests[1]!.init.headers).get('Authorization'));
  assert.deepEqual((await f.store.exportArchive(f.scope)).queue, f.original);
  assert.equal(f.pushCalls, 1);
});

test('a new login requires fresh explicit confirmation and retains the old target after active binding cleanup', async () => {
  const f = await setup(); f.setResponse(async () => { throw new Error('offline'); });
  const oldRequest = await f.request(); await f.rebuilder.handle(oldRequest); const pinned = (await intent(f)).retirement;
  await f.credentials.revokeAuthority(); await f.credentials.clearAuthority();
  await f.credentials.activateAuthority();
  await f.credentials.saveCredential({ ...f.credential, accessToken: 'controlled-new-login' });
  await assert.rejects(createReplicaRebuilder(f.deps).resume(), /rebuild_authentication_required/);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(await f.rebuilder.handle(oldRequest), { ok: false, code: 'stale_ref' });
  f.setResponse(async () => new Response(null, { status: 204 }));
  assert.deepEqual(await f.rebuilder.handle(await f.request()), { ok: true, result: 'setup_required' });
  assert.equal(new Headers(f.requests[1]!.init.headers).get('Known-Sync-Session'), pinned.sessionId);
  assert.equal(new Headers(f.requests[1]!.init.headers).get('Idempotency-Key'), pinned.idempotencyKey);
  assert.equal(f.authorityCalls, 0); assert.equal(f.pushCalls, 1);
});

test('another account cannot discard or overwrite an unconfirmed retirement and its normal Session lane is not blocked', async () => {
  const f = await setup(); f.setResponse(async () => { throw new Error('offline'); });
  await f.rebuilder.handle(await f.request()); const retained = await f.journal.get(null);
  await f.credentials.activateAuthority();
  const other = { ...f.credential, subject: 'other-account' }; await f.credentials.saveCredential(other);
  assert.equal(await f.rebuilder.pendingStatus(), false);
  assert.equal(await pendingRebuildBlocksSession(f.journal, other, f.binding), false);
  assert.equal(await f.rebuilder.resume(), false);
  assert.deepEqual(await f.rebuilder.handle({ kind: 'known.scope.rebuild.preview' }),
    { ok: false, code: 'rebuild_other_account_pending' });
  assert.deepEqual(await f.journal.get(null), retained); assert.equal(f.requests.length, 1);
  assert.deepEqual(await f.store.listQueue(f.scope), f.original);
});

test('a first reset after browser-session loss uses the durable scoped proof without opening an old-replica Session', async () => {
  const f = await setup(); await f.credentials.clearSession();
  assert.deepEqual(await f.rebuilder.handle(await f.request()), { ok: true, result: 'setup_required' });
  assert.equal(f.authorityCalls, 0);
  assert.equal(new Headers(f.requests[0]!.init.headers).get('Known-Sync-Replica-Proof'), f.session.sessionId);
  assert.deepEqual((await f.store.exportArchive(f.scope)).queue, f.original);
});

test('malformed durable retirement authority cannot reach HTTP or authorize local archive', async () => {
  const f = await setup(); const generation = (await f.credentials.fence.capture()).generation;
  const valid = await f.transport.prepare(f.scope, generation);
  for (const patch of [{ endpoint: 'not a URL' }, { endpoint: 'https://other.example/retire' },
    { endpoint: 'https://user:password@known.example/retire' }, { endpoint: 'https://known.example/retire?other=1' },
    { endpoint: 'https://known.example/retire#fragment' }, { sessionId: 'invalid header\r\n' },
    { idempotencyKey: '' }, { origin: 'chrome-extension://other' }, { reauthorization: false },
    { confirmed: false }, { version: 2 }, { accessToken: 'must-never-be-journaled' }]) {
    await assert.rejects(f.transport.confirm(f.scope, { ...valid, ...patch } as unknown as ReplicaRetirementIntent,
      generation), /retirement_invalid/);
  }
  assert.equal(f.requests.length, 0); assert.deepEqual(await f.store.listQueue(f.scope), f.original);
  assert.deepEqual(await f.credentials.loadBinding(), f.binding);
});

test('a live credential for another account cannot execute the prepared retirement', async () => {
  const f = await setup(); const generation = (await f.credentials.fence.capture()).generation;
  const pinned = await f.transport.prepare(f.scope, generation);
  await f.credentials.saveCredential({ ...f.credential, subject: 'other-account' });
  await assert.rejects(f.transport.confirm(f.scope, pinned, generation), /stale_ref/);
  assert.equal(f.requests.length, 0); assert.deepEqual(await f.store.listQueue(f.scope), f.original);
});

test('a local issue with no attempted upload remains repairable without manufacturing server retirement', async () => {
  const f = await setup();
  // Complete the first reset, then raise an independent local identity issue
  // in the clean scope. Reset must remain available even with no Push history.
  await f.rebuilder.handle(await f.request()); const scope = await f.currentScope();
  await f.store.recordLocalIssue(scope, { nativeId: 'local-unproven', code: 'deletion_identity_unproven', now: Date.now() });
  const capability = await readReplicaRepairCapability(f.store, scope);
  assert.equal(capability.rebuildAvailable, true); assert.equal(capability.retirementRequired, false);
  assert.equal(capability.queuedOperations, 0); assert.equal(f.requests.length, 1);
});

test('an older server gets no proof header; explicit rediscovery can recover after it advertises v2', async () => {
  const f = await setup(false); f.setResponse(async () => new Response(null, { status: 404 }));
  assert.deepEqual(await f.rebuilder.handle(await f.request()), { ok: false, code: 'retirement_legacy_authority_required' });
  const pinned = (await intent(f)).retirement;
  assert.equal(new Headers(f.requests[0]!.init.headers).has('Known-Sync-Replica-Proof'), false);
  f.setEndpoint({ href: f.requests[0]!.url, reauthorization: true });
  f.setResponse(async () => new Response(null, { status: 204 }));
  assert.deepEqual(await f.rebuilder.handle(await f.request()), { ok: true, result: 'setup_required' });
  assert.equal(new Headers(f.requests[1]!.init.headers).get('Known-Sync-Replica-Proof'), pinned.sessionId);
  assert.equal(new Headers(f.requests[1]!.init.headers).get('Idempotency-Key'), pinned.idempotencyKey);
});
