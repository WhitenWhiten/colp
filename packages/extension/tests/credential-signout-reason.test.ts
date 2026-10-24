import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { authErrorCopy } from '../src/auth-error-copy.js';
import { createAuthController } from '../src/auth-controller.js';
import { MemoryStorageArea, createCredentialStore } from '../src/credential-store.js';
import type { PublicAuthState } from '../src/types.js';
import { EXTENSION_ORIGIN, NOW, config, fixtureCredential, fixtureSession, memoryCookies } from './auth-shell-fixture.js';

/**
 * W2B-P2-7 / P3-5: why a sign-in ended is told apart ("expired" is not "revoked"), a configuration change no longer
 * throws the replica away with the credential, and the surface that paints from the last snapshot is told at once.
 */
async function storeWith(expiresAt: number) {
  const store = createCredentialStore(new MemoryStorageArea(), () => NOW);
  const live = await store.fence.activate();
  await store.saveCredential({ ...fixtureCredential(config(), NOW), expiresAt }, live.generation);
  await store.saveSession(fixtureSession(NOW), live.generation);
  return { store, binding: await store.getOrCreateBinding(live.generation) };
}

function controllerRefusing(store: ReturnType<typeof createCredentialStore>, onSignedOut?: (state: PublicAuthState) => void) {
  return createAuthController({ config: config(), store, now: () => NOW, origin: EXTENSION_ORIGIN, cookies: memoryCookies(),
    fetch: async () => new Response(null, { status: 401 }), ...(onSignedOut ? { onSignedOut } : {}) });
}

describe('the reason a sign-in ended', () => {
  test('a credential past its lifetime that the server no longer knows is expired', async () => {
    const { store } = await storeWith(NOW - 60_000);
    await assert.rejects(() => controllerRefusing(store).ensureFreshCredential(), /authentication_required/u);
    assert.equal(await store.loadSignOutReason(), 'session_expired');
    const status = await controllerRefusing(store).status();
    assert.deepEqual([status.status, status.errorCode], ['signed_out', 'session_expired']);
  });

  test('a credential inside its lifetime that the server refuses is revoked', async () => {
    const { store } = await storeWith(NOW + 3_600_000);
    await assert.rejects(() => controllerRefusing(store).ensureFreshCredential(true), /authentication_required/u);
    assert.equal(await store.loadSignOutReason(), 'authentication_required');
  });

  test('each reason has its own plain sentence', () => {
    assert.equal(authErrorCopy('session_expired'), 'Your session expired. Sign in again.');
    assert.equal(authErrorCopy('authentication_required'), 'Your access was revoked. Sign in again.');
    assert.match(authErrorCopy('server_unavailable'), /could not answer/u);
  });
});

describe('the snapshot the popup paints from', () => {
  test('is told when the server ended the sign-in, with the reason', async () => {
    const { store } = await storeWith(NOW + 3_600_000);
    const told: PublicAuthState[] = [];
    await assert.rejects(() => controllerRefusing(store, (state) => told.push(state)).ensureFreshCredential(true));
    assert.equal(told.length, 1);
    assert.deepEqual([told[0]?.status, told[0]?.errorCode], ['signed_out', 'authentication_required']);
  });

  test('is not told about a check that could not be made', async () => {
    const { store } = await storeWith(NOW + 3_600_000);
    const told: PublicAuthState[] = [];
    const offline = createAuthController({ config: config(), store, now: () => NOW, origin: EXTENSION_ORIGIN,
      cookies: memoryCookies(), fetch: async () => { throw new TypeError('Failed to fetch'); }, onSignedOut: (state) => told.push(state) });
    await assert.rejects(() => offline.ensureFreshCredential(true), /offline/u);
    assert.deepEqual(told, []);
  });
});

describe('a configuration change under a stored credential', () => {
  test('signs out but keeps the replica and the account pin, so the same account resumes it', async () => {
    const { store, binding } = await storeWith(NOW + 3_600_000);
    const drifted = createAuthController({ config: { ...config(), clientId: 'a-different-client' }, store, now: () => NOW,
      origin: EXTENSION_ORIGIN, cookies: memoryCookies(), fetch: async () => new Response(null, { status: 404 }) });
    const first = await drifted.status();
    assert.deepEqual([first.status, first.errorCode], ['error', 'binding_mismatch']);
    assert.equal(await store.loadCredential(), null);
    assert.equal(await store.loadSession(), null);
    assert.deepEqual(await store.loadBinding(), binding, 'the replica survives a configuration change');
    assert.equal((await store.loadExpectedIdentity())?.subject, 'auth-user-fixture');
    const second = await drifted.status();
    assert.deepEqual([second.status, second.errorCode], ['signed_out', 'binding_mismatch']);
  });
});
