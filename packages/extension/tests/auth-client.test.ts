import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createAuthClient, readSessionCookie } from '../src/auth-client.js';

const SERVER = 'https://known.example';

function client(fetchImpl: typeof fetch) {
  return createAuthClient({
    serverOrigin: SERVER,
    origin: 'chrome-extension://fixture',
    fetch: fetchImpl,
  });
}

function cookieResponse(name: string, value: string): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`,
    },
  });
}

test('identifier without @ posts to sign-in/username', async () => {
  let seen: { url: string; body: unknown } | undefined;
  const auth = client(async (url, init) => {
    seen = { url: String(url), body: JSON.parse(String(init?.body)) };
    return cookieResponse('__Host-known_session', 'host-token');
  });
  assert.equal(await auth.signInWithPassword({ email: 'alice', password: 'secret' }), 'host-token');
  assert.equal(seen?.url, `${SERVER}/api/v1/auth/sign-in/username`);
  assert.deepEqual(seen?.body, { username: 'alice', password: 'secret' });
});

test('identifier with @ posts to sign-in/email', async () => {
  let seen: { url: string; body: unknown } | undefined;
  const auth = client(async (url, init) => {
    seen = { url: String(url), body: JSON.parse(String(init?.body)) };
    return cookieResponse('__Host-known_session', 'host-token');
  });
  assert.equal(await auth.signInWithPassword({ email: 'alice@example.com', password: 'secret' }), 'host-token');
  assert.equal(seen?.url, `${SERVER}/api/v1/auth/sign-in/email`);
  assert.deepEqual(seen?.body, { email: 'alice@example.com', password: 'secret' });
});

test('session cookie is read from __Host-known_session', () => {
  const response = cookieResponse('__Host-known_session', 'host-token');
  assert.equal(readSessionCookie(response), 'host-token');
});

test('session cookie is read from known_session', () => {
  const response = cookieResponse('known_session', 'plain-token');
  assert.equal(readSessionCookie(response), 'plain-token');
});

test('wrong password behavior is unchanged', async () => {
  const urls: string[] = [];
  const auth = client(async (url) => {
    urls.push(String(url));
    return Response.json({ code: 'invalid_credentials' }, { status: 401 });
  });
  await assert.rejects(
    auth.signInWithPassword({ email: 'alice@example.com', password: 'wrong' }),
    (error: unknown) => error instanceof Error && error.message === 'invalid_credentials',
  );
  await assert.rejects(
    auth.signInWithPassword({ email: 'alice', password: 'wrong' }),
    (error: unknown) => error instanceof Error && error.message === 'invalid_credentials',
  );
  assert.deepEqual(urls, [
    `${SERVER}/api/v1/auth/sign-in/email`,
    `${SERVER}/api/v1/auth/sign-in/username`,
  ]);
});
