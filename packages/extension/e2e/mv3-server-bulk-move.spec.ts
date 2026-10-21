import { expect, test, type BrowserContext } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { KNS08_BINDINGS, confirmPreview, grantBookmarks, launchPersistent, liveCanonical, login,
  optionsPage, previewFirstRun, scopeFacts, specialRoots, startRealStack, wakeEngine,
  waitFirstRunProductQuiet, waitQueueQuiet, evidence } from './kns-08-harness.js';

test('152 server-origin moves converge through Pull while retaining an offline local edit', async () => {
  test.setTimeout(240_000);
  const stack = await startRealStack();
  const profile = await mkdtemp(resolve(tmpdir(), 'known-server-bulk-move-'));
  let context: BrowserContext | undefined;
  try {
    context = await launchPersistent(profile, stack.browserHostResolverRules);
    const page = await optionsPage(context);
    await login(page, KNS08_BINDINGS[0]); await grantBookmarks(page);
    const roots = await specialRoots(page);
    const native = await page.evaluate(async parentId => {
      const folder = await chrome.bookmarks.create({ parentId, title: 'Bulk destination' });
      const bookmark = await chrome.bookmarks.create({ parentId, title: 'Local edit', url: 'https://example.test/local-edit' });
      for (let i = 0; i < 152; i++) await chrome.bookmarks.create({ parentId,
        title: `Bulk ${i}`, url: `https://example.test/server-bulk/${i}` });
      return { folderId: folder.id, bookmarkId: bookmark.id };
    }, roots.barId);
    const preview = await previewFirstRun(page, [roots.barTitle]);
    await confirmPreview(page, preview.previewId);
    await waitFirstRunProductQuiet(page, stack, KNS08_BINDINGS[0], 90_000);
    await waitQueueQuiet(page, stack, KNS08_BINDINGS[0], 60_000);
    const canonical = await liveCanonical(stack);
    const folderId = String(canonical.find(node => node.title === 'Bulk destination')!.id);
    const ids = canonical.filter(node => typeof node.url === 'string' && node.url.startsWith('https://example.test/server-bulk/'))
      .map(node => String(node.id));
    expect(ids).toHaveLength(152);
    stack.setSyncOffline(true);
    await page.evaluate(id => chrome.bookmarks.update(id, { title: 'Offline edit retained' }), native.bookmarkId);
    await expect.poll(async () => (await scopeFacts(page, stack, KNS08_BINDINGS[0])).queueStatuses
      .some(status => status !== 'terminal')).toBe(true);
    const snapshotsBefore = (await stack.observations()).sessions;
    expect(stack.moveCanonicalBookmarks).toBeDefined();
    await stack.moveCanonicalBookmarks!(ids, folderId);
    stack.setSyncOffline(false);
    await wakeEngine(page);
    try {
      await expect.poll(async () => {
        await wakeEngine(page);
        return page.evaluate(async parentId => (await chrome.bookmarks.getChildren(parentId)).length, native.folderId);
      }, { timeout: 60_000, intervals: [500, 1_000, 2_000] }).toBe(152);
    } catch (cause) {
      const facts = await scopeFacts(page, stack, KNS08_BINDINGS[0]);
      const exported = await evidence<any>(page, 'exportOutboundPushEvidence');
      throw new Error(JSON.stringify({ phase: facts.enginePhase, error: facts.errorCode,
        recovery: facts.recoveryCode, frozen: facts.recoveryFrozen, diagnostics: facts.diagnosticCodes,
        recoveries: [...new Set(facts.queueRecoveries)], queues: [...new Set(facts.queueStatuses)],
        engine: await evidence(page, 'syncEngineState'),
        folders: (await liveCanonical(stack)).filter(node => node.title === 'Bulk destination'),
        mapping: exported.mappings?.find((row: any) => row.nativeId === native.folderId),
      }), { cause });
    }
    await expect.poll(async () => (await liveCanonical(stack)).find(node => node.url === 'https://example.test/local-edit')?.title,
      { timeout: 60_000 }).toBe('Offline edit retained');
    expect((await liveCanonical(stack)).filter(node => typeof node.url === 'string'
      && node.url.startsWith('https://example.test/server-bulk/'))).toHaveLength(152);
    // A server move must not force a fresh Session/Snapshot recovery chain.
    expect((await stack.observations()).sessions).toBe(snapshotsBefore);
  } finally {
    await context?.close(); await stack.close(); await rm(profile, { recursive: true, force: true });
  }
});
