import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startRealStack, type RealStack } from './real-stack.js';
import { openExtensionOptions, installFixtureReplicaBinding, signInExtension, showOptionsPane } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { scopeFacts } from './kns-08-harness.js';
const extensionId = 'pplpnpegpnghcddhmpgkbfkdfadjiaen', origin = `chrome-extension://${extensionId}`;
const status = (page: Page): Promise<any> => page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.siteAdapters.status' }));
test.use({ trace: 'off' });
test('source and automatic semantic copies share ordinary sync, retry independently and converge across devices', async () => {
  test.setTimeout(300000);
  const directory = await mkdtemp(resolve(tmpdir(), 'colp-shared-site-')), extension = resolve(directory, 'extension');
  const contexts: BrowserContext[] = []; let stack: RealStack | undefined; let providerFails = true; const modelCalls = [0, 0];
  await cp(resolve(import.meta.dirname, '../dist/development'), extension, { recursive: true });
  await cp(resolve(import.meta.dirname, '../config/e2e-fixture.json'), resolve(extension, 'generated-config.json'));
  const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
  manifest.host_permissions.push('https://known.example/*', 'https://identity.known.example/*', 'https://provider.test/*');
  await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
  try {
    stack = await startRealStack();
    // Fixture replicas were bootstrapped on the server; these fresh browser profiles have no snapshot.
    for (const binding of stack.extensionBindings) await stack.forceFixtureReplicaRecovery(binding.replicaId);
    async function open(index: 0 | 1) {
      const context = await chromium.launchPersistentContext(resolve(directory, `profile-${index}`), { headless: false, channel: 'chromium', ignoreHTTPSErrors: true,
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, `--host-resolver-rules=${stack!.browserHostResolverRules}`, '--no-proxy-server', '--ignore-certificate-errors'] });
      contexts.push(context);
      const cors = { 'access-control-allow-origin': 'https://www.bilibili.com', 'access-control-allow-credentials': 'true' };
      await context.route('https://www.bilibili.com/**', r => r.fulfill({ contentType: 'text/html', body: '<title>Shared source fixture</title>' }));
      await context.route('https://api.bilibili.com/x/web-interface/nav', r => r.fulfill({ headers: cors, contentType: 'application/json', body: '{"code":0,"data":{"isLogin":true,"mid":42}}' }));
      await context.route('https://api.bilibili.com/x/v3/fav/folder/created/list-all*', r => r.fulfill({ headers: cors, contentType: 'application/json', body: '{"code":0,"data":{"list":[{"id":101,"title":"Shared A"},{"id":102,"title":"Shared B"}]}}' }));
      await context.route('https://api.bilibili.com/x/v3/fav/resource/ids*', r => r.fulfill({ headers: cors, contentType: 'application/json',
        body: new URL(r.request().url()).searchParams.get('pn') === '1' ? '{"code":0,"data":[{"id":1,"type":2}]}' : '{"code":0,"data":[]}' }));
      await context.route('https://api.bilibili.com/x/v3/fav/resource/infos*', r => r.fulfill({ headers: cors, contentType: 'application/json', body: '{"code":0,"data":[{"id":1,"type":2,"title":"Shared source video","attr":1}]}' }));
      await context.route('https://provider.test/**', async r => {
        modelCalls[index] = (modelCalls[index] ?? 0) + 1; const body = r.request().postDataJSON();
        if (providerFails) return r.fulfill({ status: 503, body: '{}' });
        const answers = Object.fromEntries(Object.entries(body.questions as Record<string, { type: string; criteria: Record<string, string> }>).map(([name, q]) => {
          const keys = Object.keys(q.criteria), choice = keys.find(k => q.criteria[k]!.includes('Semantic')) ?? keys[0];
          return [name, q.type === 'noul' ? { noul: 0.99 } : { choice, confidence: 1, probabilities: Object.fromEntries(keys.map(k => [k, k === choice ? 1 : 0])) }];
        }));
        return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ model: 'controlled', answers }) });
      });
      const { page } = await openExtensionOptions(context);
      const grants = { permissions: ['bookmarks', 'scripting', 'webNavigation'], origins: ['https://www.bilibili.com/*', 'https://provider.test/*'] };
      await page.evaluate(g => { const b = document.createElement('button'); b.id = 'grant-shared'; b.textContent = 'Grant shared source access'; b.onclick = () => { void chrome.permissions.request(g); }; document.body.prepend(b); }, grants);
      await grantOptionalBookmarks(page, page.locator('#grant-shared'), 'COLP shared source fixture', grants);
      await installFixtureReplicaBinding(page, stack!.extensionBindings[index]); await signInExtension(page, stack!.collectionId);
      await showOptionsPane(page, 'folders'); await page.locator('#first-run-start').click();
      try {
        await expect.poll(() => page.evaluate(async () => (await chrome.runtime.sendMessage({ kind: 'known.firstRun.status' }) as { firstRun?: string }).firstRun), { timeout: 60000 }).toBe('completed');
      } catch (error) {
        console.log('shared-source-bootstrap', JSON.stringify(await page.evaluate(async () => ({
          first: await chrome.runtime.sendMessage({ kind: 'known.firstRun.status' }),
          engine: await chrome.runtime.sendMessage({ kind: 'known.sync.engine.status' }),
          failures: (await chrome.storage.local.get('known.sync.wake-failures.v1'))['known.sync.wake-failures.v1'],
        }))));
        console.log('shared-source-facts', JSON.stringify(await scopeFacts(page, stack!, stack!.extensionBindings[index])));
        throw error;
      }
      await page.evaluate(async first => {
        if (first) await chrome.bookmarks.create({ parentId: '2', title: 'Semantic' });
        await chrome.storage.local.set({ 'known.classification.local-enabled.v1': true,
          'known.classification.local-key.v1': { version: 3, generation: 'controlled', presetId: 'custom', endpoint: 'https://provider.test/v1/systemone', model: 'controlled', secret: 'fixture', disclosed: true } });
      }, index === 0);
      const site = await context.newPage(); await site.goto('https://www.bilibili.com/video/av1');
      await page.goto(`${origin}/site-adapters.html`); await page.locator('#enable').click();
      await expect.poll(async () => (await status(page)).candidateAccount).toBe('42');
      await page.locator('#refresh').click(); await page.locator('#confirm').click();
      await expect(page.locator('#archive-collections input')).toHaveCount(2, { timeout: 30000 });
      await page.locator('#select-all').click();
      await page.locator('#archive-root').click(); await page.locator('#archive-root-picker [data-folder-id="1"]').click();
      await page.locator('#archive-options').evaluate(e => { (e as HTMLDetailsElement).open = true; });
      await page.locator('#archive-semantic').click();
      await page.locator('#configure-archive').click();
      await expect.poll(async () => (await status(page)).archive.config?.state).toBe('active');
      await expect.poll(async () => { const s = await status(page); return { phase: s.archive.import?.phase, reason: s.archive.import?.reason }; }, { timeout: 90000 }).toMatchObject({ phase: 'preview' });
      return page;
    }
    const a = await open(0);
    expect(await a.evaluate(() => chrome.bookmarks.search({ title: 'Shared source video' }))).toHaveLength(0);
    stack.setSourceArchiveFault!('lost-response'); await a.locator('#approve-import').click();
    await expect.poll(async () => ((await stack!.observations()).canonicalNodes as { title: string }[]).filter(n => n.title === 'Shared A').length, { timeout: 45000 }).toBe(1);
    stack.setSourceArchiveFault!('none');
    await expect.poll(async () => { const s = await status(a); return { phase: s.archive.import?.phase, reason: s.archive.import?.reason }; }, { timeout: 120000 }).toMatchObject({ phase: 'completed' });
    expect(await a.evaluate(() => chrome.bookmarks.search({ title: 'Shared source video' }))).toHaveLength(2);
    await expect.poll(async () => (await status(a)).archive.semantic?.attention, { timeout: 30000 }).toBe(1);
    expect(modelCalls[0]).toBeGreaterThan(0); providerFails = false;
    await a.locator('#refresh').click(); await a.locator('#semantic-jobs button').click();
    await expect.poll(async () => (await status(a)).archive.semantic?.completed, { timeout: 90000 }).toBe(1);
    expect(await a.evaluate(() => chrome.bookmarks.search({ title: 'Shared source video' }))).toHaveLength(3);
    const callsAfterRetry = modelCalls[0];
    const b = await open(1); await b.locator('#approve-import').click();
    await expect.poll(async () => { const s = await status(b); return { phase: s.archive.import?.phase, reason: s.archive.import?.reason }; }, { timeout: 120000 }).toMatchObject({ phase: 'completed' });
    await expect.poll(async () => (await status(b)).archive.semantic?.completed, { timeout: 60000 }).toBe(1);
    expect(await b.evaluate(() => chrome.bookmarks.search({ title: 'Shared source video' }))).toHaveLength(3);
    expect(modelCalls).toEqual([callsAfterRetry, 0]);
    const nodes = (await stack.observations()).canonicalNodes as { title: string }[];
    expect(nodes.filter(n => n.title === 'Shared A')).toHaveLength(1);
    expect(nodes.filter(n => n.title === 'Shared B')).toHaveLength(1);
    expect(nodes.filter(n => n.title === 'Shared source video')).toHaveLength(3);
    const popup = await b.evaluate(async () => {
      const folder = (await chrome.bookmarks.search({ title: 'Semantic' }))[0]!;
      return chrome.runtime.sendMessage({ kind: 'known.capture.start', trigger: 'manual-popup', userGesture: true,
        commandId: crypto.randomUUID(), title: 'Another source alias', url: 'https://www.bilibili.com/video/av1', parentNativeId: folder.id,
        folderChoice: 'explicit', saveAnother: false, allowUnverifiedCloud: true });
    });
    expect(popup).toMatchObject({ ok: true, task: { contentIntent: { mode: 'reuse' } } });
    expect(await b.evaluate(() => chrome.bookmarks.search({ title: 'Shared source video' }))).toHaveLength(3);
    const bindings = async () => (await stack!.sourceArchiveProbe!({ version: 1, action: 'managed.list', input: { collectionId: stack!.collectionId, after: null } })).body as any;
    const sharedSemantic = (await bindings()).bindings.find((entry: any) => entry.slot.kind === 'bookmark' && entry.slot.copy.purpose === 'semantic');
    expect(sharedSemantic?.state).toBe('active');
    await b.evaluate(async () => {
      const folder = (await chrome.bookmarks.search({ title: 'Semantic' }))[0]!;
      const bookmark = (await chrome.bookmarks.getChildren(folder.id)).find(n => n.url)!; await chrome.bookmarks.remove(bookmark.id);
    });
    await expect.poll(async () => (await bindings()).bindings.find((entry: any) => entry.slot.kind === 'bookmark' && entry.slot.copy.purpose === 'semantic')?.state, { timeout: 45000 }).toBe('suppressed');
    const canonical = (await stack.observations()).canonicalNodes as { id: string; resource_revision: string }[];
    const anotherDeviceSave = await stack.sourceArchiveProbe!({ version: 1, action: 'managed.save', input: { commandId: 'retry-deleted-semantic',
      replicaId: stack.extensionBindings[1].replicaId, collectionId: stack.collectionId, slot: sharedSemantic.slot,
      parentId: sharedSemantic.node.parentId, parentRevision: String(canonical.find(n => n.id === sharedSemantic.node.parentId)!.resource_revision),
      title: sharedSemantic.node.title, url: sharedSemantic.node.url } }, stack.extensionBindings[1]);
    expect(anotherDeviceSave).toMatchObject({ status: 200, body: { disposition: 'suppressed' } });
    expect(modelCalls).toEqual([callsAfterRetry, 0]);
  } catch (error) {
    for (const context of contexts) for (const page of context.pages().filter(p => p.url().includes('site-adapters.html'))) {
      console.log('shared-source-state', JSON.stringify(await status(page)));
      console.log('shared-source-effects', JSON.stringify(await page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('known-site-adapters'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
        try {
          const read = (store: string) => new Promise<unknown[]>((resolve, reject) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
          return { effects: await read('effects'), folders: await read('folderReservations'), outbox: await read('outbox') };
        } finally { db.close(); }
      })));
    }
    throw error;
  } finally { for (const context of contexts) await context.close(); await stack?.close(); await rm(directory, { recursive: true, force: true }); }
});
