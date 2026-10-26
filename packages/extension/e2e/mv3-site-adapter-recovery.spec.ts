import { test, expect, chromium } from '@playwright/test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openExtensionOptions } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { openSiteAdapterTab, openSiteAdapterConfiguration } from './site-adapter-ui.js';
const extension = resolve(import.meta.dirname, '../dist/development'), id = 'pplpnpegpnghcddhmpgkbfkdfadjiaen';
test('a portable source backup restores disabled, requires account/root adoption, and future schema remains exportable', async () => {
  test.setTimeout(120000);
  const profile = await mkdtemp(resolve(tmpdir(), 'known-source-recovery-'));
  const context = await chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium', args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  context.setDefaultTimeout(20_000);
  const cors = { 'access-control-allow-origin': 'https://www.bilibili.com', 'access-control-allow-credentials': 'true' }; let modelCalls = 0;
  try {
    await context.route('https://provider.test/**', r => { modelCalls++; return r.abort(); });
    await context.route('https://www.bilibili.com/**', r => r.fulfill({ contentType: 'text/html', body: '<title>Source recovery fixture</title>' }));
    await context.route('https://api.bilibili.com/x/web-interface/nav', r => r.fulfill({ headers: cors, contentType: 'application/json', body: '{"code":0,"data":{"isLogin":true,"mid":42}}' }));
    await context.route('https://api.bilibili.com/x/v3/fav/folder/created/list-all*', r => r.fulfill({ headers: cors, contentType: 'application/json', body: '{"code":0,"data":{"list":[{"id":101,"title":"B"}]}}' }));
    const { page } = await openExtensionOptions(context), grants = { permissions: ['bookmarks', 'scripting', 'webNavigation'], origins: ['https://www.bilibili.com/*'] };
    await page.evaluate(g => { const b = document.createElement('button'); b.id = 'grant-recovery'; b.textContent = 'Grant source recovery access'; b.onclick = () => { void chrome.permissions.request(g); }; document.body.prepend(b); }, grants);
    await grantOptionalBookmarks(page, page.locator('#grant-recovery'), 'Known source recovery', grants);
    const file = resolve(profile, 'portable.json');
    await writeFile(file, JSON.stringify({ format: 'known-browser-backup', version: 1, exportedAt: 1, preferences: {}, language: 'en', defaultFolderSourceId: null, aiConfig: null, history: [],
      nodes: [{ sourceId: 'foreign-root', title: 'Restored source root', parentIndex: null }, { sourceId: 'foreign-folder', title: 'B', parentIndex: 0 },
        { sourceId: 'foreign-bookmark', title: 'Video 1', parentIndex: 1, url: 'https://www.bilibili.com/video/av1' }],
      siteAdapters: { version: 1, connections: [{ ref: 'foreign-connection', accountId: '42', identityVersion: 1, copies: 'sourceAndSemantic',
        mounts: [{ ref: 'foreign-mount', rootSourceId: 'foreign-root', aiDestination: 'excluded', folders: [{ collectionId: '101', nativeSourceId: 'foreign-folder', state: 'confirmed' }] }],
        associations: [{ itemId: 'video:av:1', collectionId: '101', mountRef: 'foreign-mount', purpose: 'sourceArchive', nativeSourceId: 'foreign-bookmark', state: 'active' }] }] } }));
    await page.goto(`chrome-extension://${id}/options.html#bookmarks`); await page.locator('#manager-import').click(); await page.locator('#local-import-file').setInputFiles(file);
    await page.locator('#local-import-commit').click(); await expect(page.locator('#local-import-status')).toContainText('Restored 4 items');
    const native = await page.evaluate(async () => ({ root: (await chrome.bookmarks.search({ title: 'Restored source root' }))[0]!, bookmarks: await chrome.bookmarks.search({ url: 'https://www.bilibili.com/video/av1' }) }));
    expect(native.bookmarks).toHaveLength(1);
    const site = await context.newPage(); await site.goto('https://www.bilibili.com/video/av1'); await page.goto(`chrome-extension://${id}/site-adapters.html#recovery`);
    await page.locator('#repair-status').click(); await expect(page.locator('#repair-summary')).toContainText('"state": "disabled"');
    await openSiteAdapterTab(page, 'sync'); await page.locator('#enable').click();
    await expect.poll(() => page.evaluate(async () => !!(await chrome.runtime.sendMessage({ kind: 'known.siteAdapters.status' }) as any).candidateAccount)).toBe(true);
    await page.locator('#refresh').click(); await page.locator('#confirm').click();
    await expect.poll(() => page.evaluate(async () => (await chrome.runtime.sendMessage({ kind: 'known.siteAdapters.status' }) as any).documents)).toBe(1);
    await expect(page.locator('#archive-collections input')).toHaveCount(1, { timeout: 30000 });
    await page.locator('#archive-root').click(); await page.locator(`#archive-root-picker [data-folder-id="${native.root.id}"]`).click();
    await page.locator('#archive-collections input[value="101"]').check();
    const live = page.locator('#archive-live');
    if (await live.getAttribute('aria-checked') === 'true') await live.click();
    await expect(live).toHaveAttribute('aria-checked', 'false');
    await page.locator('#configure-archive').click();
    await expect(page.locator('#status')).toContainText('"state": "active"');
    // A restored archive waits for rebinding: starting to sync brings nothing in yet.
    expect((await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.siteAdapters.status' })) as any).archive.import).toBeNull();
    const before = await page.evaluate(() => chrome.bookmarks.getTree());
    await openSiteAdapterTab(page, 'recovery'); await page.locator('#repair-status').click(); await page.getByRole('button', { name: 'Preview account and root rebinding' }).click();
    await expect(page.locator('#repair-summary')).toContainText('"review": []');
    await page.getByRole('button', { name: 'Adopt these proven copies (no native writes)' }).click();
    await expect(page.locator('#repair-summary')).toContainText('"adopted": 1');
    expect(await page.evaluate(() => chrome.bookmarks.getTree())).toEqual(before); expect(modelCalls).toBe(0);
    await openSiteAdapterConfiguration(page); await page.locator('#disable').click();
    await page.locator('#site-settings-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.evaluate(async () => { await new Promise<void>((resolve, reject) => { const r = indexedDB.open('known-site-adapters', 99);
      r.onupgradeneeded = () => { r.result.createObjectStore('future').put({ state: 'unknown', commandId: 'original-unknown-command' }, 'retained'); };
      r.onsuccess = () => { r.result.close(); resolve(); }; r.onerror = () => reject(r.error); }); });
    await page.locator('#refresh').click(); await expect(page.locator('#status')).toContainText('schemaIncompatible');
    await openSiteAdapterTab(page, 'recovery'); await page.locator('#repair-status').click(); await expect(page.locator('#repair-summary')).toContainText('"supportedSchema": false');
    await expect(page.locator('#repair-summary')).toContainText('replacement creates are blocked');
    const download = page.waitForEvent('download'); await page.locator('#repair-export').click(); const diagnosticFile = resolve(profile, 'diagnostic.json'); await (await download).saveAs(diagnosticFile);
    const diagnostic = JSON.parse(await readFile(diagnosticFile, 'utf8'));
    expect(diagnostic.schemaVersion).toBe(99); expect(diagnostic.stores.find((s: any) => s.name === 'future').records[0].value.commandId).toBe('original-unknown-command');
    expect(await page.evaluate(() => chrome.bookmarks.getTree())).toEqual(before);
    await test.info().attach('source-recovery.json', { body: Buffer.from(JSON.stringify({ fixture: true, realSite: false, browserVersion: context.browser()?.version(),
      restoredDisabled: true, explicitAccountRootAdoption: 1, adoptionNativeWrites: 0, modelCalls, futureSchema: diagnostic.schemaVersion, unknownPreservedAndVisible: true, exportReadOnly: true })), contentType: 'application/json' });
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
