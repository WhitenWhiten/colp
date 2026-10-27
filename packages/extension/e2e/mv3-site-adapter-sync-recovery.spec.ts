import { test, expect, chromium } from '@playwright/test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startRealStack } from './real-stack.js';
import { openExtensionOptions, installFixtureReplicaBinding, signInExtension, showOptionsPane } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';

test('an approved source import waits for real Sync recovery then fills its folders without another scan or approval', async () => {
  test.setTimeout(240000);
  const directory = await mkdtemp(resolve(tmpdir(), 'known-source-sync-recovery-')), extension = resolve(directory, 'extension');
  await cp(resolve(import.meta.dirname, '../dist/development'), extension, { recursive: true });
  await cp(resolve(import.meta.dirname, '../config/e2e-fixture.json'), resolve(extension, 'generated-config.json'));
  const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
  manifest.host_permissions.push('https://known.example/*', 'https://identity.known.example/*');
  await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
  const stack = await startRealStack();
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    await stack.forceFixtureReplicaRecovery();
    context = await chromium.launchPersistentContext(resolve(directory, 'profile'), { headless: false, channel: 'chromium', ignoreHTTPSErrors: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, `--host-resolver-rules=${stack.browserHostResolverRules}`, '--no-proxy-server', '--ignore-certificate-errors'] });
    context.setDefaultTimeout(20000);
    const cors = { 'access-control-allow-origin': 'https://www.bilibili.com', 'access-control-allow-credentials': 'true' };
    let sourceReads = 0;
    await context.route('https://www.bilibili.com/**', r => r.fulfill({ contentType: 'text/html', body: '<title>Source sync recovery</title>' }));
    await context.route('https://api.bilibili.com/**', r => {
      const url = new URL(r.request().url());
      if (url.pathname.endsWith('/ids') || url.pathname.endsWith('/infos')) sourceReads++;
      const collection = Number(url.searchParams.get('media_id') ?? 101);
      const data = url.pathname.endsWith('/nav') ? { isLogin: true, mid: 42 }
        : url.pathname.endsWith('/list-all') ? { list: [101, 102, 103].map(id => ({ id, title: `Source ${id}` })) }
        : url.pathname.endsWith('/ids') ? url.searchParams.get('pn') === '1' ? Array.from({ length: 8 }, (_, i) => ({ id: (collection - 101) * 8 + i + 1, type: 2 })) : []
        : url.pathname.endsWith('/infos') ? (url.searchParams.get('resources') ?? '').split(',').map(value => ({ id: Number(value.split(':')[0]), type: 2, title: `Imported ${value.split(':')[0]}`, attr: 0 })) : {};
      return r.fulfill({ headers: cors, contentType: 'application/json', body: JSON.stringify({ code: 0, data }) });
    });
    const { page, worker } = await openExtensionOptions(context);
    const origin = `chrome-extension://${new URL(worker.url()).hostname}`;
    const status = (): Promise<any> => page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.siteAdapters.status' }));
    const grants = { permissions: ['bookmarks', 'scripting', 'webNavigation'], origins: ['https://www.bilibili.com/*'] };
    await page.evaluate(g => { const b = document.createElement('button'); b.id = 'grant-source-recovery'; b.textContent = 'Grant source access';
      b.onclick = () => { void chrome.permissions.request(g); }; document.body.prepend(b); }, grants);
    await grantOptionalBookmarks(page, page.locator('#grant-source-recovery'), 'Source sync recovery', grants);
    await installFixtureReplicaBinding(page, stack.extensionBinding); await signInExtension(page, stack.collectionId);
    await showOptionsPane(page, 'folders'); await page.locator('#first-run-start').click();
    await expect.poll(() => page.evaluate(async () => (await chrome.runtime.sendMessage({ kind: 'known.firstRun.status' }) as any).firstRun), { timeout: 60000 }).toBe('completed');
    const source = await context.newPage(); await source.goto('https://www.bilibili.com/');
    await page.goto(`${origin}/site-adapters.html`); await page.locator('#enable').click();
    await expect.poll(async () => (await status()).candidateAccount).toBe('42');
    await page.locator('#refresh').click(); await page.locator('#confirm').click();
    await expect(page.locator('#archive-collections input')).toHaveCount(3, { timeout: 30000 });
    await page.locator('#select-all').click();
    await page.locator('#archive-root').click(); await page.locator('#archive-root-picker [data-folder-id="1"]').click();
    await page.locator('#configure-archive').click();
    await expect.poll(async () => (await status()).archive.import?.phase, { timeout: 60000 }).toBe('preview');
    expect((await status()).archive.import.preview.counts.createBookmarks).toBe(24);
    const jobId = (await status()).archive.import.id, reads = sourceReads;
    await source.close();
    // Delay a real Snapshot response while the server requests recovery. This
    // preserves the real Session/Snapshot/Ack path and makes the wait observable.
    await worker.evaluate(() => {
      const state = globalThis as typeof globalThis & { releaseSourceRecovery?: () => void };
      const original = fetch;
      const gate = new Promise<void>(resolve => { state.releaseSourceRecovery = () => { globalThis.fetch = original; resolve(); }; });
      globalThis.fetch = async (input, init) => {
        if (new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname === '/v1/snapshot') await gate;
        return original(input, init);
      };
    });
    await stack.forceFixtureReplicaRecovery();
    const retry = page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.sync.engine.retry' }));
    await expect.poll(() => page.evaluate(async () => (await chrome.runtime.sendMessage({ kind: 'known.sync.engine.status' }) as any).engine?.recoveryFrozen)).toBe(true);
    await page.locator('#approve-import').click();
    await expect.poll(async () => (await status()).archive.import?.reason).toBe('sourceSyncRecovering');
    await expect(page.locator('#import-state')).toHaveText('Bookmark sync is recovering');
    expect((await stack.observations()).canonicalNodes).not.toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Source 101' })]));
    await worker.evaluate(() => { (globalThis as typeof globalThis & { releaseSourceRecovery?: () => void }).releaseSourceRecovery?.(); });
    await retry;
    await expect.poll(async () => ({ phase: (await status()).archive.import?.phase, saved: (await status()).archive.import?.progress.saved }), { timeout: 120000 }).toEqual({ phase: 'completed', saved: 24 });
    expect((await status()).archive.import.id).toBe(jobId); expect(sourceReads).toBe(reads);
    const folders = await page.evaluate(() => chrome.bookmarks.getChildren('1'));
    for (const id of [101, 102, 103]) {
      const folder = folders.filter(n => n.title === `Source ${id}`); expect(folder).toHaveLength(1);
      expect(await page.evaluate(id => chrome.bookmarks.getChildren(id), folder[0]!.id)).toHaveLength(8);
    }
    expect((await stack.observations()).replicaStatus).toBe('active');
  } finally { await context?.close(); await stack.close(); await rm(directory, { recursive: true, force: true }); }
});
