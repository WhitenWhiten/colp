import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { openExtensionOptions } from './extension-auth.js';
import type { BookmarkEventRecord, MountBindingRecord, QueueOperation } from '../src/sync-state-store.js';

interface EventEvidence {
  readonly queue: readonly QueueOperation[];
  readonly bookmarkEvents: readonly BookmarkEventRecord[];
  readonly mountBindings: readonly MountBindingRecord[];
}

const EXTENSION_ID = 'pplpnpegpnghcddhmpgkbfkdfadjiaen';
const extensionPath = resolve(import.meta.dirname, '../dist/production');
const scope = { environment: 'production', serverId: 'https://api.known.example',
  serverOrigin: 'https://api.known.example', accountId: 'account-p3-30', browserProfileId: 'profile-p3-30',
  collectionId: 'collection-p3-30', replicaId: 'replica-p3-30', generation: 1 } as const;

test('real Chrome events survive worker/browser restarts with stable unique sequence and zero private records', async () => {
  const profile = await mkdtemp(resolve(tmpdir(), 'known-p3-30-profile-'));
  let context = await launch(profile);
  const observed: string[] = []; observe(context, observed);
  try {
    let page = await extensionPage(context);
    await grantBookmarks(page);
    await assertWorkerRuntime(context);
    const roots = await page.evaluate(() => chrome.bookmarks.getTree());
    const bar = roots[0]!.children![0]!.id; const other = roots[0]!.children![1]!.id;
    const selected = await page.evaluate((parentId) => chrome.bookmarks.create({ parentId, title: 'P3-30 selected' }), bar);
    const privateRoot = await page.evaluate((parentId) => chrome.bookmarks.create({ parentId, title: 'P3-30 private' }), bar);
    await evidence(page, 'configureEventEvidence', scope, selected.id, privateRoot.id);
    const configured = await evidence<EventEvidence>(page, 'exportScope', scope);
    expect(configured.mountBindings).toEqual([expect.objectContaining({
      nativeRootId: selected.id, status: 'active',
    })]);

    const folder = await page.evaluate((parentId) => chrome.bookmarks.create({ parentId, title: 'Folder' }), selected.id);
    await waitForQueue(page, 1); await evidence(page, 'confirmBookmarkEventEvidence', scope, folder.id, 'server-folder-r1');
    const bookmark = await page.evaluate((parentId) => chrome.bookmarks.create({ parentId, title: 'Bookmark',
      url: 'https://example.test/p3-30' }), selected.id);
    await waitForQueue(page, 2); await evidence(page, 'confirmBookmarkEventEvidence', scope, bookmark.id, 'server-bookmark-r1');
    await page.evaluate((id) => chrome.bookmarks.update(id, { title: 'Bookmark updated' }), bookmark.id);
    await waitForQueue(page, 3); await evidence(page, 'confirmBookmarkEventEvidence', scope, bookmark.id, 'server-bookmark-r2');
    await page.evaluate(({ id, parentId }) => chrome.bookmarks.move(id, { parentId, index: 0 }),
      { id: bookmark.id, parentId: folder.id });
    await waitForQueue(page, 4); await evidence(page, 'confirmBookmarkEventEvidence', scope, bookmark.id, 'server-bookmark-r3');
    const privateBookmark = await page.evaluate((parentId) => chrome.bookmarks.create({ parentId, title: 'PRIVATE-QUEUE-SENTINEL',
      url: 'https://sentinel.invalid/private-queue' }), privateRoot.id);
    const unselectedBookmark = await page.evaluate((parentId) => chrome.bookmarks.create({ parentId, title: 'UNSELECTED-QUEUE-SENTINEL',
      url: 'https://sentinel.invalid/unselected-queue' }), other);

    await expect.poll(async () => (await evidence<any>(page, 'exportScope', scope)).queue.length).toBeGreaterThanOrEqual(4);

    await terminateExtensionWorker(context, page);
    page = await extensionPage(context);
    await evidence(page, 'recoverBookmarkEventEvidence', scope);
    await page.evaluate((id) => chrome.bookmarks.removeTree(id), folder.id);
    await evidence(page, 'recoverBookmarkEventEvidence', scope);
    await expect.poll(async () => (await evidence<any>(page, 'exportScope', scope)).bookmarkEvents.length,
      { timeout: 15_000 }).toBeGreaterThan(4);
    const removedState = await evidence<any>(page, 'exportScope', scope);
    expect(removedState.queue.map((record: any) => record.payload.type)).toContain('delete_subtree');
    await terminateExtensionWorker(context, page);
    await context.close();

    context = await launch(profile); observe(context, observed); page = await extensionPage(context);
    await evidence(page, 'recoverBookmarkEventEvidence', scope);
    const exported = await evidence<any>(page, 'exportScope', scope);
    expect(exported.queue.length).toBeGreaterThanOrEqual(5);
    expect(exported.queue.map((record: any) => record.sequence)).toEqual(
      Array.from({ length: exported.queue.length }, (_, index) => index + 1));
    expect(new Set(exported.queue.map((record: any) => record.sequence)).size).toBe(exported.queue.length);
    expect(exported.queue.some((record: any) => record.payload.type === 'delete_subtree')).toBe(true);
    expect(exported.bookmarkEvents.every((event: any) => event.nativeId !== privateBookmark.id
      && event.nativeId !== unselectedBookmark.id)).toBe(true);
    for (const record of exported.queue) {
      expect(containsValue(record.payload, folder.id)).toBe(false);
      expect(containsValue(record.payload, bookmark.id)).toBe(false);
    }
    expect(JSON.stringify(exported)).not.toContain('PRIVATE-QUEUE-SENTINEL');
    expect(JSON.stringify(exported)).not.toContain('UNSELECTED-QUEUE-SENTINEL');
    expect(JSON.stringify(exported)).not.toContain('sentinel.invalid');
    expect(observed.join('\n')).not.toMatch(/PRIVATE-QUEUE-SENTINEL|UNSELECTED-QUEUE-SENTINEL|sentinel\.invalid/);
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});

test('crash points recover accepted events exactly once without sequence gaps', async () => {
  // Three crash points, each with two browser launches; CI ran 42.8s against
  // the config's 45s, so any runner jitter timed the test out.
  test.setTimeout(120_000);
  for (const crashPoint of ['after_event', 'after_sequence', 'after_queue'] as const) {
    const profile = await mkdtemp(resolve(tmpdir(), `known-p3-30-${crashPoint}-`));
    let context = await launch(profile);
    try {
      let page = await extensionPage(context); await grantBookmarks(page);
      await assertWorkerRuntime(context);
      const roots = await page.evaluate(() => chrome.bookmarks.getTree()); const bar = roots[0]!.children![0]!.id;
      const selected = await page.evaluate((parentId) => chrome.bookmarks.create({ parentId, title: 'Crash selected' }), bar);
      await evidence(page, 'configureEventEvidence', scope, selected.id, null, crashPoint);
      const bookmark = await page.evaluate((parentId) => chrome.bookmarks.create({ parentId, title: `Crash ${parentId}`,
        url: 'https://example.test/crash' }), selected.id);
      // Prove ingress staged this event and the injected transaction aborted
      // before restart; a tree scan alone must not satisfy a crash-point test.
      await expect.poll(async () => (await evidence<EventEvidence>(page, 'exportScope', scope))
        .bookmarkEvents.filter((event) => event.nativeId === bookmark.id).map((event) => event.status))
        .toEqual(['pending']);
      const failed = await evidence<EventEvidence>(page, 'exportScope', scope);
      expect(failed.queue).toEqual([]);
      await expect.poll(() => page.evaluate(async () => {
        const alarms = chrome.alarms as typeof chrome.alarms & {
          getAll(): Promise<Array<{ name: string }>>;
        };
        return (await alarms.getAll()).some((alarm) => alarm.name === 'known-bookmark-capture-recovery');
      })).toBe(true);
      await terminateExtensionWorker(context, page); await context.close();
      context = await launch(profile); page = await extensionPage(context);
      await evidence(page, 'recoverBookmarkEventEvidence', scope);
      const exported = await evidence<any>(page, 'exportScope', scope);
      expect(exported.queue.map((record: any) => record.sequence)).toEqual([1]);
    } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
  }
});

async function launch(profile: string) {
  return chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium', args: [
    `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
  ] });
}
async function extensionPage(context: BrowserContext) {
  return (await openExtensionOptions(context)).page;
}
async function grantBookmarks(page: Page) {
  await page.evaluate(() => {
    const button = document.createElement('button'); button.id = 'p3-30-grant'; button.textContent = 'Grant event access';
    button.addEventListener('click', () => { void chrome.permissions.request({ permissions: ['bookmarks'] }); });
    document.body.append(button);
  });
  await grantOptionalBookmarks(page, 'Grant event access', 'Known event permission');
  await expect.poll(() => page.evaluate(() => chrome.permissions.contains({ permissions: ['bookmarks'] }))).toBe(true);
}
async function evidence<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  const result = await page.evaluate(({ method, args }) => chrome.runtime.sendMessage({
    kind: 'known.sync-state.evidence', method, args,
  }), { method, args }) as { readonly ok: boolean; readonly error?: string; readonly value?: T };
  if (!result.ok) throw new Error(result.error ?? 'evidence_failed'); return result.value as T;
}
async function waitForQueue(page: Page, length: number) {
  await expect.poll(async () => (await evidence<any>(page, 'exportScope', scope)).queue.length).toBe(length);
}
async function terminateExtensionWorker(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page); await cdp.send('ServiceWorker.enable');
  const targets = await cdp.send('Target.getTargets');
  const target = targets.targetInfos.find((item) => item.type === 'service_worker' && item.url.includes(EXTENSION_ID));
  expect(target).toBeTruthy(); await cdp.send('Target.closeTarget', { targetId: target!.targetId }); await cdp.detach();
}
function observe(context: BrowserContext, output: string[]) {
  context.on('request', (request) => output.push(`request:${request.url()}`));
  context.on('console', (message) => output.push(`console:${message.text()}`));
}
async function assertWorkerRuntime(context: BrowserContext) {
  await expect.poll(() => context.serviceWorkers().length).toBe(1);
  expect(await context.serviceWorkers()[0]!.evaluate(() => self.location.href)).toContain(EXTENSION_ID);
}
function containsValue(value: unknown, target: string): boolean {
  if (value === target) return true;
  if (!value || typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).some((child) => containsValue(child, target));
}
