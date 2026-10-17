import { expect, test, type BrowserContext } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { KNS08_BINDINGS, confirmPreview, grantBookmarks, launchPersistent, liveCanonical, login,
  optionsPage, previewFirstRun, scopeFacts, specialRoots, startRealStack, wakeEngine,
  waitFirstRunProductQuiet } from './kns-08-harness.js';
import { dropPendingChangeAndInterruptPull } from './sync-restart-fault.js';

test('ongoing sync recovers a missed edit callback after browser restart', async () => {
  test.setTimeout(180_000);
  const stack = await startRealStack();
  const profile = await mkdtemp(resolve(tmpdir(), 'known-ongoing-sync-recovery-'));
  let context: BrowserContext | undefined;
  try {
    context = await launchPersistent(profile, stack.browserHostResolverRules);
    const page = await optionsPage(context);
    await login(page, KNS08_BINDINGS[0]); await grantBookmarks(page);
    const roots = await specialRoots(page);
    await page.evaluate(async parentId => {
      await chrome.bookmarks.create({ parentId, title: 'Initial bookmark', url: 'https://example.test/initial' });
    }, roots.barId);
    const preview = await previewFirstRun(page, [roots.barTitle]);
    await confirmPreview(page, preview.previewId);
    await waitFirstRunProductQuiet(page, stack, KNS08_BINDINGS[0], 90_000);
    expect((await scopeFacts(page, stack, KNS08_BINDINGS[0])).firstRun).toBe('completed');

    stack.setSyncOffline(true);
    const nativeId = await page.evaluate(async parentId => (await chrome.bookmarks.create({ parentId,
      title: 'Before restart', url: 'https://example.test/ongoing-original' })).id, roots.barId);
    await expect.poll(async () => (await scopeFacts(page, stack, KNS08_BINDINGS[0])).queueStatuses
      .some(status => status !== 'terminal')).toBe(true);
    await page.evaluate(async id => { await chrome.bookmarks.update(id, {
      title: 'Edit retained across restart', url: 'https://example.test/ongoing-edited',
    }); }, nativeId);
    await expect.poll(async () => (await scopeFacts(page, stack, KNS08_BINDINGS[0])).captureStates
      .some(state => state === 'change:pending')).toBe(true);
    await wakeEngine(page);
    expect(await dropPendingChangeAndInterruptPull(context, nativeId)).toBeGreaterThan(0);
    await context.close(); context = undefined;
    stack.setSyncOffline(false);
    context = await launchPersistent(profile, stack.browserHostResolverRules);
    await expect.poll(async () => (await liveCanonical(stack))
      .filter(node => node.url === 'https://example.test/ongoing-edited').map(node => node.title),
    { timeout: 90_000, intervals: [1_000, 2_000, 5_000] }).toEqual(['Edit retained across restart']);
    const reopened = await optionsPage(context);
    await waitFirstRunProductQuiet(reopened, stack, KNS08_BINDINGS[0], 30_000);
    const native = await reopened.evaluate(async id => (await chrome.bookmarks.get(id))[0], nativeId);
    expect(native?.title).toBe('Edit retained across restart');
    expect(native?.url).toBe('https://example.test/ongoing-edited');
    expect((await liveCanonical(stack)).filter(node => node.url === 'https://example.test/ongoing-original')).toEqual([]);
  } finally {
    await context?.close(); await stack.close(); await rm(profile, { recursive: true, force: true });
  }
});
