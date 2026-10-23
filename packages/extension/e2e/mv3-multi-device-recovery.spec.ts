import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  KNS08_BINDINGS, confirmPreview, grantBookmarks, launchPersistent, liveCanonical,
  login, optionsPage, previewFirstRun, specialRoots, startRealStack,
  waitFirstRunProductQuiet, waitNonterminalQueue, waitQueueQuiet, wakeEngine, type RealStack,
} from './kns-08-harness.js';

const URL = 'https://example.test/two-device-durable';

async function ready(context: BrowserContext, binding: typeof KNS08_BINDINGS[number]): Promise<Page> {
  const page = await optionsPage(context);
  await login(page, binding);
  await grantBookmarks(page);
  return page;
}

async function bootstrap(page: Page, stack: RealStack, binding: typeof KNS08_BINDINGS[number]) {
  const roots = await specialRoots(page);
  const preview = await previewFirstRun(page, [roots.barTitle]);
  await confirmPreview(page, preview.previewId);
  await waitFirstRunProductQuiet(page, stack, binding);
  const publicStatus = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.sync.engine.status' }));
  expect(publicStatus).toMatchObject({ ok: true });
  expect(JSON.stringify(publicStatus)).not.toMatch(/accessToken|authorization|cookie|bookmarkEvents|nativeMappings/iu);
}

test('two real profiles converge after an offline edit survives a complete browser restart', async () => {
  test.setTimeout(300_000);
  const root = await mkdtemp(resolve(tmpdir(), 'colp-two-device-'));
  let stack: RealStack | undefined;
  let a: BrowserContext | undefined, b: BrowserContext | undefined;
  try {
    const runtime = await startRealStack();
    stack = runtime;
    a = await launchPersistent(resolve(root, 'a'), runtime.browserHostResolverRules);
    let pageA = await ready(a, KNS08_BINDINGS[0]);
    const roots = await specialRoots(pageA);
    const original = await pageA.evaluate(async ({ parentId, url }) => chrome.bookmarks.create({
      parentId, title: 'Before offline edit', url,
    }), { parentId: roots.barId, url: URL });
    await bootstrap(pageA, runtime, KNS08_BINDINGS[0]);

    b = await launchPersistent(resolve(root, 'b'), runtime.browserHostResolverRules);
    const pageB = await ready(b, KNS08_BINDINGS[1]);
    await bootstrap(pageB, runtime, KNS08_BINDINGS[1]);
    const downloaded = await pageB.evaluate(url => chrome.bookmarks.search({ url }), URL);
    expect(downloaded).toHaveLength(1);
    expect(downloaded[0]!.title).toBe('Before offline edit');

    runtime.setSyncOffline(true);
    await pageA.evaluate(id => chrome.bookmarks.update(id, { title: 'Durable offline edit' }), original.id);
    await waitNonterminalQueue(pageA, runtime, KNS08_BINDINGS[0]);
    await a.close(); a = undefined;

    runtime.setSyncOffline(false);
    a = await launchPersistent(resolve(root, 'a'), runtime.browserHostResolverRules);
    pageA = await ready(a, KNS08_BINDINGS[0]);
    await wakeEngine(pageA);
    await waitQueueQuiet(pageA, runtime, KNS08_BINDINGS[0]);
    await expect.poll(async () => {
      await wakeEngine(pageB);
      return pageB.evaluate(async url => (await chrome.bookmarks.search({ url })).map(node => ({ id: node.id, title: node.title })), URL);
    }, { timeout: 90_000 }).toEqual([{ id: downloaded[0]!.id, title: 'Durable offline edit' }]);

    const canonical = (await liveCanonical(runtime)).filter(node => node.url === URL);
    expect(canonical).toHaveLength(1);
    expect(canonical[0]!.title).toBe('Durable offline edit');
    const restarted = await pageA.evaluate(url => chrome.bookmarks.search({ url }), URL);
    expect(restarted.map(node => node.id)).toEqual([original.id]);
  } finally {
    await Promise.allSettled([a?.close(), b?.close()]);
    try { await stack?.close(); } finally { await rm(root, { recursive: true, force: true }); }
  }
});
