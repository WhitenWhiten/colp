import { test, expect, chromium, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openExtensionOptions } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { capturePopupTarget } from './capture-popup-cdp.js';
const extensionPath = resolve(import.meta.dirname, '../dist/development'), id = 'pplpnpegpnghcddhmpgkbfkdfadjiaen';
const state = (p: Page): Promise<any> => p.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.siteAdapters.status' }));
const copies = (p: Page, aid: number): Promise<any[]> => p.evaluate(n => chrome.bookmarks.search({ url: `https://www.bilibili.com/video/av${n}` }), aid);
async function saved(p: Page, captureId: string): Promise<any> {
  await expect.poll(async () => (await p.evaluate(c => chrome.runtime.sendMessage({ kind: 'known.capture.get', captureId: c }), captureId) as any).task.save).toBe('local-saved');
  return (await p.evaluate(c => chrome.runtime.sendMessage({ kind: 'known.capture.get', captureId: c }), captureId) as any).task;
}
test('both action orders follow all copy policies; a real toolbar semantic intent uses JEV outside the source mount', async () => {
  test.setTimeout(300000);
  const profile = await mkdtemp(resolve(tmpdir(), 'known-site-semantic-'));
  const context = await chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium', args: ['--remote-debugging-port=0',
    `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
  let modelCalls = 0, providerFails = false; let heldResponse: Promise<void> | null = null, releaseHeld: (() => void) | undefined; const members: number[] = [], modelBodies: string[] = [];
  const cors = { 'access-control-allow-origin': 'https://www.bilibili.com', 'access-control-allow-credentials': 'true' };
  try {
    await context.route('https://www.bilibili.com/**', r => r.fulfill({ contentType: 'text/html', body: '<title>Controlled semantic source</title>' }));
    await context.route('https://api.bilibili.com/x/web-interface/nav', r => r.fulfill({ headers: cors, contentType: 'application/json', body: JSON.stringify({ code: 0, data: { isLogin: true, mid: 42 } }) }));
    await context.route('https://api.bilibili.com/x/web-interface/view*', r => r.fulfill({ headers: cors, contentType: 'application/json', body: JSON.stringify({ code: 0, data: { aid: 8, bvid: 'BV1xx411c7mD', title: 'Video 8', state: 0 } }) }));
    await context.route('https://api.bilibili.com/x/v3/fav/folder/created/list-all*', r => r.fulfill({ headers: cors, contentType: 'application/json', body: JSON.stringify({ code: 0, data: { list: [{ id: 101, title: 'Source collection' }] } }) }));
    await context.route('https://api.bilibili.com/x/v3/fav/resource/ids*', r => r.fulfill({ headers: cors, contentType: 'application/json', body: JSON.stringify({ code: 0, data: members.map(id => ({ id, type: 2 })) }) }));
    await context.route('https://api.bilibili.com/x/v3/fav/resource/infos*', r => { const ids = new URL(r.request().url()).searchParams.get('resources')!.split(',').map(s => Number(s.split(':')[0]));
      return r.fulfill({ headers: cors, contentType: 'application/json', body: JSON.stringify({ code: 0, data: ids.map(id => ({ id, type: 2, title: `Video ${id}`, attr: 0 })) }) }); });
    await context.route('https://api.bilibili.com/x/v3/fav/resource/deal', r => { const aid = Number(new URLSearchParams(r.request().postData()!).get('rid')); members.push(aid);
      return r.fulfill({ headers: cors, contentType: 'application/json', body: '{"code":0}' }); });
    await context.route('https://provider.test/**', async r => {
      modelCalls++; const body = r.request().postDataJSON(); modelBodies.push(JSON.stringify(body));
      if (heldResponse) await heldResponse;
      if (providerFails) return r.fulfill({ status: 503, body: '{}' });
      const answers = Object.fromEntries(Object.entries(body.questions as Record<string, { type: string; criteria: Record<string, string> }>).map(([name, q]) => {
        const keys = Object.keys(q.criteria), choice = keys.find(k => q.criteria[k]!.includes('Semantic')) ?? keys[0];
        return [name, q.type === 'noul' ? { noul: 0.99 } : { choice, confidence: 1, probabilities: Object.fromEntries(keys.map(k => [k, k === choice ? 1 : 0])) }];
      }));
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ model: 'controlled', answers }) });
    });
    const { page } = await openExtensionOptions(context), grants = { permissions: ['bookmarks', 'scripting', 'webNavigation'], origins: ['https://www.bilibili.com/*', 'https://provider.test/*'] };
    await page.evaluate(g => { const b = document.createElement('button'); b.id = 'grant-semantic'; b.textContent = 'Grant controlled semantic access'; b.onclick = () => { void chrome.permissions.request(g); }; document.body.prepend(b); }, grants);
    await grantOptionalBookmarks(page, page.locator('#grant-semantic'), 'Known semantic test', grants);
    const roots = await page.evaluate(async () => { const parentId = (await chrome.bookmarks.getTree())[0]!.children![0]!.id;
      const archive = await chrome.bookmarks.create({ parentId, title: 'Excluded source mount' }), semantic = await chrome.bookmarks.create({ parentId, title: 'Semantic' });
      await chrome.storage.local.set({ 'known.sync.folder.v1': { collectionId: 'device', folderNativeId: semantic.id }, 'known.classification.local-enabled.v1': true,
        'known.classification.local-key.v1': { version: 3, generation: 'controlled', presetId: 'custom', endpoint: 'https://provider.test/v1/systemone', model: 'controlled', secret: 'fixture', disclosed: true } });
      return { archive: archive.id, semantic: semantic.id }; });
    expect(await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.bookmark.preferences.update', captureMode: 'automatic', aiTagMode: 'off', resultPanelAutoDismissMs: 0, userGesture: true }))).toMatchObject({ ok: true });
    const site = await context.newPage(); await site.goto('https://www.bilibili.com/video/av1');
    await page.goto(`chrome-extension://${id}/site-adapters.html`); await page.locator('#enable').click();
    await expect.poll(async () => !!(await state(page)).candidateAccount).toBe(true); await page.locator('#refresh').click(); await page.locator('#confirm').click();
    await expect.poll(async () => (await state(page)).documents).toBe(1); await page.locator('#read-catalog').click(); await expect(page.locator('#archive-collections option')).toHaveCount(1);
    async function configure(policy: string) {
      await expect.poll(async () => (await state(page)).documents).toBe(1);
      const previous = (await state(page)).inspection?.command?.pageRequestId;
      await page.locator('#read-catalog').click();
      await expect.poll(async () => { const s = await state(page); return s.inspection?.command?.pageRequestId !== previous && s.inspection?.result?.kind === 'collections'; }, { timeout: 45000 }).toBe(true);
      const result = await page.evaluate(async ({ roots, policy }) => chrome.runtime.sendMessage({ kind: 'known.siteAdapters.archive.configure', rootNativeId: roots.archive,
        collectionIds: ['101'], live: true, copies: policy, aiDestination: 'excluded' }), { roots, policy }); expect(result).not.toHaveProperty('error');
    }
    async function favorite(aid: number) {
      await site.evaluate(n => fetch('https://api.bilibili.com/x/v3/fav/resource/deal', { method: 'POST', body: new URLSearchParams({ rid: String(n), type: '2', add_media_ids: '101' }) }), aid);
      await expect.poll(async () => (await state(page)).confirmations.pending, { timeout: 30000 }).toBe(0);
      await expect.poll(async () => (await copies(page, aid)).length, { timeout: 30000 }).toBeGreaterThan(0);
    }
    async function semantic(aid: number, explicit = false) {
      const reply = await page.evaluate(async ({ aid, target, explicit }) => chrome.runtime.sendMessage({ kind: 'known.capture.start', trigger: 'manual-popup', userGesture: true,
        commandId: crypto.randomUUID(), title: `Video ${aid}`, url: `https://www.bilibili.com/video/av${aid}`, parentNativeId: target, folderChoice: explicit ? 'explicit' : 'default', saveAnother: false, allowUnverifiedCloud: true }), { aid, target: roots.semantic, explicit });
      expect(reply).toMatchObject({ ok: true }); return saved(page, (reply as any).task.captureId);
    }
    const evidence: any[] = []; let aid = 0, keepTask: any;
    for (const policy of ['sourceAndSemantic', 'singlePreferSemantic', 'singleKeepExisting']) {
      await configure(policy); const first = ++aid; await favorite(first);
      const before = modelCalls;
      if (policy === 'singlePreferSemantic') {
        await site.goto(`https://www.bilibili.com/video/av${first}`); await expect.poll(async () => (await state(page)).documents).toBe(1);
        const popup = await capturePopupTarget(context, profile, site);
        await expect.poll(async () => (await copies(page, first)).map(n => n.parentId), { timeout: 30000 }).toEqual([roots.semantic]);
        expect(modelCalls).toBeGreaterThan(before); await popup.evaluate('window.close()').catch(() => undefined);
        // Navigation changed the document-scoped catalog; refresh before later configuration.
        await page.bringToFront();
      } else {
        const task = await semantic(first); expect(task.contentIntent.mode).toBe(policy === 'sourceAndSemantic' ? 'create' : 'suggest');
        expect(modelCalls).toBe(before); if (policy === 'singleKeepExisting') keepTask = task;
      }
      await expect.poll(async () => (await copies(page, first)).length).toBe(policy === 'sourceAndSemantic' ? 2 : 1);
      const second = ++aid; await semantic(second, true); await favorite(second);
      await expect.poll(async () => (await copies(page, second)).length, { timeout: 30000 }).toBe(policy === 'sourceAndSemantic' ? 2 : 1);
      if (policy !== 'sourceAndSemantic') expect((await copies(page, second))[0]!.parentId).toBe(roots.semantic);
      evidence.push({ policy, sourceFirstCopies: (await copies(page, first)).length, semanticFirstCopies: (await copies(page, second)).length });
    }
    const panel = await context.newPage(); await panel.goto(`chrome-extension://${id}/popup.html?resumeOnly=${keepTask.captureId}&surface=${crypto.randomUUID()}`);
    await expect(panel.locator('#folder-suggest')).toBeVisible(); const explicitBefore = modelCalls;
    await panel.locator('#folder-suggest').click();
    await expect(panel.locator('#folder-suggest')).toHaveAttribute('data-state', 'apply');
    expect((await copies(page, 5))[0]!.parentId).not.toBe(roots.semantic);
    await panel.locator('#folder-suggest').click();
    await expect.poll(async () => (await copies(page, 5)).map(n => n.parentId), { timeout: 20000 }).toEqual([roots.semantic]);
    expect(modelCalls).toBeGreaterThan(explicitBefore); await panel.close();
    await configure('sourceAndSemantic'); const failureAid = ++aid; await favorite(failureAid);
    const originalArchive = (await copies(page, failureAid))[0]; providerFails = true;
    await site.goto(`https://www.bilibili.com/video/av${failureAid}`); await expect.poll(async () => (await state(page)).documents).toBe(1);
    const failurePopup = await capturePopupTarget(context, profile, site);
    await expect.poll(async () => {
      const r = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.capture.list' })) as any;
      return r.tasks.find((t: any) => t.source === 'action-popup' && t.url.endsWith(`/av${failureAid}`))?.classification;
    }, { timeout: 25000 }).toBe('manual');
    expect(await copies(page, failureAid)).toHaveLength(2);
    expect((await copies(page, failureAid)).find(n => n.id === originalArchive.id)?.parentId).toBe(originalArchive.parentId);
    await failurePopup.evaluate('window.close()').catch(() => undefined);
    providerFails = false; await site.goto('https://www.bilibili.com/video/BV1xx411c7mD/?tracking=fixture');
    await expect.poll(async () => (await state(page)).documents).toBe(1);
    const bvPopup = await capturePopupTarget(context, profile, site);
    await expect.poll(async () => {
      const r = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.capture.list' })) as any;
      return r.tasks.find((t: any) => t.source === 'action-popup' && t.url.includes('/BV1xx411c7mD'))?.contentIntent?.itemId;
    }, { timeout: 45000 }).toBe('video:av:8');
    await expect.poll(() => page.evaluate(() => chrome.bookmarks.search({ url: 'https://www.bilibili.com/video/BV1xx411c7mD/?tracking=fixture' }).then(rows => rows.length))).toBe(1);
    await bvPopup.evaluate('window.close()').catch(() => undefined); await favorite(8);
    expect(await copies(page, 8)).toHaveLength(1);
    const manualCalls = modelCalls;
    const manual = await page.evaluate(async target => chrome.runtime.sendMessage({ kind: 'known.capture.start', trigger: 'manual-popup', userGesture: true,
      commandId: crypto.randomUUID(), title: 'Manual mount selection', url: 'https://www.bilibili.com/video/av9', parentNativeId: target, folderChoice: 'explicit', saveAnother: false, allowUnverifiedCloud: true }), roots.archive) as any;
    expect(manual.ok).toBe(true); await saved(page, manual.task.captureId); expect((await copies(page, 9))[0]!.parentId).toBe(roots.archive); expect(modelCalls).toBe(manualCalls);
    await configure('singlePreferSemantic'); await favorite(10); const guardedArchive = (await copies(page, 10))[0];
    heldResponse = new Promise<void>(resolve => { releaseHeld = resolve; }); const guardedCalls = modelCalls;
    await site.goto('https://www.bilibili.com/video/av10'); await expect.poll(async () => (await state(page)).documents).toBe(1);
    const guardedPopup = await capturePopupTarget(context, profile, site); await expect.poll(() => modelCalls).toBeGreaterThan(guardedCalls);
    await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.siteAdapters.archive.disable' })); releaseHeld!(); heldResponse = null;
    await expect.poll(async () => { const r = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.capture.list' })) as any;
      return r.tasks.find((t: any) => t.source === 'action-popup' && t.url.endsWith('/av10'))?.classification;
    }).toBe('manual');
    expect(await copies(page, 10)).toHaveLength(1); expect((await copies(page, 10))[0]!.parentId).toBe(guardedArchive.parentId);
    await guardedPopup.evaluate('window.close()').catch(() => undefined);
    expect(modelBodies.every(b => !b.includes('Excluded source mount') && !b.includes('Source collection'))).toBe(true);
    await test.info().attach('semantic-copy-acceptance.json', { contentType: 'application/json', body: Buffer.from(JSON.stringify({ fixture: true, realSite: false,
      observedAt: new Date().toISOString(), browserVersion: context.browser()?.version(), policies: evidence, modelCalls, sourceSubtreeAndExamplesExcluded: true, toolbarSemanticIntent: true, explicitExistingCopyClassification: true, providerFailureRetainsArchiveAndSemanticCopy: true, popupBvResolvedInCurrentDocument: true, explicitMountedFolderSelection: true, revocationRejectsLateSemanticMove: true }, null, 2)) });
  } finally { releaseHeld?.(); await context.close(); await rm(profile, { recursive: true, force: true }); }
});
