import { expect, test, type BrowserContext } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  KNS08_BINDINGS, confirmPreview, grantBookmarks, launchPersistent, liveCanonical, login,
  optionsPage, previewFirstRun, scopeFacts, specialRoots, startRealStack, wakeEngine,
  waitFirstRunProductQuiet,
} from './kns-08-harness.js';

for (const mode of ['close-page', 'restart-browser', 'edit-bookmarks', 'edit-restart-browser', 'remove-folder', 'restart-missed-callback'] as const) {
  test(`first-sync promise: ${mode}`, async ({}, info) => {
    test.setTimeout(180_000);
    const stack = await startRealStack();
    const profile = await mkdtemp(resolve(tmpdir(), 'known-sync-promise-'));
    let context: BrowserContext | undefined;
    try {
      context = await launchPersistent(profile, stack.browserHostResolverRules);
      const page = await optionsPage(context);
      await login(page, KNS08_BINDINGS[0]);
      await grantBookmarks(page);
      const roots = await specialRoots(page);
      const native = await page.evaluate(async parentId => {
        const target = await chrome.bookmarks.create({ parentId, title: 'Move target' });
        const ids: string[] = [];
        for (const name of ['rename', 'move', 'delete']) {
          const node = await chrome.bookmarks.create({ parentId, title: `Promise ${name}`,
            url: `https://example.test/promise/${name}` });
          ids.push(node.id);
        }
        await chrome.bookmarks.create({ parentId: target.id, title: 'Nested bookmark',
          url: 'https://example.test/promise/nested' });
        return { target: target.id, rename: ids[0]!, move: ids[1]!, remove: ids[2]! };
      }, roots.barId);
      const preview = await previewFirstRun(page, [roots.barTitle]);
      stack.setSyncOffline(true);
      await confirmPreview(page, preview.previewId);
      const pending = await scopeFacts(page, stack, KNS08_BINDINGS[0]);
      expect(pending.firstRun).toBe('running');
      expect(pending.queueStatuses.some(status => status !== 'terminal')).toBe(true);
      const edited = mode === 'edit-bookmarks' || mode === 'edit-restart-browser' || mode === 'restart-missed-callback';
      if (edited) {
        await page.evaluate(async ids => {
          await chrome.bookmarks.update(ids.rename, { title: 'Edited during first sync', url: 'https://example.test/promise/edited-url' });
          await chrome.bookmarks.move(ids.move, { parentId: ids.target });
          await chrome.bookmarks.remove(ids.remove);
          const parentId = (await chrome.bookmarks.get(ids.rename))[0]!.parentId!;
          await chrome.bookmarks.create({ parentId, title: 'New during first sync', url: 'https://example.test/promise/new' });
        }, native);
        await expect.poll(async () => (await scopeFacts(page, stack, KNS08_BINDINGS[0])).captureStates
          .some(state => state.startsWith('remove:'))).toBe(true);
        if (mode === 'restart-missed-callback') {
          await wakeEngine(page);
          // Model the durable phase of a worker interrupted inside Pull apply.
          // Drop only the uncommitted rename callback, as if eviction won its write.
          const dropped = await context.serviceWorkers()[0]!.evaluate(async nativeId => {
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
              const request = indexedDB.open('known-phase3-indexeddb-entry');
              request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
            });
            try {
              return await new Promise<number>((resolve, reject) => {
                const tx = db.transaction(['sync_engine', 'bookmark_events'], 'readwrite'), store = tx.objectStore('sync_engine');
                const events = tx.objectStore('bookmark_events'); let removed = 0;
                const captured = events.getAll();
                captured.onsuccess = () => { for (const row of captured.result) if (row.kind === 'change'
                  && row.nativeId === nativeId && row.status === 'pending') { events.delete([row.scopeKey, row.eventId]); removed++; } };
                const request = store.getAll();
                request.onsuccess = () => { for (const row of request.result) store.put({ ...row,
                  phase: 'applying', revision: row.revision + 1, updatedAt: Date.now() }); };
                tx.oncomplete = () => resolve(removed); tx.onabort = () => reject(tx.error);
              });
            } finally { db.close(); }
          }, native.rename);
          expect(dropped).toBeGreaterThan(0);
        }
      } else if (mode === 'remove-folder') {
        await page.evaluate(async id => chrome.bookmarks.removeTree(id), native.target);
      }
      if (mode === 'edit-bookmarks' || mode === 'remove-folder') {
        stack.setSyncOffline(false);
        await wakeEngine(page);
        await waitFirstRunProductQuiet(page, stack, KNS08_BINDINGS[0], 90_000);
      } else {
        // No extension page, status RPC, manual wake, or user interaction after this point.
        await page.close();
        if (mode === 'restart-browser' || mode === 'edit-restart-browser' || mode === 'restart-missed-callback') {
          await context.close();
          context = undefined;
          stack.setSyncOffline(false);
          context = await launchPersistent(profile, stack.browserHostResolverRules);
        } else stack.setSyncOffline(false);
        await expect.poll(async () => (await liveCanonical(stack))
          .filter(node => String(node.url ?? '').startsWith('https://example.test/promise/')).length,
        { timeout: 90_000, intervals: [1_000, 2_000, 5_000] }).toBe(4);
        await expect.poll(async () => {
          const worker = context!.serviceWorkers()[0];
          if (!worker) return null;
          return worker.evaluate(async () => {
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
              const request = indexedDB.open('known-phase3-indexeddb-entry');
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error);
            });
            try {
              const names = ['bootstrap_runs', 'sync_engine'];
              const tx = db.transaction(names, 'readonly');
              const rows = await Promise.all(names.map(name => new Promise<any[]>((resolve, reject) => {
                const request = tx.objectStore(name).getAll();
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
              })));
              const run = rows[0]![0], engine = rows[1]![0];
              return { phase: run?.phase, frozen: engine?.recoveryFrozen,
                aligned: Boolean(engine?.lastPublishedCursor && engine.lastPublishedCursor === engine.lastAckedCursor) };
            } finally { db.close(); }
          });
        }, { timeout: 30_000 }).toEqual({ phase: 'completed', frozen: false, aligned: true });
      }
      const live = await liveCanonical(stack);
      if (edited) {
        expect(live.find(node => node.url === 'https://example.test/promise/edited-url')?.title).toBe('Edited during first sync');
        expect(live.find(node => node.url === 'https://example.test/promise/move')?.parent_id)
          .toBe(live.find(node => node.title === 'Move target')?.id);
        expect(live.filter(node => node.url === 'https://example.test/promise/delete'
          || node.url === 'https://example.test/promise/rename')).toEqual([]);
        expect(live.filter(node => node.url === 'https://example.test/promise/new')).toHaveLength(1);
      }
      if (mode === 'remove-folder') {
        expect(live.filter(node => node.title === 'Move target' || node.url === 'https://example.test/promise/nested')).toEqual([]);
      }
    } catch (error) {
      if (context) {
        const page = await optionsPage(context).catch(() => undefined);
        if (page) await info.attach('sync-promise-failure', { contentType: 'application/json',
          body: JSON.stringify(await scopeFacts(page, stack, KNS08_BINDINGS[0]).catch(String)) });
      }
      throw error;
    } finally {
      await context?.close();
      await stack.close();
      await rm(profile, { recursive: true, force: true });
    }
  });
}
