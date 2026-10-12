import { chromium, expect, test, type BrowserContext } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { gotoOptions, openExtensionOptions } from './extension-auth.js';
import { manifest } from '../tests/auth-shell-fixture.js';

// A transport fixture exercises real Chromium permissions and cookies. This
// test does not claim PostgreSQL or bookmark-sync integration coverage.
test('custom HTTP server: permission, username login, cookie persistence and disconnect', async () => {
  test.setTimeout(120_000);
  let origin = '', signedIn = false, usernameLogins = 0;
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Access-Control-Allow-Origin', request.headers.origin ?? '*');
    response.setHeader('Access-Control-Allow-Credentials', 'true');
    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Collection-Protocol-Version');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      response.end(); return;
    }
    if (request.url === '/.well-known/collection-protocol') {
      const body = manifest(origin);
      Object.assign(body.mounts[0]!, { 'https://know-n.com/colp/extensions/server': {
        cloud: false, edition: { name: 'colp-server', version: '0.1.0' }, transport: 'insecure-http',
      } });
      response.end(JSON.stringify(body)); return;
    }
    if (request.url === '/api/v1/auth/sign-in/username') {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw) as { username: string; password: string };
      if (body.username !== 'alice' || body.password !== 'browser-test-password') {
        response.statusCode = 401; response.end('{}'); return;
      }
      usernameLogins++; signedIn = true;
      response.setHeader('Set-Cookie', 'known_session=browser-test-token; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400');
      response.end('{}'); return;
    }
    if (request.url === '/api/v1/auth/get-session') {
      response.end(JSON.stringify(signedIn && request.headers.cookie?.includes('known_session=browser-test-token') ? {
        session: { id: 'browser-test-session', userId: 'browser-test-user', expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
        user: { id: 'browser-test-user', email: 'alice@users.invalid', name: 'Alice' },
      } : null)); return;
    }
    if (request.url === '/api/v1/auth/sign-out') {
      signedIn = false; response.end('{}'); return;
    }
    response.statusCode = 404; response.end('{}');
  });
  const profile = await mkdtemp(resolve(tmpdir(), 'known-server-settings-'));
  let context: BrowserContext | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture_address_missing');
    origin = `http://127.0.0.1:${address.port}`;
    const extension = resolve(import.meta.dirname, '../dist/production');
    const launch = () => chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium',
      executablePath: process.env.KNOWN_E2E_CHROMIUM_EXECUTABLE, args: [
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-proxy-server',
    ] });
    context = await launch();
    const { page } = await openExtensionOptions(context);
    await expect(page.locator('#login-panel')).toBeVisible();
    let permissionAttempt = 0;
    await grantOptionalBookmarks(page, page.locator('#login-email'), 'Known server settings', { origins: [`${origin}/*`] },
      async () => { await page.locator('#server-origin').fill(`${origin}${permissionAttempt++ % 2 ? '/' : ''}`); });
    await expect.poll(() => page.evaluate(async () => (await chrome.storage.local.get('runtimeServerOrigin')).runtimeServerOrigin)).toBe(origin);
    await expect(page.locator('#login-tab-otp')).toBeHidden();
    await expect(page.locator('#login-social')).toBeHidden();
    await expect(page.locator('#login-email')).toHaveAttribute('autocomplete', 'username');
    await page.locator('#login-email').fill('alice');
    await page.locator('#login-password').fill('browser-test-password');
    await page.locator('#login-submit').click();
    await expect(page.locator('body')).toHaveAttribute('data-state', 'connected');
    expect(usernameLogins).toBe(1);
    const cookie = await page.evaluate(url => chrome.cookies.get({ url, name: 'known_session' }), origin);
    expect(cookie).toMatchObject({ name: 'known_session', secure: false, httpOnly: true });
    expect(await page.evaluate(url => chrome.cookies.get({ url, name: '__Host-known_session' }), origin)).toBeNull();
    await context.close(); context = await launch();
    const restored = await openExtensionOptions(context);
    await gotoOptions(restored.page, '#account');
    await expect(restored.page.locator('body')).toHaveAttribute('data-state', 'connected');
    expect(usernameLogins).toBe(1);
    await restored.page.locator('#disconnect-server').click();
    await expect(restored.page.locator('body')).toHaveAttribute('data-state', 'signed_out');
    await expect.poll(() => restored.page.evaluate(async () => (await chrome.storage.local.get('runtimeServerOrigin')).runtimeServerOrigin)).toBeUndefined();
    expect(await context.cookies(origin)).toEqual([]);
    expect(await restored.page.evaluate(url => chrome.permissions.contains({ origins: [`${url}/*`] }), origin)).toBe(false);
    await expect(restored.page.locator('#server')).toHaveText('https://know-n.com');
  } finally {
    await context?.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(profile, { recursive: true, force: true });
  }
});
