import { test, expect, chromium } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openExtensionOptions } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';
const extensionId = 'pplpnpegpnghcddhmpgkbfkdfadjiaen', extensionPath = resolve(import.meta.dirname, '../dist/development');
test('source native saves finish without a server, inside an offline sync range, and while sync is paused', async () => {
  test.setTimeout(120000);
  const profile = await mkdtemp(resolve(tmpdir(), 'site-local-first-'));
  const context = await chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium', args: [
    `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
  ] });
  try {
    const cors = { 'access-control-allow-origin': 'https://www.bilibili.com', 'access-control-allow-credentials': 'true' };
    await context.route('https://www.bilibili.com/**', r => r.fulfill({ contentType: 'text/html', body: '<title>Local first source</title>' }));
    await context.route('https://api.bilibili.com/x/web-interface/nav', r => r.fulfill({ headers: cors, contentType: 'application/json', body: '{"code":0,"data":{"isLogin":true,"mid":42}}' }));
    const { page } = await openExtensionOptions(context);
    const grants = { permissions: ['bookmarks', 'scripting', 'webNavigation'], origins: ['https://www.bilibili.com/*'] };
    await page.evaluate(g => { const button = document.createElement('button'); button.id = 'grant-local-first'; button.textContent = 'Grant local first source';
      button.onclick = () => { void chrome.permissions.request(g); }; document.body.prepend(button); }, grants);
    await grantOptionalBookmarks(page, page.locator('#grant-local-first'), 'Local first source', grants);
    const worker = context.serviceWorkers()[0]!;
    await worker.evaluate(() => {
      const original = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.startsWith('http://127.0.0.1:4173/')) return Promise.reject(new TypeError('Controlled COLP outage'));
        return original(input, init);
      };
    });
    const site = await context.newPage(); await site.goto('https://www.bilibili.com/video/av1');
    await page.goto(`chrome-extension://${extensionId}/site-adapters.html`); await page.locator('#enable').click();
    await expect.poll(() => page.evaluate(async () => ((await chrome.runtime.sendMessage({ kind: 'known.siteAdapters.status' })) as { candidateAccount?: string }).candidateAccount)).toBe('42');
    await page.locator('#refresh').click(); await page.locator('#confirm').click();
    await expect.poll(() => page.evaluate(async () => ((await chrome.runtime.sendMessage({ kind: 'known.siteAdapters.status' })) as { documents?: number }).documents)).toBe(1);
    const timings: { mode: string; nativeMs: number }[] = [];
    for (const mode of ['no-server', 'offline-synced', 'paused']) {
      const root = await page.evaluate(async title => chrome.bookmarks.create({ parentId: (await chrome.bookmarks.getTree())[0]!.children![0]!.id, title }), mode);
      if (mode !== 'no-server') {
        const scope = await page.evaluate(async () => {
          const config = await fetch(chrome.runtime.getURL('generated-config.json')).then(r => r.json());
          const accountId = 'a'.repeat(32), collectionId = 'local-first-library';
          const generation = ((await chrome.storage.local.get('known.auth.authority-generation.v1'))['known.auth.authority-generation.v1'] as { generation?: number } | undefined)?.generation ?? 0;
          await chrome.storage.session.set({ 'known.auth.credential.v1': { accessToken: 'offline-fixture', tokenType: 'Bearer', expiresAt: Date.now() + 3600000,
            scope: config.scopes, issuer: config.issuer, audience: config.audience, clientId: config.clientId, serverOrigin: config.serverOrigin, subject: accountId, authorityGeneration: generation } });
          await chrome.storage.local.set({ 'known.auth.binding.v1': { replicaId: 'replica-local-first', browserProfileId: 'profile-local-first', generation: '1' }, 'known.sync.collection.v1': collectionId });
          return { environment: config.environment, serverId: config.serverOrigin, serverOrigin: config.serverOrigin, accountId, collectionId, replicaId: 'replica-local-first', browserProfileId: 'profile-local-first', generation: 1 };
        });
        await page.evaluate(scope => chrome.runtime.sendMessage({ kind: 'known.sync-state.evidence', method: 'registerEvidenceScope', args: [scope] }), scope);
        const configured = await page.evaluate(({ scope, rootId }) => chrome.runtime.sendMessage({ kind: 'known.sync-state.evidence', method: 'configureOutboundBookmarkRoot',
          args: [rootId, null, `canonical-${rootId}`, 'root-revision'] }), { scope, rootId: root.id });
        expect(configured, JSON.stringify(configured)).toMatchObject({ ok: true });
        if (mode === 'paused') await page.evaluate(scope => chrome.storage.local.set({
          ['known.personal-sync.v1:' + JSON.stringify([scope.serverOrigin, scope.accountId])]: { version: 1, mode: 'paused', collectionId: scope.collectionId, revision: crypto.randomUUID(), reason: 'user' },
        }), scope);
      }
      const call = async (operation: string, extra: Record<string, string>) => await page.evaluate(r => chrome.runtime.sendMessage({ kind: 'known.siteAdapters.evidence', ...r }), { operation, ...extra }) as { status?: string; planId?: string };
      const prepared = await call('prepare', { rootNativeId: root.id }); expect(prepared.planId).toBeTruthy();
      if (!prepared.planId) throw Error(JSON.stringify(prepared));
      const started = Date.now();
      expect(await call('execute', { planId: prepared.planId, effectId: 'folder' })).toMatchObject({ status: 'confirmed' });
      expect(await call('execute', { planId: prepared.planId, effectId: 'bookmark' })).toMatchObject({ status: 'confirmed' });
      timings.push({ mode, nativeMs: Date.now() - started });
      expect(timings.at(-1)!.nativeMs).toBeLessThan(5000);
      const saved = await page.evaluate(async rootId => {
        const folder = (await chrome.bookmarks.getChildren(rootId))[0]!;
        return { folder, children: await chrome.bookmarks.getChildren(folder.id) };
      }, root.id);
      expect(saved.children).toHaveLength(1); expect(saved.children[0]!.url).toBe('https://www.bilibili.com/video/av1');
      expect(await call('execute', { planId: prepared.planId, effectId: 'bookmark' })).toMatchObject({ status: 'confirmed' });
      expect(await page.evaluate(id => chrome.bookmarks.getChildren(id).then(rows => rows.length), saved.folder.id)).toBe(1);
      if (mode !== 'no-server') {
        const transfers = await page.evaluate(async () => {
          const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('known-site-adapters'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
          try { return await new Promise<any[]>((resolve, reject) => { const r = db.transaction('transfers').objectStore('transfers').getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }
          finally { db.close(); }
        });
        expect(transfers.some(t => t.native.nativeId === saved.children[0]!.id && t.owner.accountId === 'a'.repeat(32))).toBe(true);
      }
    }
    await test.info().attach('native-save-timings', { contentType: 'application/json', body: JSON.stringify(timings) });
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
