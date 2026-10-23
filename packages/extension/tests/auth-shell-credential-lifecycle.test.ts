import assert from 'node:assert/strict';
import { describe, test, vi } from 'vitest';
import { MemoryStorageArea as SessionStorageArea } from '../src/credential-store.js';
// `sw/credential-storage.ts` imports `./runtime.js` at module scope, which pulls the
// entire service-worker graph and cannot load in a unit test. Only its session area
// is needed here, so that one binding is stubbed; everything else under test is the
// real implementation.
vi.mock('../src/sw/runtime.js', () => ({
  credentialAreaReady: Promise.resolve(new SessionStorageArea()),
}));
import { createAuthController } from '../src/auth-controller.js';
import { SESSION_COOKIE_NAME } from '../src/auth-client.js';
import { MemoryStorageArea, createCredentialStore } from '../src/credential-store.js';
import { createSplitCredentialStorage } from '../src/sw/credential-storage.js';
import {
  COOKIE_VALUE,
  EXTENSION_ORIGIN,
  NOW,
  config,
  fixtureController,
  fixtureCredential,
  fixtureSession,
  memoryCookies,
  sessionJson,
} from './auth-shell-fixture.js';

async function loginFromChangedCookie(domain: string | undefined, accept: boolean) {
  const cookies = memoryCookies();
  const controller = createAuthController({
    config: config(),
    store: createCredentialStore(new MemoryStorageArea(), () => NOW),
    now: () => NOW,
    origin: EXTENSION_ORIGIN,
    cookies,
    oauthTimeoutMs: accept ? 500 : 80,
    oauthPollMs: accept ? 1_000 : 20,
    openOAuthTab: async () => undefined,
    fetch: async (url) => {
      if (String(url).endsWith('/sign-in/social')) {
        return Response.json({ url: 'https://accounts.google.com/o/oauth2' });
      }
      if (String(url).endsWith('/get-session')) return Response.json(sessionJson(NOW));
      return new Response(null, { status: 404 });
    },
  });
  const pending = controller.login({ method: 'oauth', provider: 'google' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const listener of cookies.listeners) {
    listener({ cookie: { name: SESSION_COOKIE_NAME, value: COOKIE_VALUE, domain }, removed: false });
  }
  const outcome = await pending;
  return {
    status: outcome.status,
    errorCode: outcome.errorCode,
    accessToken: (await controller.dependencies.store.loadCredential())?.accessToken,
  };
}

describe('P3-27 Better Auth credential lifecycle', () => {
  test('completes password login from Set-Cookie and stores the session cookie as the bearer', async () => {
    const controller = fixtureController({ config: config(), now: () => NOW });
    const result = await controller.login({
      method: 'password', email: 'p3-27-extension@example.test', password: 'p3-27-extension-password-e3',
    });
    assert.equal(result.status, 'connected');
    assert.deepEqual(controller.fixtureCalls, ['sign-in', 'get-session']);
    const credential = await controller.dependencies.store.loadCredential();
    assert.equal(credential?.accessToken, COOKIE_VALUE);
    assert.equal(credential?.refreshToken, undefined);
    assert.equal(credential?.subject, 'auth-user-fixture');
    assert.equal(credential?.accountLabel, 'p3-27-extension@example.test');
    assert.equal(credential?.issuer, 'https://known.example/');
  });

  test('stores an https session photo on the credential and prefers /me', async () => {
    const sessionPhoto = 'https://lh3.googleusercontent.com/a/session.png';
    const productPhoto = 'https://known.example/api/v1/avatar/123e4567-e89b-42d3-a456-426614174000';
    const fromSession = fixtureController({ config: config(), now: () => NOW, avatar: sessionPhoto });
    await fromSession.login({
      method: 'password', email: 'p3-27-extension@example.test', password: 'p3-27-extension-password-e3',
    });
    assert.equal((await fromSession.dependencies.store.loadCredential())?.avatarUrl, sessionPhoto);
    assert.equal((await fromSession.status()).avatarUrl, sessionPhoto);
    const fromMe = fixtureController({
      config: config(), now: () => NOW, avatar: sessionPhoto, profileAvatar: productPhoto,
    });
    await fromMe.login({
      method: 'password', email: 'p3-27-extension@example.test', password: 'p3-27-extension-password-e3',
    });
    assert.equal((await fromMe.dependencies.store.loadCredential())?.avatarUrl, productPhoto);
  });

  test('stores a provider CDN photo returned by /me', async () => {
    const cdn = 'https://lh3.googleusercontent.com/a/ada.png';
    const controller = fixtureController({ config: config(), now: () => NOW, profileAvatar: cdn });
    await controller.login({
      method: 'password', email: 'p3-27-extension@example.test', password: 'p3-27-extension-password-e3',
    });
    assert.equal((await controller.dependencies.store.loadCredential())?.avatarUrl, cdn);
  });

  test('picks up a /me photo when a live credential is actually refreshing', async () => {
    const productPhoto = 'https://known.example/api/v1/avatar/123e4567-e89b-42d3-a456-426614174000';
    const storage = new MemoryStorageArea();
    const store = createCredentialStore(storage, () => NOW);
    await store.saveCredential({ ...fixtureCredential(config(), NOW), expiresAt: NOW + 30_000 });
    const controller = fixtureController({ config: config(), store, now: () => NOW, profileAvatar: productPhoto });
    const next = await controller.ensureFreshCredential();
    assert.equal(next.avatarUrl, productPhoto);
    assert.equal((await controller.status()).avatarUrl, productPhoto);
  });

  test('does not refresh a live credential just to pick up a photo', async () => {
    const productPhoto = 'https://known.example/api/v1/avatar/123e4567-e89b-42d3-a456-426614174000';
    const storage = new MemoryStorageArea();
    const store = createCredentialStore(storage, () => NOW);
    await store.saveCredential(fixtureCredential(config(), NOW));
    const controller = fixtureController({ config: config(), store, now: () => NOW, profileAvatar: productPhoto });
    const next = await controller.ensureFreshCredential();
    assert.equal(next.avatarUrl, undefined);
    assert.deepEqual(controller.fixtureCalls, []);
    await controller.hydrateAvatar();
    assert.equal((await store.loadCredential())?.avatarUrl, productPhoto);
    assert.equal((await controller.status()).avatarUrl, productPhoto);
  });

  test('fails closed for wrong password, missing session cookie and offline sign-in', async () => {
    for (const failure of ['invalid_credentials', 'cookie_missing', 'offline'] as const) {
      const controller = fixtureController({ config: config(), now: () => NOW, failure });
      const outcome = await controller.login({
        method: 'password', email: 'p3-27-extension@example.test', password: 'wrong-password-value',
      });
      assert.equal(outcome.status, failure === 'offline' ? 'offline' : 'error');
      if (failure === 'invalid_credentials') assert.equal(outcome.errorCode, 'invalid_credentials');
      if (failure === 'cookie_missing') assert.equal(outcome.errorCode, 'session_cookie_missing');
      assert.equal((await controller.dependencies.store.loadCredential()), null);
    }
  });

  test('a changed host cookie refreshes an unexpired credential without retiring its sync session', async () => {
    const store = createCredentialStore(new MemoryStorageArea(), () => NOW);
    await store.saveCredential(fixtureCredential(config(), NOW));
    await store.saveSession(fixtureSession(NOW));
    const before = await store.fence.read();
    const controller = fixtureController({ config: config(), store, now: () => NOW, refresh: 'rotated_cookie' });
    controller.cookies.values.set(`https://known.example/:${SESSION_COOKIE_NAME}`, 'rotated-session.dGVzdHNpZ25hdHVyZQ==');
    assert.equal((await controller.ensureFreshCredential()).accessToken, 'rotated-session.dGVzdHNpZ25hdHVyZQ==');
    assert.ok(controller.fixtureCalls.includes('get-session'));
    assert.equal((await store.loadSession())?.sessionId, 'session-fixture');
    assert.equal((await store.fence.read()).generation, before.generation);
  });

  test('refreshes a live session through get-session and clears authority on 401 or BA null', async () => {
    const storage = new MemoryStorageArea();
    const store = createCredentialStore(storage, () => NOW);
    await store.saveCredential({ ...fixtureCredential(config(), NOW), expiresAt: NOW + 30_000 });
    const fresh = fixtureController({ config: config(), store, now: () => NOW, refresh: 'success' });
    const next = await fresh.ensureFreshCredential();
    assert.equal(next.accessToken, COOKIE_VALUE);
    assert.equal(next.subject, 'auth-user-fixture');
    await store.saveCredential({ ...fixtureCredential(config(), NOW), expiresAt: NOW + 30_000 });
    const rotatedStore = createCredentialStore(new MemoryStorageArea(), () => NOW);
    await rotatedStore.saveCredential({ ...fixtureCredential(config(), NOW), expiresAt: NOW + 30_000 });
    const rotated = fixtureController({ config: config(), store: rotatedStore, now: () => NOW, refresh: 'rotated_cookie' });
    assert.equal((await rotated.ensureFreshCredential(true)).accessToken, 'rotated-session.dGVzdHNpZ25hdHVyZQ==');
    const hiddenStore = createCredentialStore(new MemoryStorageArea(), () => NOW);
    await hiddenStore.saveCredential({ ...fixtureCredential(config(), NOW), expiresAt: NOW + 30_000 });
    const hidden = fixtureController({ config: config(), store: hiddenStore, now: () => NOW, refresh: 'hidden_rotated_cookie' });
    assert.equal((await hidden.ensureFreshCredential(true)).accessToken, 'rotated-session.dGVzdHNpZ25hdHVyZQ==');
    assert.equal(hidden.fixtureCalls.filter((call) => call === 'get-session').length, 2);
    const staleStore = createCredentialStore(new MemoryStorageArea(), () => NOW);
    await staleStore.saveCredential({ ...fixtureCredential(config(), NOW), expiresAt: NOW + 30_000 });
    const stale = fixtureController({ config: config(), store: staleStore, now: () => NOW, refresh: 'stale_header_rotation' });
    assert.equal((await stale.ensureFreshCredential(true)).accessToken, 'rotated-session.dGVzdHNpZ25hdHVyZQ==');
    assert.equal(stale.fixtureCalls.filter((call) => call === 'get-session').length, 2);
    const predecessorStore = createCredentialStore(new MemoryStorageArea(), () => NOW);
    await predecessorStore.saveCredential({ ...fixtureCredential(config(), NOW), expiresAt: NOW + 30_000 });
    const predecessor = fixtureController({ config: config(), store: predecessorStore, now: () => NOW, refresh: 'rejected_predecessor' });
    assert.equal((await predecessor.ensureFreshCredential(true)).accessToken, 'rotated-session.dGVzdHNpZ25hdHVyZQ==');
    assert.equal(predecessor.fixtureCalls.filter((call) => call === 'get-session').length, 2);
    await assert.rejects(
      () => fixtureController({ config: config(), store, now: () => NOW, refresh: 'authentication_required' })
        .ensureFreshCredential(true),
      /authentication_required/u,
    );
    assert.equal(await store.loadCredential(), null);
    await store.saveCredential({ ...fixtureCredential(config(), NOW), expiresAt: NOW + 30_000 });
    await assert.rejects(
      () => fixtureController({ config: config(), store, now: () => NOW, refresh: 'missing_session' })
        .ensureFreshCredential(true),
      /authentication_required/u,
    );
    assert.equal(await store.loadCredential(), null);
  });

  test('logout retires the replica, signs out Better Auth, then removes local authority', async () => {
    const controller = fixtureController({ config: config(), now: () => NOW, logout: 'success' });
    await controller.dependencies.store.saveCredential(fixtureCredential(config(), NOW));
    await controller.dependencies.store.saveSession(fixtureSession(NOW));
    await controller.logout();
    assert.deepEqual(controller.fixtureCalls, ['retire', 'sign-out']);
    assert.equal(await controller.dependencies.store.loadCredential(), null);
    assert.equal(await controller.dependencies.store.loadSession(), null);
  });

  test('logout fences local authority first and treats Replica retirement failure as best effort', async () => {
    const controller = fixtureController({ config: config(), now: () => NOW, logout: 'retire_failure' });
    await controller.dependencies.store.saveCredential(fixtureCredential(config(), NOW));
    await controller.dependencies.store.saveSession(fixtureSession(NOW));
    await controller.logout();
    assert.deepEqual(controller.fixtureCalls, ['retire', 'sign-out']);
    assert.equal(await controller.dependencies.store.loadCredential(), null);
    assert.equal(await controller.dependencies.store.loadSession(), null);
    assert.equal((await controller.dependencies.store.fence.read()).revoked, true);
  });

  test('binding mismatch reports once as error, then keeps explaining the signed-out state', async () => {
    const controller = fixtureController({ config: config(), now: () => NOW });
    await controller.dependencies.store.saveCredential(
      { ...fixtureCredential(config(), NOW), issuer: 'https://other.example/' });
    const first = await controller.status();
    assert.equal(first.status, 'error');
    assert.equal(first.errorCode, 'binding_mismatch');
    const second = await controller.status();
    assert.equal(second.status, 'signed_out');
    assert.equal(second.errorCode, 'binding_mismatch');
  });

  test('login and user logout clear the recorded sign-out reason', async () => {
    const controller = fixtureController({ config: config(), now: () => NOW });
    await controller.dependencies.store.markSignOutReason('binding_mismatch');
    const signedOut = await controller.status();
    assert.equal(signedOut.status, 'signed_out');
    assert.equal(signedOut.errorCode, 'binding_mismatch');
    const login = await controller.login({
      method: 'password', email: 'p3-27-extension@example.test', password: 'p3-27-extension-password-e3',
    });
    assert.equal(login.status, 'connected');
    await controller.logout();
    const after = await controller.status();
    assert.equal(after.status, 'signed_out');
    assert.equal(after.errorCode, undefined);
  });

  test('oauth waits for a new host cookie after opening the provider tab', async () => {
    const cookies = memoryCookies();
    const opened: string[] = [];
    cookies.values.set(`https://known.example/:${SESSION_COOKIE_NAME}`, 'stale-cookie.should-not-win');
    const controller = createAuthController({
      config: config(),
      store: createCredentialStore(new MemoryStorageArea(), () => NOW),
      now: () => NOW,
      origin: EXTENSION_ORIGIN,
      cookies,
      openOAuthTab: async (url) => { opened.push(url); },
      fetch: async (url) => {
        if (String(url).endsWith('/sign-in/social')) {
          return Response.json({ url: 'https://accounts.google.com/o/oauth2' });
        }
        if (String(url).endsWith('/get-session')) return Response.json(sessionJson(NOW));
        return new Response(null, { status: 404 });
      },
    });
    const pending = controller.login({ method: 'oauth', provider: 'google' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(opened, ['https://accounts.google.com/o/oauth2']);
    for (const listener of cookies.listeners) {
      listener({ cookie: { name: SESSION_COOKIE_NAME, value: COOKIE_VALUE, domain: 'known.example' }, removed: false });
    }
    assert.equal((await pending).status, 'connected');
    assert.equal((await controller.dependencies.store.loadCredential())?.accessToken, COOKIE_VALUE);
  });

  test('oauth decodes a percent-encoded host cookie before restoring the session', async () => {
    const cookies = memoryCookies();
    let seenCookie: string | undefined;
    const controller = createAuthController({
      config: config(),
      store: createCredentialStore(new MemoryStorageArea(), () => NOW),
      now: () => NOW,
      origin: EXTENSION_ORIGIN,
      cookies,
      openOAuthTab: async () => undefined,
      fetch: async (url, init) => {
        if (String(url).endsWith('/sign-in/social')) {
          return Response.json({ url: 'https://accounts.google.com/o/oauth2' });
        }
        if (String(url).endsWith('/get-session')) {
          seenCookie = new Headers(init?.headers).get('cookie') ?? undefined;
          return Response.json(sessionJson(NOW));
        }
        return new Response(null, { status: 404 });
      },
    });
    const pending = controller.login({ method: 'oauth', provider: 'google' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const listener of cookies.listeners) {
      listener({
        cookie: { name: SESSION_COOKIE_NAME, value: encodeURIComponent(COOKIE_VALUE), domain: 'known.example' },
        removed: false,
      });
    }
    assert.equal((await pending).status, 'connected');
    assert.equal((await controller.dependencies.store.loadCredential())?.accessToken, COOKIE_VALUE);
    assert.equal(seenCookie, `${SESSION_COOKIE_NAME}=${encodeURIComponent(COOKIE_VALUE)}`);
  });

  test('oauth restores the session when the host cookie appears without onChanged', async () => {
    const cookies = memoryCookies();
    const controller = createAuthController({
      config: config(),
      store: createCredentialStore(new MemoryStorageArea(), () => NOW),
      now: () => NOW,
      origin: EXTENSION_ORIGIN,
      cookies,
      oauthPollMs: 20,
      openOAuthTab: async () => {
        cookies.values.set(`https://known.example/:${SESSION_COOKIE_NAME}`, COOKIE_VALUE);
      },
      fetch: async (url) => {
        if (String(url).endsWith('/sign-in/social')) {
          return Response.json({ url: 'https://accounts.google.com/o/oauth2' });
        }
        if (String(url).endsWith('/get-session')) return Response.json(sessionJson(NOW));
        return new Response(null, { status: 404 });
      },
    });
    assert.equal((await controller.login({ method: 'oauth', provider: 'google' })).status, 'connected');
    assert.equal((await controller.dependencies.store.loadCredential())?.accessToken, COOKIE_VALUE);
  });

  test('oauth ignores a same-named cookie from another host', async () => {
    const cookies = memoryCookies();
    const controller = createAuthController({
      config: config(),
      store: createCredentialStore(new MemoryStorageArea(), () => NOW),
      now: () => NOW,
      origin: EXTENSION_ORIGIN,
      cookies,
      oauthTimeoutMs: 80,
      oauthPollMs: 20,
      openOAuthTab: async () => undefined,
      fetch: async (url) => {
        if (String(url).endsWith('/sign-in/social')) {
          return Response.json({ url: 'https://accounts.google.com/o/oauth2' });
        }
        if (String(url).endsWith('/get-session')) return Response.json(sessionJson(NOW));
        return new Response(null, { status: 404 });
      },
    });
    const pending = controller.login({ method: 'oauth', provider: 'google' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const listener of cookies.listeners) {
      listener({
        cookie: { name: SESSION_COOKIE_NAME, value: COOKIE_VALUE, domain: 'evil.example' },
        removed: false,
      });
    }
    const outcome = await pending;
    assert.equal(outcome.status, 'error');
    assert.equal(outcome.errorCode, 'login_cancelled:oauth_timeout');
  });

  test('oauth does not finish login when the changed cookie has no domain', async () => {
    const outcome = await loginFromChangedCookie(undefined, false);
    assert.equal(outcome.status, 'error');
    assert.equal(outcome.errorCode, 'login_cancelled:oauth_timeout');
    assert.equal(outcome.accessToken, undefined);
  });

  test('oauth does not finish login when the changed cookie domain is empty', async () => {
    const outcome = await loginFromChangedCookie('', false);
    assert.equal(outcome.status, 'error');
    assert.equal(outcome.errorCode, 'login_cancelled:oauth_timeout');
    assert.equal(outcome.accessToken, undefined);
  });

  test('oauth finishes login when the changed cookie domain is the server host', async () => {
    const host = new URL(config().serverOrigin).hostname;
    const outcome = await loginFromChangedCookie(host, true);
    assert.equal(outcome.status, 'connected');
    assert.equal(outcome.accessToken, COOKIE_VALUE);
  });

  test('oauth finishes login when the changed cookie domain has a leading dot', async () => {
    const host = new URL(config().serverOrigin).hostname;
    const outcome = await loginFromChangedCookie(`.${host}`, true);
    assert.equal(outcome.status, 'connected');
    assert.equal(outcome.accessToken, COOKIE_VALUE);
  });

  test('a restarted profile is re-established from the cookie instead of signed out', async () => {
    // REGRESSION, and the reason this exists: the credential lives in
    // `chrome.storage.session` (TRUSTED_CONTEXTS, so options/popup cannot read it),
    // and that area is cleared when the browser session ends. Nothing consulted the
    // cookie in the browser's jar, so every browser restart forced a fresh login —
    // for a session that was still valid. This is the boot shape: an empty session
    // area and a live cookie.
    const cookies = memoryCookies();
    cookies.values.set(`https://known.example/:${SESSION_COOKIE_NAME}`, COOKIE_VALUE);
    const store = createCredentialStore(new MemoryStorageArea(), () => NOW);
    const controller = createAuthController({
      config: config(), store, now: () => NOW, origin: EXTENSION_ORIGIN, cookies,
      fetch: async (url) => {
        if (String(url).endsWith('/get-session')) return Response.json(sessionJson(NOW));
        return new Response(null, { status: 404 });
      },
    });
    await store.saveCredential(fixtureCredential(config(), NOW)); await store.clearCredential();
    assert.equal(await store.loadCredential(), null, 'the restarted profile starts with no credential');

    const status = await controller.status();
    assert.equal(status.status, 'connected',
      'a live cookie must re-establish the session rather than reporting signed_out');
    assert.equal((await store.loadCredential())?.accessToken, COOKIE_VALUE);
  });

  test('a restarted profile with no cookie stays signed out', async () => {
    const cookies = memoryCookies();
    const store = createCredentialStore(new MemoryStorageArea(), () => NOW);
    const controller = createAuthController({
      config: config(), store, now: () => NOW, origin: EXTENSION_ORIGIN, cookies,
      fetch: async () => { throw new Error('the backend must not be called without a cookie'); },
    });
    assert.equal((await controller.status()).status, 'signed_out');
  });

  test('an expired or rejected cookie fails closed', async () => {
    // The cookie can outlive the server-side session. Restoring must then fail
    // closed: reporting connected off a stale cookie would be worse than asking the
    // user to sign in.
    const cookies = memoryCookies();
    cookies.values.set(`https://known.example/:${SESSION_COOKIE_NAME}`, COOKIE_VALUE);
    const store = createCredentialStore(new MemoryStorageArea(), () => NOW);
    await store.saveCredential(fixtureCredential(config(), NOW)); await store.clearCredential();
    const controller = createAuthController({
      config: config(), store, now: () => NOW, origin: EXTENSION_ORIGIN, cookies,
      fetch: async (url) => {
        if (String(url).endsWith('/get-session')) {
          // Expired server-side.
          return Response.json({ session: { id: 's', userId: 'u', expiresAt: new Date(NOW - 1_000).toISOString() },
            user: { id: 'u', email: null, name: null } });
        }
        return new Response(null, { status: 404 });
      },
    });
    assert.equal((await controller.status()).status, 'signed_out');
    assert.equal(await store.loadCredential(), null, 'no credential may be conjured from a dead cookie');
  });

  test('restoring from the cookie leaves nothing credential-shaped in local storage', async () => {
    // The security property the split was made for. Restoring must not undo it: the
    // cookie stays in the browser jar and the rebuilt credential stays in the
    // TRUSTED_CONTEXTS session area, so nothing page-readable gains a secret.
    const cookies = memoryCookies();
    cookies.values.set(`https://known.example/:${SESSION_COOKIE_NAME}`, COOKIE_VALUE);
    const local = new MemoryStorageArea();
    const store = createCredentialStore(createSplitCredentialStorage(local), () => NOW);
    await store.saveCredential(fixtureCredential(config(), NOW)); await store.clearCredential();
    const controller = createAuthController({
      config: config(), store, now: () => NOW, origin: EXTENSION_ORIGIN, cookies,
      fetch: async (url) => {
        if (String(url).endsWith('/get-session')) return Response.json(sessionJson(NOW));
        return new Response(null, { status: 404 });
      },
    });
    assert.equal((await controller.status()).status, 'connected');
    const persisted = JSON.stringify(await local.get(null));
    assert.equal(persisted.includes(COOKIE_VALUE), false,
      'the restored credential must not reach local storage');
  });
});
