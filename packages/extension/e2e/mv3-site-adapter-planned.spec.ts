import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openExtensionOptions } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';
const extensionPath = resolve(import.meta.dirname, '../dist/development');
const extensionId = 'pplpnpegpnghcddhmpgkbfkdfadjiaen';
async function call<T = any>(page: Page, request: Record<string, unknown>): Promise<T> {
  const result = await page.evaluate(r => chrome.runtime.sendMessage({ kind: 'known.siteAdapters.evidence', ...r }), request) as T;
  if ((result as any)?.status === 'error') throw new Error((result as any).reason); return result;
}
async function stopWorker(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page); const targets = await cdp.send('Target.getTargets');
  const target = targets.targetInfos.find(t => t.type === 'service_worker' && t.url.includes(extensionId));
  expect(target).toBeTruthy(); await cdp.send('Target.closeTarget', { targetId: target!.targetId }); await cdp.detach();
}
test('planned native commands survive worker cuts or expose unknown without replacement or model calls', async () => {
  test.setTimeout(120000);
  const profile = await mkdtemp(resolve(tmpdir(), 'known-site-planned-'));
  const context = await chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium', args: [
    `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
  ] });
  let modelCalls = 0;
  const cuts: { point: string; resumedStatus: string; folders: number; bookmarks: number }[] = [];
  try {
    await context.route('https://provider.test/**', route => { modelCalls++; return route.fulfill({ status: 500, body: '{}' }); });
    await context.route('https://www.bilibili.com/**', route => route.fulfill({ contentType: 'text/html', body: '<title>Controlled source</title>' }));
    await context.route('https://api.bilibili.com/x/web-interface/nav', route => route.fulfill({ contentType: 'application/json',
      headers: { 'access-control-allow-origin': 'https://www.bilibili.com', 'access-control-allow-credentials': 'true' }, body: JSON.stringify({ code: 0, data: { isLogin: true, mid: 42 } }) }));
    const { page } = await openExtensionOptions(context);
    const grants = { permissions: ['bookmarks', 'scripting', 'webNavigation'], origins: ['https://www.bilibili.com/*', 'https://provider.test/*'] };
    await page.evaluate(grants => { const button = document.createElement('button'); button.id = 'grant-planned-test'; button.textContent = 'Grant controlled adapter test access';
      button.addEventListener('click', () => { void chrome.permissions.request(grants); }); document.body.prepend(button); }, grants);
    await grantOptionalBookmarks(page, page.locator('#grant-planned-test'), 'Known planned adapter test', grants);
    expect(await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.bookmark.preferences.update', captureMode: 'automatic', aiTagMode: 'add', userGesture: true }))).toMatchObject({ ok: true, preferences: { captureMode: 'automatic' } });
    await page.evaluate(() => chrome.storage.local.set({ 'known.classification.local-enabled.v1': true,
      'known.classification.local-key.v1': { version: 3, generation: 'controlled', presetId: 'custom', endpoint: 'https://provider.test/v1/chat/completions', model: 'controlled', secret: 'controlled-value', disclosed: true } }));
    const site = await context.newPage(); await site.goto('https://www.bilibili.com/video/av1');
    await page.goto(`chrome-extension://${extensionId}/site-adapters.html`); await page.locator('#enable').click();
    await expect.poll(() => page.evaluate(async () => { const s = await chrome.runtime.sendMessage({ kind: 'known.siteAdapters.status' }) as { candidateAccount?: string }; return !!s.candidateAccount; })).toBe(true);
    await page.locator('#refresh').click(); await page.locator('#confirm').click();
    await expect.poll(() => page.evaluate(async () => (await chrome.runtime.sendMessage({ kind: 'known.siteAdapters.status' }) as { documents: number }).documents)).toBe(1);
    for (const point of ['beforeNativeSubmit', 'afterNativeReceipt', 'afterFolderCreate', 'afterBookmarkCreate']) {
      const root = await page.evaluate(async title => { const bar = (await chrome.bookmarks.getTree())[0]!.children![0]!;
        return chrome.bookmarks.create({ parentId: bar.id, title }); }, `Controlled ${point}`);
      const prepared = await call<{ planId: string; folderCommandId: string; bookmarkCommandId: string }>(page, { operation: 'prepare', rootNativeId: root.id });
      const bookmarkFault = point === 'afterNativeReceipt' || point === 'afterBookmarkCreate', effectId = bookmarkFault ? 'bookmark' : 'folder';
      if (bookmarkFault) expect(await call(page, { operation: 'execute', planId: prepared.planId, effectId: 'folder' })).toMatchObject({ status: 'confirmed' });
      await call(page, { operation: 'fault', commandId: bookmarkFault ? prepared.bookmarkCommandId : prepared.folderCommandId, point });
      const pending = call(page, { operation: 'execute', planId: prepared.planId, effectId }).catch(() => undefined);
      await expect.poll(async () => (await call<any>(page, { operation: 'status', planId: prepared.planId })).reached?.point).toBe(point);
      await stopWorker(context, page); await pending;
      const resumed = await call<any>(page, { operation: 'execute', planId: prepared.planId, effectId });
      expect(resumed.status).toBe(point === 'afterFolderCreate' || point === 'afterBookmarkCreate' ? 'unknown' : 'confirmed');
      expect(await call(page, { operation: 'execute', planId: prepared.planId, effectId })).toMatchObject({ status: resumed.status });
      const folders = await page.evaluate(id => chrome.bookmarks.getChildren(id), root.id); expect(folders).toHaveLength(1);
      const bookmarks = await page.evaluate(id => chrome.bookmarks.getChildren(id), folders[0]!.id);
      expect(bookmarks).toHaveLength(bookmarkFault ? 1 : 0);
      cuts.push({ point, resumedStatus: resumed.status, folders: folders.length, bookmarks: bookmarks.length });
      if (point === 'beforeNativeSubmit') {
        expect(await call(page, { operation: 'execute', planId: prepared.planId, effectId: 'bookmark' })).toMatchObject({ status: 'confirmed' });
        expect(await page.evaluate(id => chrome.bookmarks.getChildren(id), folders[0]!.id)).toHaveLength(1);
      }
    }
    const layoutRoot = await page.evaluate(async () => { const bar = (await chrome.bookmarks.getTree())[0]!.children![0]!;
      return chrome.bookmarks.create({ parentId: bar.id, title: 'Controlled rule layout' }); });
    const layout = await call<{ planId: string }>(page, { operation: 'layout', rootNativeId: layoutRoot.id, scenario: 'initial' });
    expect(await call(page, { operation: 'execute', planId: layout.planId, effectId: 'folder' })).toMatchObject({ status: 'confirmed' });
    expect(await call(page, { operation: 'execute', planId: layout.planId, effectId: 'bookmark' })).toMatchObject({ status: 'confirmed' });
    const layoutFolders = await page.evaluate(id => chrome.bookmarks.getChildren(id), layoutRoot.id);
    expect(layoutFolders).toHaveLength(1);
    const later = await call<{ planId: string }>(page, { operation: 'layout', rootNativeId: layoutRoot.id, scenario: 'later' });
    await page.evaluate(id => chrome.bookmarks.update(id, { title: 'User renamed source folder' }), layoutFolders[0]!.id);
    // The shared folder command may acknowledge its old receipt; it issues no mutation.
    expect(await call(page, { operation: 'execute', planId: later.planId, effectId: 'folder' })).toMatchObject({ status: 'confirmed' });
    const stopped = await call<any>(page, { operation: 'execute', planId: later.planId, effectId: 'bookmark' });
    expect(stopped.status).toBe('blocked');
    expect(['folderManuallyChanged', 'folderNeedsReview']).toContain(stopped.reason);
    expect(await page.evaluate(id => chrome.bookmarks.getChildren(id), layoutFolders[0]!.id)).toHaveLength(1);
    expect(modelCalls).toBe(0);
    await page.locator('#repair-status').click();
    await expect(page.locator('#repair-summary')).toContainText('replacement creates are blocked');
    await expect(page.locator('#repair-summary')).toContainText('"state": "unknown"');
    await test.info().attach('source-planned-acceptance.json', { body: Buffer.from(JSON.stringify({ schemaVersion: 1, observedAt: new Date().toISOString(),
      browser: await page.evaluate(() => navigator.userAgent), browserVersion: context.browser()?.version(), workerTermination: 'CDP Target.closeTarget', sourceWorld: 'ISOLATED', cuts, modelCalls,
      automaticSaving: true, tagMode: 'add', ruleLayout: { createdFolders: 1, createdBookmarks: 1, localRenameStopsPending: stopped.status }, fixture: true, realSite: false }, null, 2)), contentType: 'application/json' });
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
