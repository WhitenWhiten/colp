import { test, expect, chromium } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { EXTENSION_ID } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { grantTabAccess, openPopupOver } from './popup-page.js';

test('manual saving creates a native bookmark while cloud session renewal is still pending', async () => {
  const profile = await mkdtemp(resolve(tmpdir(), 'known-save-cloud-unavailable-'));
  const extensionPath = resolve(import.meta.dirname, '../dist/development');
  const context = await chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium', args: [
    `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
  ] });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#bookmarks`);
    await expect(page.locator('body')).toHaveAttribute('data-pane', 'bookmarks'); await page.waitForTimeout(800);
    await grantOptionalBookmarks(page, 'Allow bookmark access', 'Known cloud-unavailable saving'); await grantTabAccess(context);
    const worker = context.serviceWorkers()[0]!;
    await worker.evaluate(() => {
      const originalFetch = globalThis.fetch;
      const fixture = globalThis as typeof globalThis & { pendingCloudRequests: number; releaseCloudRequests: (() => void)[] };
      fixture.pendingCloudRequests = 0; fixture.releaseCloudRequests = [];
      globalThis.fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.startsWith('http://127.0.0.1:4173/')) {
          if (url.includes('/.well-known/collection-protocol')) {
            fixture.pendingCloudRequests++;
            await new Promise<void>(resolve => fixture.releaseCloudRequests.push(resolve));
            fixture.pendingCloudRequests--;
          }
          throw new TypeError('Failed to fetch');
        }
        return originalFetch(input, init);
      };
    });
    const parentId = await page.evaluate(async () => {
      const config = await fetch(chrome.runtime.getURL('generated-config.json')).then(response => response.json());
      const parentId = (await chrome.bookmarks.getTree())[0]!.children![0]!.id;
      const fence = (await chrome.storage.local.get('known.auth.authority-generation.v1'))['known.auth.authority-generation.v1'] as { generation?: number } | undefined;
      await chrome.storage.session.set({ 'known.auth.credential.v1': { accessToken: 'cloud-unavailable-fixture', tokenType: 'Bearer',
        expiresAt: Date.now() + 3600000, scope: ['known.sync'], issuer: config.issuer, audience: config.audience, clientId: config.clientId,
        serverOrigin: config.serverOrigin, subject: 'a'.repeat(32), authorityGeneration: fence?.generation ?? 0 } });
      await chrome.storage.local.set({
        'known.auth.binding.v1': { replicaId: 'replica-fixture', browserProfileId: 'profile-fixture', generation: '1' },
        'known.sync.collection.v1': 'local-save-collection',
        'known.sync.save-context.v1': { collectionId: 'local-save-collection', parentNativeId: parentId },
        'known.auth.snapshot.v1': { status: 'connected', environment: config.environment, serverOrigin: config.serverOrigin, accountLabel: 'a'.repeat(32) },
      });
      return parentId;
    });
    await context.route('https://example.org/save-cloud-pending', route => route.fulfill({ contentType: 'text/html', body: '<title>Save while cloud waits</title>' }));
    const target = await context.newPage(); await target.goto('https://example.org/save-cloud-pending');
    const popup = await openPopupOver(context, target);
    await expect(popup.locator('#save')).toBeEnabled();
    await expect.poll(() => worker.evaluate(() => (globalThis as unknown as { pendingCloudRequests: number }).pendingCloudRequests)).toBeGreaterThan(0);
    await popup.locator('#save').click();
    await expect.poll(() => page.evaluate(() => chrome.bookmarks.search({ url: 'https://example.org/save-cloud-pending' }).then(nodes => nodes.length)), { timeout: 5000 }).toBe(1);
    expect(await worker.evaluate(() => (globalThis as unknown as { pendingCloudRequests: number }).pendingCloudRequests)).toBeGreaterThan(0);
    const [saved] = await page.evaluate(() => chrome.bookmarks.search({ url: 'https://example.org/save-cloud-pending' }));
    expect(saved).toMatchObject({ parentId, title: 'Save while cloud waits' });
    expect(await page.evaluate(async () => (await chrome.storage.local.get('known.sync.collection.v1'))['known.sync.collection.v1'])).toBe('local-save-collection');
  } finally {
    const worker = context.serviceWorkers()[0];
    await worker?.evaluate(() => (globalThis as unknown as { releaseCloudRequests?: (() => void)[] }).releaseCloudRequests?.splice(0).forEach(release => release())).catch(() => undefined);
    await context.close(); await rm(profile, { recursive: true, force: true });
  }
});
