import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test, vi } from 'vitest';
import { RUNTIME_ORIGIN_KEY } from '../src/config.js';
import { enqueueAuditEdit, scopeAuditFixture } from './sw-scope-audit-fixture.js';

test('configuration reads current managed and user origins while caching only the packaged build', async () => {
  const f = await scopeAuditFixture(false);
  assert.equal((await f.api.loadConfig()).serverOrigin, 'https://known.example');
  await f.local.set({ [RUNTIME_ORIGIN_KEY]: 'https://personal.example' });
  assert.equal((await f.api.loadConfig()).serverOrigin, 'https://personal.example');
  await f.managed.set({ serverOrigin: 'https://organization.example' });
  const managed = await f.api.loadConfig();
  assert.equal(managed.serverOrigin, 'https://organization.example');
  assert.equal(new URL(managed.manifestUrl).origin, managed.serverOrigin);
  await f.managed.remove('serverOrigin');
  assert.equal((await f.api.loadConfig()).serverOrigin, 'https://personal.example');
  await f.local.remove(RUNTIME_ORIGIN_KEY);
  assert.equal((await f.api.loadConfig()).serverOrigin, 'https://known.example');
  assert.equal(f.calls('/generated-config.json').length, 1);
});

test('unavailable storage retains the pinned build and a failed packaged response cannot become configuration', async () => {
  const f = await scopeAuditFixture(false);
  vi.spyOn(f.managed, 'get').mockRejectedValue(new Error('storage_unavailable'));
  const get = f.local.get.bind(f.local);
  vi.spyOn(f.local, 'get').mockImplementation(keys => keys === RUNTIME_ORIGIN_KEY
    ? Promise.reject(new Error('storage_unavailable')) : get(keys));
  assert.equal((await f.api.loadConfig()).serverOrigin, f.build.serverOrigin);
  f.sw.configPromise = undefined; // a new worker retries the packaged resource
  f.handleHTTP(async url => url.endsWith('/generated-config.json') ? new Response(null, { status: 503 }) : undefined);
  await assert.rejects(f.api.loadConfig(), /configuration_unavailable/u);
  assert.equal(f.calls('/generated-config.json').length, 2);
});

for (const origin of ['http://127.0.0.1:38217', null] as const) {
  test(`only an e2e build consumes its packaged ${origin ? 'origin override' : 'absent origin file'}`, async () => {
    const f = await scopeAuditFixture(false);
    const build = JSON.parse(await readFile('config/e2e-fixture.json', 'utf8'));
    f.handleHTTP(async url => {
      if (url.endsWith('/generated-config.json')) return Response.json(build);
      if (url.includes('/e2e-origin.json?')) return origin ? Response.json({ origin }) : new Response(null, { status: 404 });
      return undefined;
    });
    assert.equal((await f.api.loadConfig()).serverOrigin, origin ?? build.serverOrigin);
    assert.equal(f.network.mock.calls.filter(([url]) => String(url).includes('/e2e-origin.json?')).length, 1);
  });
}

test('managed sign-in policy blocks account use but still permits the user to sign out', async () => {
  const f = await scopeAuditFixture(false);
  await f.managed.set({ identityDisabled: true });
  await assert.rejects(f.api.enforceManagedPolicy(f.build, 'known.auth.status'), /policy_blocked/u);
  await f.api.enforceManagedPolicy(f.build, 'known.auth.logout');
  await f.managed.set({ identityDisabled: 'invalid' });
  await assert.rejects(f.api.enforceManagedPolicy(f.build, 'known.auth.status'), /managed_configuration_conflict/u);
  await f.managed.remove('identityDisabled');
  await f.api.enforceManagedPolicy(f.build, 'known.auth.status');
  assert.equal(f.network.mock.calls.length, 0);
});

