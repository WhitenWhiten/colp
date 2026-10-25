import { test, expect, chromium, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openExtensionOptions } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';
const extension = resolve(import.meta.dirname, '../dist/development'), origin = 'chrome-extension://pplpnpegpnghcddhmpgkbfkdfadjiaen';
const status = (page: Page): Promise<any> => page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.siteAdapters.status' }));
test('rechecking preserves user order, pins and titles, links candidates, restores selected deletions and moves only selected personal items', async () => {
  test.setTimeout(300000); const profile = await mkdtemp(resolve(tmpdir(), 'known-reconcile-'));
  const context = await chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium', args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  let members = [1, 2, 5, 7];
  const cors = { 'access-control-allow-origin': 'https://www.bilibili.com', 'access-control-allow-credentials': 'true' };
  try {
    await context.route('https://www.bilibili.com/**', r => r.fulfill({ contentType: 'text/html', body: '<title>Reconcile fixture</title>' }));
    await context.route('https://api.bilibili.com/x/web-interface/nav', r => r.fulfill({ headers: cors, contentType: 'application/json', body: '{"code":0,"data":{"isLogin":true,"mid":42}}' }));
    await context.route('https://api.bilibili.com/x/v3/fav/folder/created/list-all*', r => r.fulfill({ headers: cors, contentType: 'application/json', body: '{"code":0,"data":{"list":[{"id":101,"title":"Source collection"}]}}' }));
    await context.route('https://api.bilibili.com/x/v3/fav/resource/ids*', r => r.fulfill({ headers: cors, contentType: 'application/json', body: JSON.stringify({ code: 0,
      data: new URL(r.request().url()).searchParams.get('pn') === '1' ? members.map(id => ({ id, type: 2 })) : [] }) }));
    await context.route('https://api.bilibili.com/x/v3/fav/resource/infos*', r => {
      const ids = new URL(r.request().url()).searchParams.get('resources')!.split(',').map(s => Number(s.split(':')[0]));
      return r.fulfill({ headers: cors, contentType: 'application/json', body: JSON.stringify({ code: 0, data: ids.map(id => ({ id, type: 2, attr: 1, title: `Video ${id}` })) }) });
    });
    const { page } = await openExtensionOptions(context), grants = { permissions: ['bookmarks', 'scripting', 'webNavigation'], origins: ['https://www.bilibili.com/*'] };
    await page.evaluate(g => { const b = document.createElement('button'); b.id = 'grant-reconcile'; b.textContent = 'Grant reconcile fixture'; b.onclick = () => { void chrome.permissions.request(g); }; document.body.prepend(b); }, grants);
    await grantOptionalBookmarks(page, page.locator('#grant-reconcile'), 'Known reconcile fixture', grants);
    const roots = await page.evaluate(async () => ({ source: (await chrome.bookmarks.create({ parentId: '2', title: 'Website copies' })).id,
      history: (await chrome.bookmarks.create({ parentId: '2', title: 'Retained personal items' })).id }));
    const site = await context.newPage(); await site.goto('https://www.bilibili.com/video/av1');
    await page.goto(`${origin}/site-adapters.html`); await page.locator('#enable').click();
    await expect.poll(async () => (await status(page)).candidateAccount).toBe('42'); await page.locator('#refresh').click(); await page.locator('#confirm').click();
    await expect(page.locator('#archive-collections input')).toHaveCount(1, { timeout: 30000 }); await page.locator('#archive-collections input').check();
    await page.locator('#archive-root').click(); await page.locator(`#archive-root-picker [data-folder-id="${roots.source}"]`).click(); await page.locator('#configure-archive').click();
    await expect.poll(async () => (await status(page)).archive.import?.phase, { timeout: 60000 }).toBe('preview'); await page.locator('#approve-import').click();
    await expect.poll(async () => (await status(page)).archive.import?.phase, { timeout: 45000 }).toBe('completed');
    const before = await page.evaluate(async id => {
      const folder = (await chrome.bookmarks.getChildren(id)).find(n => n.title === 'Source collection')!;
      const children = await chrome.bookmarks.getChildren(folder.id); return { folder: folder.id, children };
    }, roots.source);
    const one = before.children.find(n => n.url?.endsWith('/av1'))!, five = before.children.find(n => n.url?.endsWith('/av5'))!;
    const two = before.children.find(n => n.url?.endsWith('/av2'))!, seven = before.children.find(n => n.url?.endsWith('/av7'))!;
    expect(await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.bookmark.preferences.update', userGesture: true, bookmarkInsertPosition: 'top', foldersFirst: true }))).toMatchObject({ ok: true });
    expect(await page.evaluate(id => chrome.runtime.sendMessage({ kind: 'known.bookmarks.pin.set', userGesture: true, nativeId: id, pinned: true }), one.id)).toMatchObject({ ok: true });
    expect(await page.evaluate(id => chrome.runtime.sendMessage({ kind: 'known.bookmarks.pin.set', userGesture: true, nativeId: id, pinned: true }), five.id)).toMatchObject({ ok: true });
    await page.evaluate(async id => chrome.bookmarks.move(id, { index: 2 }), seven.id);
    const personal = await page.evaluate(async ({ folder, id, deleted }) => {
      await chrome.bookmarks.update(folder, { title: 'My collection name' }); await chrome.bookmarks.update(id, { title: 'My video title' }); await chrome.bookmarks.remove(deleted);
      await chrome.bookmarks.create({ parentId: folder, title: 'Existing video 3', url: 'https://www.bilibili.com/video/av3' });
      return (await chrome.bookmarks.create({ parentId: folder, title: 'Personal item', url: 'https://personal.test/' })).id;
    }, { folder: before.folder, id: one.id, deleted: five.id });
    members = [1, 3, 4, 5]; await page.locator('#refresh').click(); await page.locator('#start-import').click();
    await expect.poll(async () => (await status(page)).archive.import?.phase, { timeout: 90000 }).toBe('preview');
    const differences = (await status(page)).archive.reconciliation.differences as any[];
    expect(differences.some(d => d.kind === 'unverified' && d.itemId === 'video:av:2')).toBe(true);
    expect(differences.some(d => d.kind === 'candidate' && d.itemId === 'video:av:3')).toBe(true);
    expect(differences.some(d => d.kind === 'localDeleted' && d.itemId === 'video:av:5')).toBe(true);
    for (const [kind, choice] of [['candidate', 'adopt'], ['localDeleted', 'restore'], ['personal', 'move']] as const) {
      const difference = differences.find(d => d.kind === kind && (kind !== 'personal' || d.native?.nativeId === personal));
      await expect.poll(() => page.locator('#reconcile-list select[data-difference-id]').evaluateAll((nodes, id) => nodes.some(n => (n as HTMLSelectElement).dataset.differenceId === id), difference.id)).toBe(true);
      await page.locator('#reconcile-list select[data-difference-id]').evaluateAll((nodes, input) => {
        const select = nodes.find(n => (n as HTMLSelectElement).dataset.differenceId === input.id) as HTMLSelectElement; select.value = input.choice; select.dispatchEvent(new Event('change'));
      }, { id: difference.id, choice });
    }
    await page.locator('#reconcile-target').click(); await page.locator(`#reconcile-target-slot [data-folder-id="${roots.history}"]`).click();
    await page.locator('#approve-import').click();
    await expect.poll(async () => (await status(page)).archive.reconciliationRun?.operations.map((op: any) => ({ state: op.state, reason: op.reason })), { timeout: 60000 })
      .toEqual([{ state: 'completed', reason: null }, { state: 'completed', reason: null }, { state: 'completed', reason: null }]);
    expect(await page.evaluate(id => chrome.bookmarks.get(id), one.id)).toMatchObject([{ title: 'My video title', id: one.id }]);
    expect(await page.evaluate(id => chrome.bookmarks.get(id), personal)).toMatchObject([{ parentId: roots.history }]);
    expect(await page.evaluate(() => chrome.bookmarks.search({ url: 'https://www.bilibili.com/video/av3' }))).toHaveLength(1);
    const moved = (await status(page)).archive.reconciliationRun.operations.find((op: any) => op.decision.choice === 'move');
    const initialRun = (await status(page)).archive.reconciliationRun;
    const restoredNative = initialRun.operations.find((op: any) => op.decision.choice === 'restore').receipt.native.nativeId;
    await expect.poll(() => page.evaluate(async id => (await chrome.bookmarks.getChildren(id)).slice(0, 2).map(n => n.id), before.folder)).toEqual([one.id, restoredNative]);
    const order = await page.evaluate(async id => (await chrome.bookmarks.getChildren(id)).map(n => n.id), before.folder);
    expect(order.indexOf(seven.id)).toBeLessThan(order.indexOf(two.id));
    await page.evaluate(input => chrome.runtime.sendMessage(input), { kind: 'known.siteAdapters.reconcile.undo', id: (await status(page)).archive.reconciliationRun.id, operationId: moved.id });
    await expect.poll(() => page.evaluate(async id => (await chrome.bookmarks.get(id))[0]?.parentId, personal)).toBe(before.folder);
    // Moving the collection itself pauses its binding. The user can approve its
    // new location inside the same root without rebuilding its children.
    const nested = await page.evaluate(async root => (await chrome.bookmarks.create({ parentId: root, title: 'My grouping' })).id, roots.source);
    await page.evaluate(async ({ folder, parent }) => chrome.bookmarks.move(folder, { parentId: parent }), { folder: before.folder, parent: nested });
    const oldImport = (await status(page)).archive.import.id;
    await page.locator('#reconcile-rescan').click();
    await expect.poll(async () => { const s = await status(page); return s.archive.import.id !== oldImport && !!s.archive.reconciliation?.differences.some((d: any) => d.kind === 'folderMoved'); }, { timeout: 60000 }).toBe(true);
    const folderDifference = (await status(page)).archive.reconciliation.differences.find((d: any) => d.kind === 'folderMoved');
    expect(folderDifference.choices).toContain('useLocation');
    await expect.poll(() => page.locator('#reconcile-list select[data-difference-id]').evaluateAll((nodes, id) => nodes.some(n => (n as HTMLSelectElement).dataset.differenceId === id), folderDifference.id)).toBe(true);
    await page.locator('#reconcile-list select[data-difference-id]').evaluateAll((nodes, id) => {
      const select = nodes.find(n => (n as HTMLSelectElement).dataset.differenceId === id) as HTMLSelectElement;
      select.value = 'useLocation'; select.dispatchEvent(new Event('change'));
    }, folderDifference.id);
    await page.locator('#approve-import').click();
    await expect.poll(async () => (await status(page)).archive.reconciliationRun?.operations[0]?.state, { timeout: 60000 }).toBe('completed');
    expect(await page.evaluate(id => chrome.bookmarks.get(id), before.folder)).toMatchObject([{ parentId: nested, title: 'My collection name' }]);
    members = [1, 3, 4, 5, 6];
    await page.locator('#reconcile-rescan').click();
    await expect.poll(async () => (await status(page)).archive.import?.phase, { timeout: 60000 }).toBe('preview');
    await page.locator('#approve-import').click();
    await expect.poll(() => page.evaluate(async () => (await chrome.bookmarks.search({ url: 'https://www.bilibili.com/video/av6' }))[0]?.parentId), { timeout: 60000 }).toBe(before.folder);
    expect(await page.evaluate(() => chrome.bookmarks.search({ url: 'https://www.bilibili.com/video/av1' }))).toMatchObject([{ id: one.id, title: 'My video title' }]);
    await page.locator('#tab-recovery').click(); await page.locator('#reconcile-history-load').click();
    await page.locator(`#reconcile-history-list [data-run-id="${initialRun.id}"]`).click();
    const restored = initialRun.operations.find((op: any) => op.decision.choice === 'restore');
    await page.locator(`#reconcile-history-detail [data-operation-id="${restored.id}"] button`).click();
    await expect.poll(() => page.evaluate(async () => (await chrome.bookmarks.search({ url: 'https://www.bilibili.com/video/av5' })).length), { timeout: 30000 }).toBe(0);
  } catch (e) { for (const p of context.pages().filter(p => p.url().includes('site-adapters.html'))) console.log('reconcile-state', JSON.stringify(await status(p))); throw e; }
  finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
