import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createAuthClient, type OAuthProvider } from '../src/auth-client.js';

function client(url: string, serverOrigin = 'https://known.example') {
  return createAuthClient({ serverOrigin, origin: 'chrome-extension://fixture',
    fetch: async () => Response.json({ url }) });
}

test.each([
  'javascript:alert(1)', 'data:text/html,hi', 'https://evil.example',
  'https://accounts.google.com.evil.example', 'http://accounts.google.com',
  'https://user:pass@accounts.google.com', 'https://accounts.google.com:444',
  '/relative', 'http://localhost:3000/oauth',
])('refuses unsafe OAuth redirect %s', async (url) => {
  await assert.rejects(client(url).startOAuth('google'), /oauth_start_failed/u);
});

test.each([
  ['google', 'https://accounts.google.com/o/oauth2/v2/auth?state=opaque'],
  ['github', 'https://github.com/login/oauth/authorize?state=opaque'],
] as const)('allows %s only on its provider origin', async (provider: OAuthProvider, url) => {
  assert.deepEqual(await client(url).startOAuth(provider), { url });
  await assert.rejects(client(url).startOAuth(provider === 'google' ? 'github' : 'google'));
});

test('local HTTP fixtures must use the configured loopback origin and port', async () => {
  const url = 'http://127.0.0.1:3000/oauth';
  assert.deepEqual(await client(url, 'http://127.0.0.1:3000').startOAuth('google'), { url });
  await assert.rejects(client(url, 'http://127.0.0.1:3001').startOAuth('google'));
});
