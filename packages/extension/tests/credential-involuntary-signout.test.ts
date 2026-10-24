import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { createAuthController } from '../src/auth-controller.js';
import { MemoryStorageArea, createCredentialStore } from '../src/credential-store.js';
import { EXTENSION_ORIGIN, NOW, config, fixtureController, fixtureCredential, fixtureSession, memoryCookies,
  sessionJson, setCookieResponse } from './auth-shell-fixture.js';

/**
 * W2B-P1-1 / W2B-P1-3: the replica binding belongs to one account on one server. An involuntary sign-out (the server
 * no longer knows the credential) drops the secrets and keeps the replica, so signing in again resumes the same
 * scope instead of starting a new replica and a new first-run merge. A different account (or server) never
 * inherits the binding, even when no credential was in memory (a browser restart empties the secret area).
 */
const PASSWORD = { method: 'password', email: 'p3-27-extension@example.test', password: 'fixture-password' } as const;

async function signedInStore() {
  const store = createCredentialStore(new MemoryStorageArea(), () => NOW);
  const live = await store.fence.activate();
  await store.saveCredential({ ...fixtureCredential(config(), NOW), expiresAt: NOW + 30_000 }, live.generation);
  await store.saveSession(fixtureSession(NOW), live.generation);
  const binding = await store.getOrCreateBinding(live.generation);
  return { store, binding };
}

/** A sign-in that succeeds for `accountId` (the shared fixture always answers for its one fixture user). */
function loginAs(store: ReturnType<typeof createCredentialStore>, accountId: string) {
  return createAuthController({ config: config(), store, now: () => NOW, origin: EXTENSION_ORIGIN, cookies: memoryCookies(),
    fetch: async (url) => String(url).endsWith('/sign-in/email') ? setCookieResponse({})
      : String(url).endsWith('/get-session') ? Response.json(sessionJson(NOW, accountId))
        : new Response(null, { status: 404 }) });
}

describe('W2B-P1-1 involuntary sign-out keeps the replica', () => {
  for (const refresh of ['authentication_required', 'missing_session'] as const) {
    test(`the server answering ${refresh} drops the secrets and keeps the binding and the account pin`, async () => {
      const { store, binding } = await signedInStore();
      await assert.rejects(
        () => fixtureController({ config: config(), store, now: () => NOW, refresh }).ensureFreshCredential(true),
        /authentication_required/u);
      assert.equal(await store.loadCredential(), null);
      assert.equal(await store.loadSession(), null);
      assert.deepEqual(await store.loadBinding(), binding, 'the replica identity survives');
      assert.equal(await store.loadSignOutReason(), 'authentication_required');
      assert.equal((await store.loadExpectedIdentity())?.subject, 'auth-user-fixture');
    });
  }

  test('signing in again after it resumes the same replica', async () => {
    const { store, binding } = await signedInStore();
    await assert.rejects(
      () => fixtureController({ config: config(), store, now: () => NOW, refresh: 'authentication_required' })
        .ensureFreshCredential(true), /authentication_required/u);
    const outcome = await fixtureController({ config: config(), store, now: () => NOW }).login(PASSWORD);
    assert.equal(outcome.status, 'connected');
    const next = await store.getOrCreateBinding((await store.fence.read()).generation);
    assert.equal(next.replicaId, binding.replicaId, 'the same replica, so the same scope and queue');
    assert.equal(next.browserProfileId, binding.browserProfileId);
    assert.equal(await store.loadSignOutReason(), null);
  });

  test('an explicit sign-out still removes the replica binding and the pin', async () => {
    const { store } = await signedInStore();
    await fixtureController({ config: config(), store, now: () => NOW }).logout();
    assert.equal(await store.loadBinding(), null);
    assert.equal(await store.loadExpectedIdentity(), null);
  });
});

describe('W2B-P1-3 a replica belongs to one account and one server', () => {
  test('a different account signing in after a restart gets its own replica', async () => {
    const { store, binding } = await signedInStore();
    await store.clearCredential(); // what a browser restart does to the secret area
    assert.equal((await loginAs(store, 'account-b').login(PASSWORD)).status, 'connected');
    const next = await store.getOrCreateBinding((await store.fence.read()).generation);
    assert.notEqual(next.replicaId, binding.replicaId, 'account B must not inherit the previous account\'s replica id');
    assert.equal(next.browserProfileId, binding.browserProfileId, 'the browser profile id is per profile, not per account');
    assert.equal((await store.loadExpectedIdentity())?.subject, 'account-b');
  });

  test('a different account after an involuntary sign-out gets its own replica', async () => {
    const { store, binding } = await signedInStore();
    await assert.rejects(
      () => fixtureController({ config: config(), store, now: () => NOW, refresh: 'authentication_required' })
        .ensureFreshCredential(true), /authentication_required/u);
    assert.equal((await loginAs(store, 'account-b').login(PASSWORD)).status, 'connected');
    const next = await store.getOrCreateBinding((await store.fence.read()).generation);
    assert.notEqual(next.replicaId, binding.replicaId);
  });

  test('the same account signing in after a restart keeps its replica', async () => {
    const { store, binding } = await signedInStore();
    await store.clearCredential();
    assert.equal((await loginAs(store, 'auth-user-fixture').login(PASSWORD)).status, 'connected');
    assert.equal((await store.getOrCreateBinding((await store.fence.read()).generation)).replicaId, binding.replicaId);
  });

  test('the same account on another server does not inherit the replica either', async () => {
    const { store, binding } = await signedInStore();
    await store.clearCredential();
    const live = await store.fence.activate();
    await store.saveCredential({ ...fixtureCredential(config(), NOW), serverOrigin: 'https://other.example' }, live.generation);
    const next = await store.getOrCreateBinding(live.generation);
    assert.notEqual(next.replicaId, binding.replicaId);
  });

  test('a refresh of the same credential keeps the replica and the Session', async () => {
    const { store, binding } = await signedInStore();
    const controller = fixtureController({ config: config(), store, now: () => NOW });
    await controller.ensureFreshCredential(true);
    assert.deepEqual(await store.loadBinding(), binding);
    assert.equal((await store.loadSession())?.sessionId, 'session-fixture');
  });
});
