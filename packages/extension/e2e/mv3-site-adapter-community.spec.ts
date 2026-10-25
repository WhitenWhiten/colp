import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, cp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openExtensionOptions } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';
const id = 'pplpnpegpnghcddhmpgkbfkdfadjiaen', origin = `chrome-extension://${id}`;
const community = (p: Page): Promise<any> => p.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.community.status' }));
async function stopWorker(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page), targets = await cdp.send('Target.getTargets');
  const worker = targets.targetInfos.find(t => t.type === 'service_worker' && t.url.includes(id));
  if (worker) await cdp.send('Target.closeTarget', { targetId: worker.targetId }); await cdp.detach();
}
function bundle(version: string) {
  return JSON.stringify({ manifest: { apiVersion: 'known.site-adapter/v1', adapterId: 'community.controlled', version, siteKey: 'bilibili', identityVersion: 1,
    matches: ['https://www.bilibili.com/*'], execution: { mode: 'userScript', entry: 'adapter.js', runAt: 'document_start' }, capabilities: ['observeFavorites'] },
  provenance: { maintainer: 'Controlled fixture author', sourceUrl: 'https://example.test/source', revision: 'local' },
  script: `const marker=document.createElement('meta');marker.name='colp-community-fixture';marker.content=${JSON.stringify(version)};document.head.append(marker);
globalThis.fixturePowers={bookmarks:typeof chrome.bookmarks,storage:typeof chrome.storage};
globalThis.fixtureReport=(aid,col)=>api.reportHint({interactionId:crypto.randomUUID(),itemId:'video:av:'+aid,added:[col],removed:[],code:0});
return ()=>marker.remove();` });
}
test('named user-script packages stay inert until consent, isolate powers, confirm scoped hints and fence surviving old scripts', async () => {
  test.setTimeout(150000);
  const directory = await mkdtemp(resolve(tmpdir(), 'colp-community-')), extension = resolve(directory, 'extension');
  await cp(resolve(import.meta.dirname, '../dist/development'), extension, { recursive: true });
  const context = await chromium.launchPersistentContext(resolve(directory, 'profile'), { headless: false, channel: 'chromium', ignoreDefaultArgs: ['--disable-back-forward-cache'],
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  context.setDefaultTimeout(15000);
  const cors = { 'access-control-allow-origin': 'https://www.bilibili.com', 'access-control-allow-credentials': 'true' }; let modelCalls = 0;
  try {
    await context.route('https://www.bilibili.com/**', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Community fixture</title><script>addEventListener("pageshow",e=>document.documentElement.dataset.persisted=String(e.persisted))</script>' }));
    await context.route('https://example.org/**', r => r.fulfill({ contentType: 'text/html', body: '<title>Other fixture</title>' }));
    await context.route('https://provider.test/**', r => { modelCalls++; return r.fulfill({ status: 500, body: '{}' }); });
    await context.route('https://api.bilibili.com/x/web-interface/nav', r => r.fulfill({ headers: cors, contentType: 'application/json', body: '{"code":0,"data":{"isLogin":true,"mid":42}}' }));
    await context.route('https://api.bilibili.com/x/v3/fav/folder/created/list-all*', r => r.fulfill({ headers: cors, contentType: 'application/json', body: '{"code":0,"data":{"list":[{"id":101,"title":"B"},{"id":102,"title":"C"}]}}' }));
    await context.route('https://api.bilibili.com/x/v3/fav/resource/ids*', r => r.fulfill({ headers: cors, contentType: 'application/json', body: '{"code":0,"data":[{"id":1,"type":2},{"id":2,"type":2}]}' }));
    await context.route('https://api.bilibili.com/x/v3/fav/resource/infos*', r => { const ids = new URL(r.request().url()).searchParams.get('resources')!.split(',').map(s => Number(s.split(':')[0]));
      return r.fulfill({ headers: cors, contentType: 'application/json', body: JSON.stringify({ code: 0, data: ids.map(id => ({ id, type: 2, title: `Video ${id}`, attr: 0 })) }) }); });
    let { page } = await openExtensionOptions(context);
    const grants = { permissions: ['bookmarks', 'scripting', 'webNavigation', 'userScripts'], origins: ['https://www.bilibili.com/*', 'https://provider.test/*'] };
    await page.evaluate(g => { const b = document.createElement('button'); b.id = 'grant-community'; b.textContent = 'Grant controlled community test'; b.onclick = () => { void chrome.permissions.request(g); }; document.body.prepend(b); }, grants);
    await grantOptionalBookmarks(page, page.locator('#grant-community'), 'Community fixture grant', grants);
    expect(await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.bookmark.preferences.update', captureMode: 'automatic', aiTagMode: 'add', userGesture: true }))).toMatchObject({ ok: true });
    const details = await context.newPage(); await details.goto(`chrome://extensions/?id=${id}`);
    const toggle = details.locator('extensions-toggle-row').filter({ hasText: 'Allow User Scripts' }).locator('cr-toggle');
    await expect(toggle).toHaveCount(1);
    if (!await toggle.evaluate(n => (n as any).checked)) await toggle.click();
    await expect.poll(() => toggle.evaluate(n => (n as any).checked)).toBe(true);
    await stopWorker(context, page);
    await page.goto(`${origin}/site-adapters.html`); await expect.poll(async () => (await community(page)).available).toBe(true);
    const root = await page.evaluate(async () => { const bar = (await chrome.bookmarks.getTree())[0]!.children![0]!;
      const root = await chrome.bookmarks.create({ parentId: bar.id, title: 'Community archive root' });
      await chrome.storage.local.set({ 'known.classification.local-enabled.v1': true,
        'known.classification.local-key.v1': { version: 3, generation: 'controlled', presetId: 'custom', endpoint: 'https://provider.test/v1/systemone', model: 'controlled', secret: 'fixture', disclosed: true } }); return root.id; });
    await page.reload(); // Populate the folder picker after creating the dedicated root.
    const site = await context.newPage(); await site.goto('https://www.bilibili.com/video/av1');
    await page.locator('#enable').click(); await expect.poll(() => page.evaluate(async () => !!(await chrome.runtime.sendMessage({ kind: 'known.siteAdapters.status' }) as any).candidateAccount)).toBe(true);
    await page.locator('#refresh').click(); await page.locator('#confirm').click();
    await expect.poll(() => page.evaluate(async () => (await chrome.runtime.sendMessage({ kind: 'known.siteAdapters.status' }) as any).documents)).toBe(1);
    // The page reads the collections on its own. Configure directly: the Sync tab's Start syncing would also start an import scan.
    await expect(page.locator('#archive-collections input')).toHaveCount(2, { timeout: 30000 });
    expect(await page.evaluate(rootNativeId => chrome.runtime.sendMessage({ kind: 'known.siteAdapters.archive.configure', rootNativeId, collectionIds: ['101'], live: true }), root)).not.toHaveProperty('error');
    await expect.poll(() => page.evaluate(async () => (await chrome.runtime.sendMessage({ kind: 'known.siteAdapters.status' }) as any).archive.config?.state)).toBe('active');
    await page.locator('#nav-packages').click();
    async function install(version: string) {
      const file = resolve(directory, `package-${version}.json`); await writeFile(file, bundle(version));
      await page.locator('#community-file').setInputFiles(file); await expect(page.locator('#community-preview')).toContainText(`"version": "${version}"`);
      await expect(page.locator('#community-install')).toBeDisabled(); await page.locator('#community-ack').check(); await page.locator('#community-install').click();
      await expect.poll(async () => (await community(page)).installations[0]?.manifest.version).toBe(version);
      expect((await community(page)).installations[0].enabled).toBe(false);
    }
    await install('1.0.0'); const original = (await community(page)).installations[0];
    expect(await site.locator('meta[name="colp-community-fixture"]').count()).toBe(0);
    await page.getByRole('button', { name: 'Enable inspector', exact: true }).click();
    await expect(site.locator('meta[name="colp-community-fixture"]')).toHaveAttribute('content', '1.0.0');
    await expect.poll(async () => (await community(page)).installations[0].documents).toBe(1);
    const currentWorld = async () => (await page.evaluate(() => chrome.userScripts.getScripts())).find(s => s.id.startsWith('colp-user-'))!.worldId!;
    async function run(code: string, worldId = undefined as string | undefined): Promise<any> {
      return page.evaluate(async ({ code, worldId }) => {
        const tab = (await chrome.tabs.query({ url: ['https://www.bilibili.com/*'] }))[0]!, frame = (await chrome.webNavigation.getFrame({ tabId: tab.id!, frameId: 0 }))!;
        const result = await chrome.userScripts.execute({ target: { tabId: tab.id!, documentIds: [frame.documentId] }, world: 'USER_SCRIPT', worldId: worldId!, js: [{ code }], injectImmediately: true });
        return result[0]?.error ? { error: result[0].error } : result[0]?.result;
      }, { code, worldId: worldId ?? await currentWorld() });
    }
    expect(await run('globalThis.fixturePowers')).toEqual({ bookmarks: 'undefined', storage: 'undefined' });
    expect(await site.evaluate(() => typeof (globalThis as any).__colpCommunity)).toBe('undefined');
    expect(await run('globalThis.fixtureReport(1,"101")')).toEqual({ status: 'inspected', writes: false, models: false });
    expect(await page.evaluate(root => chrome.bookmarks.getChildren(root), root)).toHaveLength(0);
    await page.getByRole('button', { name: 'Preview current archive scope for this package' }).click();
    await expect(page.locator('#community-status')).toContainText('Community archive root');
    await page.getByRole('button', { name: 'Allow verified hints for exactly this archive scope' }).click();
    await expect.poll(async () => !!(await community(page)).installations[0].archive).toBe(true);
    await expect.poll(async () => (await community(page)).installations[0].documents).toBe(1);
    expect(await run('globalThis.fixtureReport(1,"101")')).toMatchObject({ status: 'accepted' });
    await expect.poll(() => page.evaluate(() => chrome.bookmarks.search({ url: 'https://www.bilibili.com/video/av1' }).then(v => v.length)), { timeout: 45000 }).toBe(1);
    const captures = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.capture.list' })) as any;
    expect(captures.tasks.filter((t: any) => t.planned).map((t: any) => ({ classification: t.classification, automaticIntent: t.automaticIntent }))).toEqual([{ classification: 'none', automaticIntent: false }]);
    expect(await run('globalThis.fixtureReport(2,"102")')).toMatchObject({ status: 'rejected', reason: 'communityArchiveRevoked' });
    await run('globalThis.savedReport=globalThis.fixtureReport;true');
    await site.evaluate(() => history.pushState({}, '', '/video/av2')); await expect(site).toHaveURL('https://www.bilibili.com/video/av2');
    await expect.poll(async () => (await community(page)).installations[0].documents).toBe(1);
    expect(await run('(async()=>{try{return await globalThis.savedReport(2,"101")}catch(e){return {error:e.message}}})()')).toMatchObject({ error: 'communityRevoked' });
    await site.goto('https://example.org/away'); await site.evaluate(() => history.back()); await expect(site).toHaveURL('https://www.bilibili.com/video/av2');
    await expect(site.locator('html')).toHaveAttribute('data-persisted', 'true'); await expect.poll(async () => (await community(page)).installations[0].documents).toBe(1);
    const old = await page.evaluate(async () => { const r = (await chrome.storage.local.get('known.siteAdapters.community.v1'))['known.siteAdapters.community.v1'] as any;
      const installation = r.installations[0], lease = installation.leases[0]; return { generation: installation.generation, id: installation.id, world: `colp-user-${installation.id}-${installation.generation}`,
        message: { kind: 'known.community.hint', installationId: installation.id, generation: installation.generation, leaseId: lease.id, capability: lease.capability, requestId: 'surviving-old-script', hint: { interactionId: 'old', itemId: 'video:av:2', added: ['101'], removed: [], code: 0 } } }; });
    await install('2.0.0');
    // Simulate best-effort cleanup failure: old world retains messaging, but the host generation fence must still reject it.
    await page.evaluate(worldId => chrome.userScripts.configureWorld({ worldId, messaging: true }), old.world);
    expect(await run(`chrome.runtime.sendMessage(${JSON.stringify(old.message)})`, old.world)).toMatchObject({ status: 'rejected', reason: 'communityRevoked' });
    await page.getByRole('button', { name: 'Review rollback to 1.0.0' }).click(); await page.locator('#community-ack').check(); await page.locator('#community-install').click();
    await expect.poll(async () => (await community(page)).installations[0].digest).toBe(original.digest);
    await page.getByRole('button', { name: 'Enable inspector', exact: true }).click(); await expect.poll(async () => (await community(page)).installations[0].documents).toBe(1);
    await details.bringToFront(); await toggle.click(); await expect.poll(() => toggle.evaluate(n => (n as any).checked)).toBe(false);
    await expect.poll(async () => (await community(page)).unavailable).toBe('communityToggleRequired');
    expect((await community(page)).installations[0].enabled).toBe(false);
    await toggle.click(); await stopWorker(context, page); await expect.poll(async () => (await community(page)).available).toBe(true);
    await page.locator('#community-refresh').click(); await page.getByRole('button', { name: 'Enable inspector', exact: true }).click();
    const beforeUpdate = (await community(page)).installations[0].generation;
    // Reloading the unpacked development artifact requires Developer mode. The userScripts toggle tests above ran independently with it off.
    const developerMode = details.locator('extensions-toolbar cr-toggle');
    if (!await developerMode.evaluate(n => (n as any).checked)) await developerMode.click();
    await expect.poll(() => developerMode.evaluate(n => (n as any).checked)).toBe(true);
    const manifestFile = resolve(extension, 'manifest.json'), manifest = JSON.parse(await readFile(manifestFile, 'utf8')); manifest.version = '0.1.3'; await writeFile(manifestFile, JSON.stringify(manifest));
    await page.evaluate(() => chrome.runtime.reload()).catch(() => undefined);
    page = await context.newPage();
    await expect.poll(async () => { try { await page.goto(`${origin}/site-adapters.html`); return await page.evaluate(() => chrome.runtime.getManifest().version); } catch { return null; } }, { timeout: 15000 }).toBe('0.1.3');
    await expect.poll(async () => (await community(page)).installations[0].generation).toBeGreaterThan(beforeUpdate);
    await expect.poll(() => page.evaluate(() => chrome.runtime.getManifest().version)).toBe('0.1.3');
    expect((await community(page)).installations[0].archive).toBeNull();
    expect(await page.evaluate(() => chrome.bookmarks.search({ url: 'https://www.bilibili.com/video/av1' }))).toHaveLength(1);
    expect(await page.evaluate(() => chrome.bookmarks.search({ url: 'https://www.bilibili.com/video/av2' }))).toHaveLength(0); expect(modelCalls).toBe(0);
    await test.info().attach('community-acceptance.json', { body: Buffer.from(JSON.stringify({ fixture: true, realSite: false, browserVersion: context.browser()?.version(), namedUserScriptWorld: true,
      inertBeforeConsent: true, immediateExecutionOnOpenPage: true, privateStorageAndBookmarksUnavailable: true, scopedFreshReadArchiveBookmarks: 1, outOfScopeBookmarks: 0,
      spaOldCallbackRejected: true, bfcache: true, survivingOldWorldRejected: true, explicitRollback: true, actualBrowserToggleRevocation: true, actualExtensionVersionUpdate: '0.1.3',
      userScriptToggleTestDeveloperMode: false, unpackedUpdateDeveloperMode: true, archiveGrantAfterUpdate: null, modelCalls })), contentType: 'application/json' });
  } finally { await context.close(); await rm(directory, { recursive: true, force: true }); }
});
