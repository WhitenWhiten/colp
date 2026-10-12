import { expect, test, vi } from 'vitest';
import { createAuthController } from '../src/auth-controller.js';
import { createCredentialStore, MemoryStorageArea } from '../src/credential-store.js';
import { resolveRuntimeConfig } from '../src/config.js';
import { createAuthClient } from '../src/auth-client.js';
import { config, EXTENSION_ORIGIN, memoryCookies, NOW, sessionJson } from './auth-shell-fixture.js';

test('loopback HTTP login, rotation, restart restoration and logout use the non-Secure cookie', async () => {
  const build = resolveRuntimeConfig(config(), 'http://127.0.0.1:8080');
  const cookies = memoryCookies(); const set = vi.spyOn(cookies, 'set');
  let rotate = false;
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/sign-in/username')) return new Response('{}', { headers: { 'Set-Cookie': 'known_session=initial-token; Path=/; HttpOnly' } });
    if (String(url).endsWith('/get-session')) {
      expect(new Headers(init?.headers).get('Cookie')).toMatch(/^known_session=/u);
      const headers = rotate ? { 'Set-Cookie': 'known_session=rotated-token; Path=/; HttpOnly' } : undefined;
      rotate = false; return Response.json(sessionJson(NOW), { headers });
    }
    return new Response(null, { status: 404 });
  };
  const create = () => {
    const store = createCredentialStore(new MemoryStorageArea(), () => NOW);
    return { store, auth: createAuthController({ config: build, store, cookies, fetch: fetcher, origin: EXTENSION_ORIGIN, now: () => NOW }) };
  };
  const initial = create();
  expect((await initial.auth.login({ method: 'password', email: 'alice', password: 'test-password' })).status).toBe('connected');
  rotate = true;
  expect((await initial.auth.ensureFreshCredential(true)).accessToken).toBe('rotated-token');
  for (const [details] of set.mock.calls) expect(details).toMatchObject({ name: 'known_session', secure: false, httpOnly: true, sameSite: 'lax' });
  const restarted = create();
  expect((await restarted.auth.status()).status).toBe('connected');
  expect((await restarted.store.loadCredential())?.accessToken).toBe('rotated-token');
  await restarted.auth.logout();
  expect(cookies.values.size).toBe(0); expect(await restarted.store.loadCredential()).toBeNull();
});

test('HTTPS cookie restoration does not fall back to a plaintext cookie on the same host', async () => {
  const cookies = memoryCookies();
  cookies.values.set('https://known.example/:known_session', 'plaintext-token');
  const fetcher = vi.fn<typeof fetch>();
  const auth = createAuthController({ config: config(), store: createCredentialStore(new MemoryStorageArea()), cookies, fetch: fetcher, origin: EXTENSION_ORIGIN });
  expect((await auth.status()).status).toBe('signed_out'); expect(fetcher).not.toHaveBeenCalled();
});

test('HTTPS sign-in ignores an insecure Set-Cookie instead of promoting it to HTTPS authority', async () => {
  const auth = createAuthClient({ serverOrigin: 'https://known.example', origin: EXTENSION_ORIGIN,
    fetch: async () => new Response('{}', { headers: { 'Set-Cookie': 'known_session=plaintext-token' } }) });
  await expect(auth.signInWithPassword({ email: 'alice', password: 'test-password' })).rejects.toThrow('session_cookie_missing');
});
