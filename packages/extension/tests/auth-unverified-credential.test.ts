import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { createAuthController } from '../src/auth-controller.js';
import { SESSION_COOKIE_NAME } from '../src/auth-client.js';
import { MemoryStorageArea, createCredentialStore } from '../src/credential-store.js';
import { COOKIE_VALUE, EXTENSION_ORIGIN, NOW, config, fixtureController, fixtureCredential, fixtureSession,
  memoryCookies, sessionJson, setCookieResponse } from './auth-shell-fixture.js';

/**
 * "Could not ask" is not "signed out" (W2B-P2-2, P2-4, P2-5): a server or network that cannot be asked about the
 * credential says nothing about it. It must not look like a sign-out, must not discard the Session that is still valid,
 * must not hold the auth lane for minutes, and must not be blamed on the password.
 */
const COOKIE_KEY = `https://known.example/:${SESSION_COOKIE_NAME}`;

async function restartedStore() {
  const store = createCredentialStore(new MemoryStorageArea(), () => NOW);
  const live = await store.fence.activate();
  await store.saveCredential(fixtureCredential(config(), NOW), live.generation); // pins the account
  const binding = await store.getOrCreateBinding(live.generation);
  await store.clearCredential(); // what a browser restart does to the secret area
  return { store, binding };
}

async function signedInStore() {
  const store = createCredentialStore(new MemoryStorageArea(), () => NOW);
  const live = await store.fence.activate();
  await store.saveCredential({ ...fixtureCredential(config(), NOW), expiresAt: NOW + 30_000 }, live.generation);
  await store.saveSession(fixtureSession(NOW), live.generation);
  return store;
}

/** The identity server answers every request with `respond`; sign-in and get-session are the only ones that matter. */
function controllerAnswering(store: ReturnType<typeof createCredentialStore>, respond: (url: string) => Response | Promise<Response>,
  extra: { readonly requestTimeoutMs?: number } = {}) {
  const cookies = memoryCookies();
  cookies.values.set(COOKIE_KEY, COOKIE_VALUE);
  return createAuthController({ config: config(), store, now: () => NOW, origin: EXTENSION_ORIGIN, cookies,
    fetch: async (url) => respond(String(url)), ...extra });
}

describe('W2B-P2-2 a restart while the server cannot be asked is not a sign-out', () => {
  test('an unreachable server reports offline, keeps the pin and asks again later', async () => {
    const { store, binding } = await restartedStore();
    const unreachable = controllerAnswering(store, () => { throw new TypeError('Failed to fetch'); });
    const status = await unreachable.status();
    assert.equal(status.status, 'offline');
    assert.equal(status.errorCode, 'offline');
    await assert.rejects(() => unreachable.ensureFreshCredential(), /offline/u);
    assert.deepEqual(await store.loadBinding(), binding);
    assert.equal((await store.loadExpectedIdentity())?.subject, 'auth-user-fixture');
    assert.equal(await store.loadSignOutReason(), null, 'no sign-out was recorded');
    // The next controller (a later worker call) asks again and restores the credential.
    const back = controllerAnswering(store, () => Response.json(sessionJson(NOW)));
    assert.equal((await back.status()).status, 'connected');
    assert.equal((await store.loadCredential())?.subject, 'auth-user-fixture');
  });

  test('a server that answers 503 is offline too, not signed out', async () => {
    const { store } = await restartedStore();
    const status = await controllerAnswering(store, () => new Response('<html>bad gateway</html>', { status: 503 })).status();
    assert.equal(status.status, 'offline');
    assert.equal(status.errorCode, 'server_unavailable');
  });

  test('a retry in the same worker asks again instead of staying signed out', async () => {
    const { store } = await restartedStore();
    let reachable = false;
    const controller = controllerAnswering(store, () => {
      if (!reachable) throw new TypeError('Failed to fetch');
      return Response.json(sessionJson(NOW));
    });
    assert.equal((await controller.status()).status, 'offline');
    reachable = true;
    assert.equal((await controller.status()).status, 'connected');
  });

  test('a cookie the server rejects is still a sign-out', async () => {
    const { store } = await restartedStore();
    const status = await controllerAnswering(store, () => new Response(null, { status: 401 })).status();
    assert.equal(status.status, 'signed_out');
    assert.equal(await store.loadCredential(), null);
  });

  test('restoring clears an earlier sign-out reason', async () => {
    const { store } = await restartedStore();
    await store.markSignOutReason('authentication_required');
    assert.equal((await controllerAnswering(store, () => Response.json(sessionJson(NOW))).status()).status, 'connected');
    assert.equal(await store.loadSignOutReason(), null);
  });
});

