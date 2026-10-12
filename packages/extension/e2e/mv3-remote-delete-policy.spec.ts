/**
 * P1-02 device remote-delete policy dual-Profile matrix.
 * Reuses kns-08-harness profileA/profileB. Do not copy Profile management.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  KNS08_BINDINGS, PUBLIC_URL, assertQueueTerminal, confirmFirstRun, grantBookmarks, launchPersistent,
  login, optionsPage, scopeFacts, specialRoots, startRealStack, waitFirstRunProductQuiet, waitQueueQuiet,
  waitTitles, waitTitlesGone, wakeEngine, type ProfileBinding,
} from './kns-08-harness.js';
import { showOptionsPane } from './extension-auth.js';
import { exportedScope, mappingsByNative } from './first-run-remediation-oracle.js';

const bindingA = KNS08_BINDINGS[0];
const bindingB = KNS08_BINDINGS[1];

test.describe.configure({ timeout: 240_000 });

test('confirm parks B-side Chrome delete until apply, then trees match', async () => {
  const stack = await startRealStack();
  const dirs = await twinDirs();
  let a: BrowserContext | undefined; let b: BrowserContext | undefined;
  try {
    a = await launchPersistent(dirs.a, stack.browserHostResolverRules);
    b = await launchPersistent(dirs.b, stack.browserHostResolverRules);
    const pageA = await ready(a, bindingA);
    const pageB = await ready(b, bindingB);
    const rootsA = await specialRoots(pageA);
    const rootsB = await specialRoots(pageB);
    await pageA.evaluate(async ({ barId, url }) => {
      await chrome.bookmarks.create({ parentId: barId, title: 'P102 confirm item', url });
    }, { barId: rootsA.barId, url: PUBLIC_URL });
    await confirmFirstRun(pageA, [rootsA.barTitle]);
    await waitFirstRunProductQuiet(pageA, stack, bindingA);
    await confirmFirstRun(pageB, [rootsB.barTitle]);
    await waitFirstRunProductQuiet(pageB, stack, bindingB);
    await waitTitles(pageB, ['P102 confirm item']);
    await setPolicy(pageB, 'confirm');

    await pageA.evaluate(async () => {
      const walk = async (nodes: chrome.bookmarks.BookmarkTreeNode[]): Promise<string | undefined> => {
        for (const node of nodes) {
          if (node.title === 'P102 confirm item' && node.url) return node.id;
          if (node.children) { const found = await walk(node.children); if (found) return found; }
        }
      };
      const id = await walk((await chrome.bookmarks.getTree())[0]?.children ?? []);
      if (!id) throw new Error('confirm_item_missing');
      await chrome.bookmarks.remove(id);
    });
    await waitQueueQuiet(pageA, stack, bindingA, 90_000);
    await expect.poll(async () => {
      await wakeEngine(pageB);
      const pending = await pendingStatus(pageB);
      const present = (await treeTitles(pageB)).includes('P102 confirm item');
      return pending.ok && pending.policy === 'confirm' && present && pending.pendingCount > 0
        ? 'parked' : `policy=${pending.policy} pending=${pending.pendingCount} present=${present}`;
    }, { timeout: 90_000 }).toBe('parked');
    const beforeCursor = (await exportedScope(pageB)).cursor?.cursor ?? null;

    await applyFirstPending(pageB);
    await waitTitlesGone(pageB, ['P102 confirm item']);
    await wakeEngine(pageB);
    expect((await treeTitles(pageB)).includes('P102 confirm item')).toBe(false);
    const factsB = await scopeFacts(pageB, stack, bindingB);
    assertQueueTerminal(factsB);
    const exported = await exportedScope(pageB);
    expect(exported.pullEvents?.every((event: { state: string }) => event.state === 'page_complete'
      || event.state === 'authority_committed')).toBe(true);
    expect(exported.cursor?.cursor ?? factsB.cursor).not.toBe(beforeCursor);
  } finally {
    await closeAll(a, b); await rmDirs(dirs); await stack.close();
  }
});

test('keep-local leaves B Chrome copy, does not re-upload, and A deletion stays on the server', async () => {
  const stack = await startRealStack();
  const dirs = await twinDirs();
  let a: BrowserContext | undefined; let b: BrowserContext | undefined;
  try {
    a = await launchPersistent(dirs.a, stack.browserHostResolverRules);
    b = await launchPersistent(dirs.b, stack.browserHostResolverRules);
    const pageA = await ready(a, bindingA);
    const pageB = await ready(b, bindingB);
    const rootsA = await specialRoots(pageA);
    const rootsB = await specialRoots(pageB);
    await pageA.evaluate(async ({ barId, url }) => {
      await chrome.bookmarks.create({ parentId: barId, title: 'P102 keep item', url });
    }, { barId: rootsA.barId, url: PUBLIC_URL });
    await confirmFirstRun(pageA, [rootsA.barTitle]);
    await waitFirstRunProductQuiet(pageA, stack, bindingA);
    await confirmFirstRun(pageB, [rootsB.barTitle]);
    await waitFirstRunProductQuiet(pageB, stack, bindingB);
    await waitTitles(pageB, ['P102 keep item']);
    await setPolicy(pageB, 'keep_local');

    const nativeB = await pageB.evaluate(async () => {
      const walk = (nodes: chrome.bookmarks.BookmarkTreeNode[]): string | undefined => {
        for (const node of nodes) {
          if (node.title === 'P102 keep item' && node.url) return node.id;
          if (node.children) { const found = walk(node.children); if (found) return found; }
        }
      };
      return walk((await chrome.bookmarks.getTree())[0]?.children ?? []);
    });
    if (!nativeB) throw new Error('keep_item_native_missing');
    await pageA.evaluate(async () => {
      const walk = async (nodes: chrome.bookmarks.BookmarkTreeNode[]): Promise<string | undefined> => {
        for (const node of nodes) {
          if (node.title === 'P102 keep item' && node.url) return node.id;
          if (node.children) { const found = await walk(node.children); if (found) return found; }
        }
      };
      const id = await walk((await chrome.bookmarks.getTree())[0]?.children ?? []);
      if (!id) throw new Error('keep_item_missing');
      await chrome.bookmarks.remove(id);
    });
    await waitQueueQuiet(pageA, stack, bindingA, 90_000);
    await wakeEngine(pageB);
    await expect.poll(async () => {
      const exported = await exportedScope(pageB);
      return exported.localSyncExclusions?.length ?? 0;
    }, { timeout: 90_000 }).toBeGreaterThan(0);
    expect((await treeTitles(pageB)).includes('P102 keep item')).toBe(true);
    const mapping = mappingsByNative(await exportedScope(pageB)).get(nativeB);
    expect(mapping).toBeUndefined();

    await pageB.evaluate((id) => chrome.bookmarks.update(id, { title: 'P102 keep item local' }), nativeB);
    await pageB.waitForTimeout(1_000);
    const factsB = await scopeFacts(pageB, stack, bindingB);
    expect(factsB.queueTypes.includes('create_node')).toBe(false);
    const deleted = await stack.listDeletedCanonicalNodes();
    expect(deleted.some((row) => row.kind === 'bookmark')).toBe(true);
    assertQueueTerminal(factsB);
  } finally {
    await closeAll(a, b); await rmDirs(dirs); await stack.close();
  }
});

async function setPolicy(page: Page, policy: 'confirm' | 'keep_local'): Promise<void> {
  await showOptionsPane(page, 'sync-center');
  const current = await pendingStatus(page);
  const result = await page.evaluate((payload) => chrome.runtime.sendMessage(payload), {
    kind: 'known.remoteDelete.policy.set', policy, expectedCasVersion: current.casVersion ?? 0, userGesture: true,
  }) as { ok?: boolean; policy?: string; error?: string };
  if (!result?.ok) throw new Error(`policy_set_failed:${JSON.stringify(result)}`);
  await expect(page.locator('#remote-delete-policy')).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => {
    const status = await pendingStatus(page);
    return status.ok && status.policy === policy ? 'ok' : `policy=${status.policy ?? status.error}`;
  }, { timeout: 15_000 }).toBe('ok');
}

async function applyFirstPending(page: Page): Promise<void> {
  await showOptionsPane(page, 'sync-center');
  const status = await pendingStatus(page);
  const item = status.pending?.[0];
  if (!item) throw new Error('pending_delete_missing');
  const result = await page.evaluate((payload) => chrome.runtime.sendMessage(payload), {
    kind: 'known.remoteDelete.decide', decisionId: item.decisionId, action: 'apply',
    expectedCasVersion: item.casVersion, deleteRevision: item.deleteRevision, userGesture: true,
  }) as { ok?: boolean };
  if (!result?.ok) throw new Error(`apply_failed:${JSON.stringify(result)}`);
}

async function pendingStatus(page: Page): Promise<any> {
  return page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.remoteDelete.pending.list' }));
}

async function treeTitles(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const titles: string[] = [];
    const walk = (nodes: chrome.bookmarks.BookmarkTreeNode[]) => {
      for (const node of nodes) {
        titles.push(node.title ?? '');
        if (node.children) walk(node.children);
      }
    };
    walk((await chrome.bookmarks.getTree())[0]?.children ?? []);
    return titles;
  });
}

async function ready(context: BrowserContext, binding: ProfileBinding): Promise<Page> {
  const page = await optionsPage(context);
  await login(page, binding);
  await grantBookmarks(page);
  return page;
}

async function twinDirs(): Promise<{ a: string; b: string }> {
  return {
    a: await mkdtemp(resolve(tmpdir(), 'known-p102-a-')),
    b: await mkdtemp(resolve(tmpdir(), 'known-p102-b-')),
  };
}

async function closeAll(...contexts: Array<BrowserContext | undefined>): Promise<void> {
  await Promise.all(contexts.map(async (context) => { if (context) await context.close().catch(() => undefined); }));
}

async function rmDirs(dirs: { a: string; b: string }): Promise<void> {
  await Promise.all([rm(dirs.a, { recursive: true, force: true }), rm(dirs.b, { recursive: true, force: true })]);
}
