import { test, expect, chromium } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { grantOptionalBookmarks } from './bookmark-permission.js';
const extensionPath = resolve(import.meta.dirname, '../dist/development');

test('bundled inspector scopes worlds, reconnects routes and fences revocation without native effects', async () => {
  test.setTimeout(90_000);
  const profile = await mkdtemp(resolve(tmpdir(), 'known-site-adapters-'));
  const context = await chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium', ignoreDefaultArgs: ['--disable-back-forward-cache'], args: [
    `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
  ] });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const extensionOrigin = `chrome-extension://${new URL(worker.url()).hostname}`;
    const page = await context.newPage();
    await context.route('https://www.bilibili.com/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Controlled site</title><h1>Fixture</h1><script>addEventListener("pageshow",e=>{document.documentElement.dataset.persisted=String(e.persisted)})</script>' }));
    await context.route('https://api.bilibili.com/x/web-interface/nav', route => route.fulfill({ contentType: 'application/json',
      headers: { 'access-control-allow-origin': 'https://www.bilibili.com', 'access-control-allow-credentials': 'true' }, body: JSON.stringify({ code: 0, data: { isLogin: true, mid: 42 } }) }));
    await context.route('https://api.bilibili.com/x/web-interface/view*', route => route.fulfill({ contentType: 'application/json',
      headers: { 'access-control-allow-origin': 'https://www.bilibili.com', 'access-control-allow-credentials': 'true' }, body: JSON.stringify({ code: 0, data: { aid: 1, bvid: 'BV1xx411c7mD', title: 'Fixture', state: 0 } }) }));
    await context.route('https://api.bilibili.com/x/v3/fav/folder/created/list-all*', route => route.fulfill({ contentType: 'application/json',
      headers: { 'access-control-allow-origin': 'https://www.bilibili.com', 'access-control-allow-credentials': 'true' }, body: JSON.stringify({ code: 0, data: { list: [{ id: 101, title: 'Fixture collection' }] } }) }));
    await context.route('https://api.bilibili.com/x/v3/fav/resource/deal', route => route.fulfill({ contentType: 'application/json',
      headers: { 'access-control-allow-origin': 'https://www.bilibili.com', 'access-control-allow-credentials': 'true' }, body: JSON.stringify({ code: 0 }) }));
    await context.route('https://api.bilibili.com/x/v3/fav/resource/ids*', route => route.fulfill({ contentType: 'application/json',
      headers: { 'access-control-allow-origin': 'https://www.bilibili.com', 'access-control-allow-credentials': 'true' }, body: JSON.stringify({ code: 0, data: [{ id: 1, type: 2 }] }) }));
    await context.route('https://api.bilibili.com/x/v3/fav/resource/infos*', route => route.fulfill({ contentType: 'application/json',
      headers: { 'access-control-allow-origin': 'https://www.bilibili.com', 'access-control-allow-credentials': 'true' }, body: JSON.stringify({ code: 0, data: [{ id: 1, type: 2, title: 'Fixture', attr: 1 }] }) }));
    const site = await context.newPage(); await site.goto('https://www.bilibili.com/video/av1');
    await page.goto(`${extensionOrigin}/site-adapters.html`);
    await grantOptionalBookmarks(page, 'Enable Bilibili inspector', 'Known adapter access', {
      permissions: ['scripting', 'webNavigation'], origins: ['https://www.bilibili.com/*'],
    });
    const readState = () => page.evaluate(async () => (await chrome.storage.local.get('known.siteAdapters.runtime.v1'))['known.siteAdapters.runtime.v1'] as { generation: number; leases: { id: string; documentId: string; url: string; routeEpoch: number }[]; candidateAccount: string | null });
    await expect.poll(async () => (await readState()).candidateAccount, { timeout: 15000 }).toBe('42');
    await page.locator('#refresh').click(); await page.locator('#confirm').click();
    await expect.poll(async () => (await readState()).leases.length).toBe(1);
    await page.locator('#read-catalog').click();
    await expect.poll(async () => page.evaluate(async () => {
      const state = (await chrome.storage.local.get('known.siteAdapters.inspection.v1'))['known.siteAdapters.inspection.v1'] as { result?: { status: string } } | undefined;
      return state?.result?.status;
    }), { timeout: 15000 }).toBe('ok');
    const first = (await readState()).leases[0]!;
    expect(await site.evaluate(() => ({ runtime: typeof (globalThis as any).chrome?.runtime?.sendMessage,
      slot: (globalThis as any).__knownSiteAdapterV1 }))).toEqual({ runtime: 'undefined', slot: undefined });
    await site.evaluate(async () => {
      const hints: unknown[] = []; (globalThis as any).fixtureHints = hints;
      window.addEventListener('known-bilibili-favorite-hint', e => hints.push((e as CustomEvent).detail));
      await fetch('https://api.bilibili.com/x/v3/fav/resource/deal', { method: 'POST', credentials: 'include',
        body: new URLSearchParams({ rid: '1', type: '2', add_media_ids: '101', csrf: 'fixture-private' }) });
    });
    await expect.poll(() => site.evaluate(() => (globalThis as any).fixtureHints.length)).toBe(1);
    const hint = await site.evaluate(() => (globalThis as any).fixtureHints[0]);
    expect(hint).toMatchObject({ itemId: 'video:av:1', added: ['101'], removed: [], code: 0 });
    expect(Object.keys(hint).sort()).toEqual(['added', 'code', 'interactionId', 'itemId', 'removed']);
    await expect.poll(() => page.evaluate(async () => {
      const s = await chrome.runtime.sendMessage({ kind: 'known.siteAdapters.status' }) as { confirmations: { last?: { state: string } } };
      return s.confirmations.last?.state;
    }), { timeout: 30000 }).toBe('observed');
    await site.evaluate(() => history.pushState({}, '', '/video/BV1xx411c7mD'));
    await expect.poll(async () => (await readState()).leases[0]?.url).toContain('/video/BV1xx411c7mD');
    await expect.poll(() => page.evaluate(async () => {
      const q = (await chrome.storage.local.get('known.siteAdapters.readQueue.v1'))['known.siteAdapters.readQueue.v1'] as { nextAt: number; active: unknown };
      return !q.active && q.nextAt <= Date.now();
    })).toBe(true);
    await page.locator('#read-item').click();
    await expect.poll(() => page.evaluate(async () => {
      const s = (await chrome.storage.local.get('known.siteAdapters.inspection.v1'))['known.siteAdapters.inspection.v1'] as { result?: { status: string; item?: { id: string } } };
      return s.result?.item?.id;
    }), { timeout: 15000 }).toBe('video:av:1');
    // MAIN synthetic messages cannot invoke the dedicated runtime ingress.
    await site.evaluate(() => window.postMessage({ kind: 'known.capture.start', userGesture: true }, '*'));
    await page.evaluate(async () => { await chrome.runtime.sendMessage({ kind: 'known.siteAdapters.enable', enabled: true }); });
    await expect.poll(async () => (await readState()).leases.length).toBe(1);
    await site.evaluate(() => history.pushState({}, '', '/video/av2'));
    await expect.poll(async () => (await readState()).leases[0]?.url).toContain('/video/av2');
    expect((await readState()).leases[0]!.id).not.toBe(first.id);
    const storageIsolation = await page.evaluate(async () => {
      const tabs = await chrome.tabs.query({ url: ['https://www.bilibili.com/*'] });
      return chrome.scripting.executeScript({ target: { tabId: tabs[0]!.id! }, world: 'ISOLATED', func: async () => {
        try { await chrome.storage.local.get('known.siteAdapters.runtime.v1'); return 'exposed'; } catch { return 'blocked'; }
      } });
    });
    expect(storageIsolation[0]?.result).toBe('blocked');
    await context.route('https://example.org/**', route => route.fulfill({ contentType: 'text/html', body: '<title>Other page</title>' }));
    await site.goto('https://example.org/away'); await site.evaluate(() => history.back());
    await expect(site).toHaveURL('https://www.bilibili.com/video/av2');
    await expect(site.locator('html')).toHaveAttribute('data-persisted', 'true');
    await expect.poll(async () => (await readState()).leases.length).toBe(1);
    const admitted = await page.evaluate(async () => {
      const s = (await chrome.storage.local.get('known.siteAdapters.runtime.v1'))['known.siteAdapters.runtime.v1'] as { leases: { id: string; capability: string; tabId: number }[] };
      const lease = s.leases[0]!;
      const results = await chrome.scripting.executeScript({ target: { tabId: lease.tabId }, world: 'ISOLATED', args: [lease],
        func: async (lease: { id: string; capability: string }) => new Promise(resolve => {
          const port = chrome.runtime.connect({ name: 'known.siteAdapters.v1' });
          port.onMessage.addListener(message => { const r = message as { requestId?: string; reply?: unknown };
            if (r.requestId === 'controlled-observation') { resolve(r.reply); port.disconnect(); } });
          port.postMessage({ protocolVersion: 1, requestId: 'controlled-observation', leaseId: lease.id, capability: lease.capability, operation: 'emit',
            data: { type: 'membership.observed', item: { id: 'video:av:1', identity: 'siteId', kind: 'video', url: 'https://www.bilibili.com/video/av1', title: 'Fixture' }, memberships: { mode: 'delta', added: ['101'], removed: [] } } });
        }) });
      return results[0]?.result;
    });
    expect(admitted).toMatchObject({ status: 'accepted' });
    const observations = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('known-site-adapters'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      try { return await new Promise<string[]>((resolve, reject) => { const r = db.transaction('observations').objectStore('observations').getAll(); r.onsuccess = () => resolve((r.result as { observation: { type: string } }[]).map(row => row.observation.type).sort()); r.onerror = () => reject(r.error); }); } finally { db.close(); }
    });
    expect(observations).toEqual(['catalog.upsert', 'membership.observed', 'membership.observed']);
    const oldGeneration = (await readState()).generation;
    await page.locator('#disable').click();
    await expect.poll(async () => (await readState()).generation).toBeGreaterThan(oldGeneration);
    expect((await readState()).leases).toEqual([]);
    const scripts = await page.evaluate(() => chrome.scripting.getRegisteredContentScripts({ ids: ['known-site-adapter', 'known-site-probe'] }));
    expect(scripts).toEqual([]);
    const cleanup = await page.evaluate(async () => {
      const tabs = await chrome.tabs.query({ url: ['https://www.bilibili.com/*'] });
      return chrome.scripting.executeScript({ target: { tabId: tabs[0]!.id! }, world: 'ISOLATED', func: () =>
        Object.hasOwn(globalThis, '__knownSiteAdapterV1') });
    });
    expect(cleanup[0]?.result).toBe(false);
    expect(await page.evaluate(() => chrome.permissions.contains({ permissions: ['bookmarks'] }))).toBe(false);
    const dbs = await page.evaluate(() => indexedDB.databases());
    expect(dbs.some(db => db.name === 'known-capture')).toBe(false);
    await test.info().attach('source-confirmation-acceptance.json', { body: Buffer.from(JSON.stringify({ schemaVersion: 1, observedAt: new Date().toISOString(),
      browserVersion: context.browser()?.version(), browserUa: await page.evaluate(() => navigator.userAgent), fixture: true, realSite: false,
      positiveHintReadback: 'membership.observed', avBvIdentity: 'video:av:1', durableObservations: observations, bfcache: true,
      sourceRegistrationsAfterDisable: scripts.length, collectorAfterDisable: cleanup[0]?.result, bookmarksPermission: false, captureDatabase: false }, null, 2)), contentType: 'application/json' });
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