for (const [error, status] of [[new TypeError('Failed to fetch'), 'offline'], [new Error('policy_blocked'), 'policy_blocked'],
  [new Error('managed_configuration_conflict'), 'policy_blocked'], [new Error('session_invalid'), 'error']] as const) {
  test(`failure status exposes ${error.message} without changing current account authority`, async () => {
    const f = await scopeAuditFixture(false);
    const state = await f.api.stateAfterFailure(error);
    assert.equal(state.status, status);
    assert.equal(state.serverOrigin, f.build.serverOrigin);
    assert.deepEqual(await f.store.loadCredential(), f.credential);
    assert.equal(await f.store.loadSession(), null);
  });
}

test('real Session admission is reused offline by scope and status readers', async () => {
  const f = await scopeAuditFixture();
  const session = await f.store.loadSession(); assert.ok(session);
  f.network.mockClear();
  f.handleHTTP(async () => { throw new TypeError('Failed to fetch'); });
  assert.deepEqual(await f.api.requireSyncScope(), f.scope);
  const current = await f.api.currentSyncStatusAuthority();
  assert.deepEqual(current.scope, f.scope); assert.deepEqual(current.session, session);
  assert.deepEqual((await f.api.pushSessionAuthority()).session, session);
  assert.equal(f.network.mock.calls.length, 0);
  assert.equal((await f.syncState.getScope(f.scope))?.lease?.leaseId, session.replicaLease.leaseId);
});

for (const missing of ['credential', 'collection'] as const) {
  test(`explicit scope hydration with no ${missing} cannot mint a Session`, async () => {
    const f = await scopeAuditFixture(false);
    if (missing === 'credential') await f.store.clearCredential();
    else await f.local.set({ [f.COLLECTION_BINDING]: 'bad/id' });
    await assert.rejects(f.api.requireSyncScope(), missing === 'credential' ? /not_connected/u : /collection_required/u);
    assert.equal(f.calls('/v1/session').length, 0);
    assert.equal(await f.store.loadSession(), null);
    assert.equal(await f.syncState.getScope(f.scope), null);
  });
}

test('Session request rejects a malformed Collection and never substitutes a native root', async () => {
  const f = await scopeAuditFixture(false);
  await f.local.set({ [f.COLLECTION_BINDING]: 'bad/id' });
  await assert.rejects(f.api.sessionRequest(0), /collection_required/u);
  await assert.rejects(f.api.currentSyncScope({ allowUnregistered: true }), /not_connected/u);
  await f.local.set({ [f.COLLECTION_BINDING]: f.scope.collectionId });
  await f.store.clearCredential();
  const request = await f.api.sessionRequest(0);
  assert.deepEqual(request.replica.binding, { browserProfileId: f.binding.browserProfileId,
    generation: f.binding.generation, mountMode: 'whole-profile', mountNativeId: null });
  assert.equal(request.collection.bootstrapMode, 'merge');
  assert.equal(await f.syncState.getScope(f.scope), null);
});

test('a rate-limited renewal retains valid authority, avoids another POST and rejects an explicit refresh', async () => {
  const f = await scopeAuditFixture();
  const prior = await f.store.loadSession(); assert.ok(prior);
  const nearExpiry = { ...prior, expiresAt: new Date(Date.now() + 45_000).toISOString() };
  await f.store.saveSession(nearExpiry);
  f.network.mockClear();
  f.handleHTTP(async url => url === `${f.build.serverOrigin}/v1/session`
    ? Response.json({ code: 'rate_limited', retryAfterSeconds: 10 }, { status: 429, headers: { 'Retry-After': '10' } }) : undefined);
  await assert.rejects(f.api.pushSessionAuthority(), /rate_limited/u);
  assert.equal(f.calls('/v1/session').length, 1);
  assert.ok(f.sw.sessionRetryNotBefore > Date.now());
  assert.deepEqual(await f.store.loadSession(), nearExpiry);
  assert.deepEqual((await f.api.pushSessionAuthority()).session, nearExpiry);
  await assert.rejects(f.api.pushSessionAuthority(true), /rate_limited/u);
  assert.equal(f.calls('/v1/session').length, 1, 'no second mint during the negotiated Retry-After');
  assert.deepEqual(await f.store.loadSession(), nearExpiry);
});

