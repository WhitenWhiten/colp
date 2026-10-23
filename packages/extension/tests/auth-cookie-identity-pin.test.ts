import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createAuthController } from '../src/auth-controller.js';
import { SESSION_COOKIE_NAME } from '../src/auth-client.js';
import { createCredentialStore, MemoryStorageArea } from '../src/credential-store.js';
import { COOKIE_VALUE, EXTENSION_ORIGIN, NOW, config, fixtureCredential, memoryCookies,
  sessionJson, setCookieResponse } from './auth-shell-fixture.js';

test('a fresh profile does not adopt an existing Web session cookie', async () => {
  const cookies = memoryCookies(); cookies.values.set(`https://known.example/:${SESSION_COOKIE_NAME}`, COOKIE_VALUE);
  const store = createCredentialStore(new MemoryStorageArea(), () => NOW); let calls = 0;
  const auth = createAuthController({ config: config(), store, cookies, now: () => NOW, origin: EXTENSION_ORIGIN,
    fetch: async () => { calls++; return Response.json(sessionJson(NOW)); } });
  assert.equal((await auth.status()).status, 'signed_out');
  assert.equal(calls, 0); assert.equal(await store.loadCredential(), null);
});

test('a different Web account cannot take over a restarted extension identity', async () => {
  const area = new MemoryStorageArea(); const original = createCredentialStore(area, () => NOW);
  await original.saveCredential(fixtureCredential(config(), NOW)); await original.clearCredential();
  const store = createCredentialStore(area, () => NOW); const cookies = memoryCookies();
  cookies.values.set(`https://known.example/:${SESSION_COOKIE_NAME}`, COOKIE_VALUE);
  const paths: string[] = [];
  const auth = createAuthController({ config: config(), store, cookies, now: () => NOW, origin: EXTENSION_ORIGIN,
    fetch: async url => { paths.push(new URL(String(url)).pathname); return Response.json(sessionJson(NOW, 'another-account')); } });
  assert.equal((await auth.status()).status, 'signed_out');
  assert.equal(await store.loadCredential(), null);
  assert.deepEqual(paths, ['/api/v1/auth/get-session']);
  assert.equal((await store.loadExpectedIdentity())?.subject, 'auth-user-fixture');
});

test('the identity pin binds the configured issuer/client and is removed on authority cleanup', async () => {
  const store = createCredentialStore(new MemoryStorageArea(), () => NOW);
  await store.saveCredential(fixtureCredential(config(), NOW)); await store.clearCredential();
  const cookies = memoryCookies(); cookies.values.set(`https://known.example/:${SESSION_COOKIE_NAME}`, COOKIE_VALUE);
  const auth = createAuthController({ config: { ...config(), clientId: 'different-client' }, store, cookies,
    now: () => NOW, origin: EXTENSION_ORIGIN, fetch: async () => { throw new Error('must not fetch'); } });
  assert.equal((await auth.status()).status, 'signed_out');
  await store.revokeAuthority(); assert.equal(await store.loadExpectedIdentity(), null);
  await store.clearAuthority(); assert.equal(await store.loadExpectedIdentity(), null);
});

test('a live pre-pin credential migrates its non-secret identity before a browser reset', async () => {
  const area = new MemoryStorageArea();
  await area.set({ 'known.auth.credential.v1': { ...fixtureCredential(config(), NOW), authorityGeneration: 0 } });
  const store = createCredentialStore(area, () => NOW);
  assert.equal(await store.loadExpectedIdentity(), null);
  assert.equal((await store.loadCredential())?.subject, 'auth-user-fixture');
  await store.clearCredential();
  assert.equal((await store.loadExpectedIdentity())?.subject, 'auth-user-fixture');
  assert.equal(JSON.stringify(await area.get(null)).includes(COOKIE_VALUE), false);
});

test('explicit sign-in can authorize a different account and restore only that account afterward', async () => {
  const area = new MemoryStorageArea(); const store = createCredentialStore(area, () => NOW);
  await store.saveCredential(fixtureCredential(config(), NOW)); await store.clearCredential();
  const cookies = memoryCookies();
  const dependencies = { config: config(), store, cookies, now: () => NOW, origin: EXTENSION_ORIGIN,
    fetch: async (url: URL | RequestInfo) => String(url).endsWith('/sign-in/email')
      ? setCookieResponse({}) : String(url).endsWith('/get-session')
        ? Response.json(sessionJson(NOW, 'new-account')) : new Response(null, { status: 404 }) };
  assert.equal((await createAuthController(dependencies).login({ method: 'password',
    email: 'new@example.test', password: 'fixture-password' })).status, 'connected');
  assert.equal((await store.loadExpectedIdentity())?.subject, 'new-account');
  await store.clearCredential(); const restarted = createCredentialStore(area, () => NOW);
  assert.equal((await createAuthController({ ...dependencies, store: restarted }).status()).status, 'connected');
  assert.equal((await restarted.loadCredential())?.subject, 'new-account');
});