describe('W2B-P2-4 the identity server gets a deadline', () => {
  test('a server that accepts the request and never answers fails as offline instead of holding the lane', async () => {
    const store = await signedInStore();
    const hanging: typeof fetch = (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
    const controller = createAuthController({ config: config(), store, now: () => NOW, origin: EXTENSION_ORIGIN,
      cookies: memoryCookies(), fetch: hanging, requestTimeoutMs: 40 });
    const outcome = await Promise.race([
      controller.ensureFreshCredential(true).then(() => 'resolved', (error: Error) => error.message),
      new Promise<string>((resolve) => setTimeout(() => resolve('still pending after 3 s'), 3_000)),
    ]);
    assert.equal(outcome, 'offline');
    assert.equal((await store.loadCredential())?.subject, 'auth-user-fixture', 'a timeout does not sign anyone out');
    assert.equal((await store.loadSession())?.sessionId, 'session-fixture');
  });
});

describe('W2B-P2-5 a credential check that could not be made keeps the Session', () => {
  const timedOutBody = () => new Response(new ReadableStream({ start(stream) {
    stream.error(new DOMException('The operation was aborted.', 'AbortError'));
  } }), { headers: { 'Content-Type': 'application/json' } });
  test('a body timeout preserves sync authority', async () => {
    const store = await signedInStore();
    await assert.rejects(() => controllerAnswering(store, timedOutBody).ensureFreshCredential(true), /offline/u);
    assert.equal((await store.loadSession())?.sessionId, 'session-fixture');
  });
  test('cookie restoration retries after a body timeout', async () => {
    const { store } = await restartedStore();
    let broken = true;
    const controller = controllerAnswering(store, () => broken ? timedOutBody() : Response.json(sessionJson(NOW)));
    assert.equal((await controller.status()).status, 'offline');
    broken = false;
    assert.equal((await controller.status()).status, 'connected');
  });
  for (const [name, respond] of [
    ['offline', () => { throw new TypeError('Failed to fetch'); }],
    ['a 503', () => new Response('<html></html>', { status: 503 })],
    ['a 429', () => new Response(null, { status: 429 })],
  ] as const) {
    test(`${name} from get-session leaves the credential and the Session alone`, async () => {
      const store = await signedInStore();
      await assert.rejects(() => controllerAnswering(store, respond).ensureFreshCredential(true));
      assert.equal((await store.loadCredential())?.subject, 'auth-user-fixture');
      assert.equal((await store.loadSession())?.sessionId, 'session-fixture');
    });
  }

  test('an answer the client cannot read still discards the Session, as before', async () => {
    const store = await signedInStore();
    await assert.rejects(() => controllerAnswering(store, () => Response.json({ unexpected: true })).ensureFreshCredential(true),
      /session_unavailable/u);
    assert.equal(await store.loadSession(), null);
  });

  test('a rejected credential is still a sign-out', async () => {
    const store = await signedInStore();
    await assert.rejects(() => fixtureController({ config: config(), store, now: () => NOW, refresh: 'authentication_required' })
      .ensureFreshCredential(true), /authentication_required/u);
    assert.equal(await store.loadCredential(), null);
  });
});

describe('a server outage during sign-in is not blamed on the password', () => {
  test('503 on the sign-in route reports server_unavailable', async () => {
    const store = createCredentialStore(new MemoryStorageArea(), () => NOW);
    const outcome = await controllerAnswering(store, () => new Response('<html>bad gateway</html>', { status: 503 }))
      .login({ method: 'password', email: 'p3-27-extension@example.test', password: 'fixture-password' });
    assert.equal(outcome.status, 'error');
    assert.equal(outcome.errorCode, 'server_unavailable');
  });

  test('a wrong password is still invalid_credentials', async () => {
    const store = createCredentialStore(new MemoryStorageArea(), () => NOW);
    const outcome = await controllerAnswering(store, () => new Response(null, { status: 401 }))
      .login({ method: 'password', email: 'p3-27-extension@example.test', password: 'wrong' });
    assert.equal(outcome.errorCode, 'invalid_credentials');
  });

  test('a successful sign-in is unchanged', async () => {
    const store = createCredentialStore(new MemoryStorageArea(), () => NOW);
    const controller = controllerAnswering(store, (url) => url.endsWith('/sign-in/email')
      ? setCookieResponse({}) : Response.json(sessionJson(NOW)));
    assert.equal((await controller.login({ method: 'password', email: 'p3-27-extension@example.test', password: 'ok' })).status,
      'connected');
  });
});