test('rate limiting cannot grant a Session whose lease expires before the retry deadline', async () => {
  const f = await scopeAuditFixture();
  const prior = await f.store.loadSession(); assert.ok(prior);
  await f.store.saveSession({ ...prior, replicaLease: { ...prior.replicaLease,
    expiresAt: new Date(Date.now() + 1_000).toISOString() } });
  f.sw.sessionRetryNotBefore = Date.now() + 60_000;
  f.network.mockClear();
  await assert.rejects(f.api.pushSessionAuthority(), /rate_limited/u);
  assert.equal(f.calls('/v1/session').length, 0);
  assert.equal((await f.store.loadSession())?.sessionId, prior.sessionId, 'failure does not invent a replacement');
});

test('one stale-replica response retries through the same real Session lane and persists the new lease', async () => {
  const f = await scopeAuditFixture();
  const prior = await f.store.loadSession(); assert.ok(prior);
  await f.store.saveSession({ ...prior, expiresAt: new Date(Date.now() + 45_000).toISOString() });
  let refused = false;
  f.network.mockClear();
  f.handleHTTP(async url => {
    if (url === `${f.build.serverOrigin}/v1/session` && !refused) { refused = true; return Response.json({ code: 'stale_replica' }, { status: 409 }); }
    return undefined;
  });
  const fresh = await f.api.pushSessionAuthority();
  assert.equal(f.calls('/v1/session').length, 2);
  assert.notEqual(fresh.session.sessionId, prior.sessionId);
  assert.deepEqual(await f.store.loadSession(), fresh.session);
  assert.equal((await f.syncState.getScope(f.scope))?.lease?.leaseId, fresh.session.replicaLease.leaseId);
  assert.deepEqual(await f.api.currentSyncScope(), f.scope);
});

test('coalesced background freshening performs one Session mint and releases its work lane', async () => {
  const f = await scopeAuditFixture(false);
  f.api.scheduleSessionFreshen(); f.api.scheduleSessionFreshen();
  assert.equal(f.sw.sessionFreshenQueued, true);
  await f.workCoordinator.drain();
  assert.equal(f.calls('/v1/session').length, 1);
  assert.deepEqual(await f.api.currentSyncScope(), f.scope);
  assert.equal(f.sw.sessionFreshenQueued, false);
  assert.ok(await f.store.loadSession());
});

test('legacy remount refuses pending edits, and explicit abandonment archives their exact body before rotation', async () => {
  const f = await scopeAuditFixture();
  const pending = await enqueueAuditEdit(f);
  await assert.rejects(f.api.retireLegacyScopeForRemount(), /queue_not_drained/u);
  assert.deepEqual(await f.store.loadBinding(), f.binding);
  assert.deepEqual(await f.syncState.listQueue(f.scope), [pending]);
  const remounted = await f.api.retireLegacyScopeForRemount({ abandonQueue: true });
  assert.equal(remounted.retired, true);
  assert.equal(remounted.binding.browserProfileId, f.binding.browserProfileId);
  assert.equal(Number(remounted.binding.generation), f.scope.generation + 1);
  assert.deepEqual((await f.syncState.exportArchive(f.scope)).queue, [pending]);
  assert.equal(f.sw.bindingPromise, undefined);
});

test('a drained legacy remount needs no abandonment and never sends a queued operation', async () => {
  const f = await scopeAuditFixture();
  f.network.mockClear();
  const result = await f.api.retireLegacyScopeForRemount();
  assert.equal(result.retired, true);
  assert.deepEqual((await f.syncState.exportArchive(f.scope)).queue, []);
  assert.equal(f.network.mock.calls.length, 0);
});
