import { expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { installChromeThroughputProfiler, readChromeThroughputProfiler } from './chrome-throughput-profiler.js';
import { withSyncFailureDetails } from './sync-failure-diagnostics.js';
import {
  FIXTURE_COLLECTION_ID, KNS08_BINDINGS, captureReplayFacts, launchPersistent, liveCanonical,
  previewFirstRun, optionsPage, login, grantBookmarks, runtimeMessage, saveReplayFixture, specialRoots, startRealStack,
  scopeFacts,
} from './kns-08-harness.js';

for (const mode of ['normal', 'lost-batch-response'] as const) {
  test(`958-bookmark first sync throughput profile with ${mode}`, async ({}, testInfo) => {
    test.setTimeout(300_000);
    const stack = await startRealStack();
    const profile = await mkdtemp(resolve(tmpdir(), 'colp-large-first-sync-'));
    let context: BrowserContext | undefined;
    let page: Page | undefined;
    let measuredWorker: Worker | undefined;
    let profileCollected = false;
    let newWorkerInstances = 0;
    const collectProfile = async () => {
      if (profileCollected) return;
      profileCollected = true;
      const worker = await measuredWorker?.evaluate(readChromeThroughputProfiler, true)
        .catch(() => ({ unavailable: 'worker_report_unavailable' }));
      const options = await page?.evaluate(readChromeThroughputProfiler, true)
        .catch(() => ({ unavailable: 'options_report_unavailable' }));
      console.log(`Chrome throughput aggregate: ${JSON.stringify({ mode, newWorkerInstances, worker, options })}`);
    };
    try {
      await seedFirstSyncProfile(profile);
      context = await launchPersistent(profile, stack.browserHostResolverRules);
      page = await optionsPage(context);
      await login(page, KNS08_BINDINGS[0]);
      await grantBookmarks(page);
      const roots = await specialRoots(page);
      const preview = await previewFirstRun(page, ['Large sync mount 0', 'Large sync mount 1', roots.otherTitle]);
      expect(preview.bookmarkCount).toBe(958);
      expect(preview.folderCount).toBe(9);
      measuredWorker = context.serviceWorkers()[0];
      expect(measuredWorker, 'existing extension service worker is required for observational profiling').toBeDefined();
      context.on('serviceworker', () => { newWorkerInstances++; });
      expect(await measuredWorker!.evaluate(installChromeThroughputProfiler)).toMatchObject({ installed: true });
      expect(await page.evaluate(installChromeThroughputProfiler)).toMatchObject({ installed: true });
      if (mode === 'lost-batch-response') stack.setPushFault('lost_batch_response_once');
      expect(await runtimeMessage(page, { kind: 'known.firstRun.confirm', previewId: preview.previewId,
        confirmationId: crypto.randomUUID(), libraryId: FIXTURE_COLLECTION_ID })).toMatchObject({ ok: true });
      const activePage = page;
      await withSyncFailureDetails(activePage, `first-sync-${mode}: await 958-bookmark convergence`, () => expect.poll(async () => {
        const status = await runtimeMessage<{ ok: boolean; phase?: string; error?: string }>(activePage,
          { kind: 'known.firstRun.status' });
        const response = await runtimeMessage<{ ok: boolean; engine?: { recoveryFrozen: boolean;
          queueProjection: string; cursorsConverged: boolean; errorCode?: string } }>(activePage,
        { kind: 'known.sync.engine.status' });
        return { phase: status.phase ?? status.error, frozen: response.engine?.recoveryFrozen,
          queue: response.engine?.queueProjection, aligned: response.engine?.cursorsConverged };
      }, { timeout: 240_000, intervals: [1_000, 2_000, 5_000] }).toEqual({ phase: 'completed',
        frozen: false, queue: 'idle', aligned: true }).finally(collectProfile));
      const settled = await scopeFacts(page, stack, KNS08_BINDINGS[0]);
      expect(settled.queueStatuses.every(status => status === 'terminal')).toBe(true);
      expect(settled.pendingAckCount).toBe(0);
      expect(settled.pendingCaptureCount).toBe(0);
      expect(settled.bootstrapAckComplete).toBe(true);
      const nodes = await liveCanonical(stack);
      expect(nodes.filter(node => typeof node.url === 'string')).toHaveLength(958);
      // The selected browser tree has nine folders. The server also retains
      // its pre-existing, unselected bookmarks-bar mount.
      expect(nodes.filter(node => node.url === null)).toHaveLength(10);
      expect(nodes.filter(node => node.folder_role === 'bookmarks-bar')).toHaveLength(1);
      expect(nodes.filter(node => node.folder_role === 'other-bookmarks')).toHaveLength(1);
      expect(await page.evaluate(async () => {
        let count = 0;
        const visit = (node: chrome.bookmarks.BookmarkTreeNode) => {
          if (node.url) count++;
          for (const child of node.children ?? []) visit(child);
        };
        for (const root of await chrome.bookmarks.getTree()) visit(root);
        return count;
      })).toBe(958);
      const observed = await stack.observations() as { pushRequests: Array<{ body: string; responseStatus?: number }> };
      const sizes = observed.pushRequests.map(request => JSON.parse(request.body).operations.length as number);
      expect(sizes.some(size => size > 1)).toBe(true);
      expect(sizes.every(size => size <= 50)).toBe(true);
      await testInfo.attach('batch-sizes', { body: JSON.stringify(sizes), contentType: 'application/json' });
    } catch (error) {
      if (page) await saveReplayFixture(testInfo, `large-first-sync-${mode}`, error,
        await captureReplayFacts(page, stack, KNS08_BINDINGS[0]).catch(String));
      throw error;
    } finally {
      await collectProfile();
      await context?.close();
      await stack.close();
      await rm(profile, { recursive: true, force: true });
    }
  });
}

async function seedFirstSyncProfile(profile: string) {
  const folder = (id: number, name: string, children: unknown[] = []) => ({ id: String(id), name,
    type: 'folder', date_added: '13300000000000000', date_modified: '13300000000000000', children });
  const children = Array.from({ length: 6 }, (_, index) => folder(index + 6, `Large sync folder ${index}`));
  for (let index = 0; index < 958; index++) children[index % children.length]!.children.push({
    id: String(index + 100), type: 'url', name: `Large sync bookmark ${index}`,
    url: `https://example.test/large-sync/${index}`, date_added: '13300000000000000', date_last_used: '0',
  });
  const directory = resolve(profile, 'Default');
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'Bookmarks'), JSON.stringify({ version: 1, roots: {
    bookmark_bar: folder(1, 'Bookmarks bar', [folder(4, 'Large sync mount 0', children.slice(0, 3)),
      folder(5, 'Large sync mount 1', children.slice(3))]),
    other: folder(2, 'Other bookmarks'), synced: folder(3, 'Mobile bookmarks'),
  } }));
}
