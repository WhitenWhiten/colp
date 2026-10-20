import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { KNS08_BINDINGS, confirmFirstRun, evidence, grantBookmarks, launchPersistent, liveCanonical,
  login, optionsPage, runtimeMessage, specialRoots, startRealStack, terminateWorker,
  waitFirstRunProductQuiet, waitQueueQuiet, wakeEngine } from './kns-08-harness.js';
import { showOptionsPane } from './extension-auth.js';

test('paused native folder deletion reconciles with another browser and Keep cloud survives worker and profile restart', async () => {
  test.setTimeout(300_000);
  const stack = await startRealStack();
  const profiles = await Promise.all(['a', 'b'].map(id => mkdtemp(resolve(tmpdir(), `colp-rejoin-delete-${id}-`))));
  let a: BrowserContext | undefined; let b: BrowserContext | undefined;
  type Export = { mappings: { nativeId: string; colpId: string }[];
    mountBindings: { mountId: string; nativeRootId: string; status: string }[];
    queue: { opId: string; digest: string; payload: { type: string } }[];
    scopeCommandPlans: { commandId: string; phase: string }[] };
  try {
    a = await launchPersistent(profiles[0]!, stack.browserHostResolverRules);
    let pageA = await optionsPage(a); await login(pageA, KNS08_BINDINGS[0]); await grantBookmarks(pageA);
    const rootsA = await specialRoots(pageA);
    const folderA = await pageA.evaluate(parentId => chrome.bookmarks.create({ parentId, title: 'Rejoin original folder' }), rootsA.barId);
    await confirmFirstRun(pageA, [rootsA.barTitle, rootsA.otherTitle]);
    await waitFirstRunProductQuiet(pageA, stack, KNS08_BINDINGS[0]);
    b = await launchPersistent(profiles[1]!, stack.browserHostResolverRules);
    const pageB = await optionsPage(b); await login(pageB, KNS08_BINDINGS[1]); await grantBookmarks(pageB);
    const rootsB = await specialRoots(pageB);
    await confirmFirstRun(pageB, [rootsB.barTitle, rootsB.otherTitle]);
    await waitFirstRunProductQuiet(pageB, stack, KNS08_BINDINGS[1]);
    await expect.poll(() => find(pageB, 'Rejoin original folder'), { timeout: 60_000 }).toHaveLength(1);
    const [folderB] = await find(pageB, 'Rejoin original folder');
    const before = await evidence<Export>(pageA, 'exportOutboundPushEvidence');
    const mount = before.mountBindings.find(row => row.nativeRootId === rootsA.barId)!;
    expect(await runtimeMessage(pageA, { kind: 'known.scope.detach', mountId: mount.mountId })).toMatchObject({ ok: true });
    await pageA.evaluate(id => chrome.bookmarks.removeTree(id), folderA.id);
    await pageB.evaluate(async id => {
      await chrome.bookmarks.update(id, { title: 'Rejoin cloud folder' });
      const a = await chrome.bookmarks.create({ parentId: id, title: 'A cloud child', url: 'https://example.test/rejoin/a' });
      const z = await chrome.bookmarks.create({ parentId: id, title: 'Z cloud child', url: 'https://example.test/rejoin/z' });
      await chrome.bookmarks.move(z.id, { parentId: id, index: 0 });
      return a.id;
    }, folderB!.id);
    await waitQueueQuiet(pageB, stack, KNS08_BINDINGS[1]);
    await expect.poll(async () => (await liveCanonical(stack)).filter(row =>
      row.title === 'Rejoin cloud folder' || row.url === 'https://example.test/rejoin/a' || row.url === 'https://example.test/rejoin/z').length,
    { timeout: 60_000 }).toBe(3);
    await wakeEngine(pageA);
    expect(await runtimeMessage(pageA, { kind: 'known.scope.rejoin', mountId: mount.mountId }))
      .toMatchObject({ ok: false, error: 'rejoin_pending' });
    await pageA.reload(); await showOptionsPane(pageA, 'sync-center');
    const panel = pageA.locator('#rejoin-decisions');
    await expect(panel.locator('[data-rejoin-action="keep_remote"]')).toBeVisible({ timeout: 30_000 });
    await panel.locator('[data-rejoin-action="keep_remote"]').click();
    try {
      await expect.poll(() => find(pageA, 'Rejoin cloud folder'), { timeout: 60_000 }).toHaveLength(1);
    } catch (error) {
      // Preserve the actual failed choice. Reading the export cannot retry it,
      // accept a newer token, mutate native state, or manufacture a receipt.
      const snapshot = await evidence<Record<string, unknown>>(pageA, 'exportOutboundPushEvidence');
      const diagnostic = { feedback: await panel.textContent(), mappings: snapshot.mappings,
        mountBindings: snapshot.mountBindings, scopeCommandPlans: snapshot.scopeCommandPlans,
        intents: snapshot.intents, queue: snapshot.queue };
      throw new Error(`Keep cloud did not materialize: ${JSON.stringify(diagnostic).slice(0, 24_000)}`, { cause: error });
    }
    const [restored] = await find(pageA, 'Rejoin cloud folder');
    expect(restored!.id).not.toBe(folderA.id);
    expect(await pageA.evaluate(id => chrome.bookmarks.getChildren(id).then(rows => rows.map(row => row.title)), restored!.id))
      .toEqual(['Z cloud child', 'A cloud child']);
    await terminateWorker(a, pageA);
    await runtimeMessage(pageA, { kind: 'known.sync.rejoinDecisions.get' });
    await a.close(); a = await launchPersistent(profiles[0]!, stack.browserHostResolverRules); pageA = await optionsPage(a);
    await runtimeMessage(pageA, { kind: 'known.sync.rejoinDecisions.get' });
    expect((await find(pageA, 'Rejoin cloud folder')).map(row => row.id)).toEqual([restored!.id]);
    expect(await pageA.evaluate(id => chrome.bookmarks.getChildren(id).then(rows => rows.map(row => row.title)), restored!.id))
      .toEqual(['Z cloud child', 'A cloud child']);
    await waitQueueQuiet(pageA, stack, KNS08_BINDINGS[0]);
    const after = await evidence<Export>(pageA, 'exportOutboundPushEvidence');
    expect(after.mountBindings.find(row => row.mountId === mount.mountId)?.status).toBe('active');
    expect(after.queue.map(row => ({ opId: row.opId, digest: row.digest })))
      .toEqual(before.queue.map(row => ({ opId: row.opId, digest: row.digest })));
    expect((await liveCanonical(stack)).filter(row => row.url === 'https://example.test/rejoin/a')).toHaveLength(1);
    expect((await liveCanonical(stack)).filter(row => row.url === 'https://example.test/rejoin/z')).toHaveLength(1);
  } finally {
    await a?.close(); await b?.close(); await stack.close();
    await Promise.all(profiles.map(path => rm(path, { recursive: true, force: true })));
  }
});
async function find(page: Page, title: string) {
  return page.evaluate(title => chrome.bookmarks.search({ title }), title);
}
