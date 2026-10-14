import { chromium, expect, test, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { automationState, putAutomationState } from './automation-store.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { openExtensionOptions } from './extension-auth.js';
import { compiledRule, ruleBundle } from '../tests/automation-fixture.js';

/**
 * AW-20 in real Chromium (xvfb). Bookmarks created through chrome.bookmarks
 * from a page raise the same onCreated event as the browser's star dialog;
 * Playwright cannot press the browser's own star button. The Sync scope is
 * the evidence build's (the bookmarks bar is the synced range); the rule
 * bundle is installed as the worker would after a refresh.
 */
const extensionPath = resolve(import.meta.dirname, '../dist/production');
const scope = { environment: 'production', serverId: 'https://api.known.example', serverOrigin: 'https://api.known.example',
  accountId: 'account-aw-20', browserProfileId: 'profile-aw-20', collectionId: 'collection-aw-20', replicaId: 'replica-aw-20', generation: 1 } as const;
const SERVER_UUID = 'server-aw-20';
const folder = (nodeId: string) => ({ serverUuid: SERVER_UUID, collectionId: scope.collectionId, nodeId });

test('a page starred into a browser root is filed by rule once; the Owner’s folder and Sync projections are left alone', async () => {
  test.setTimeout(90_000);
  const profile = await mkdtemp(resolve(tmpdir(), 'known-aw-20-profile-'));
  const context = await chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium',
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
  try {
    const page = (await openExtensionOptions(context)).page;
    await grantBookmarks(page);
    const bar = (await page.evaluate(() => chrome.bookmarks.getTree()))[0]!.children![0]!.id;
    await evidence(page, 'configureEventEvidence', scope, bar, null);
    // The rule's folder and another folder, both confirmed by the server.
    const academic = await page.evaluate((parentId) => chrome.bookmarks.create({ parentId, title: 'Academic' }), bar);
    await waitForMapping(page, academic.id); await evidence(page, 'confirmBookmarkEventEvidence', scope, academic.id, 'rev-academic', 'academic');
    const reading = await page.evaluate((parentId) => chrome.bookmarks.create({ parentId, title: 'Reading' }), bar);
    await waitForMapping(page, reading.id); await evidence(page, 'confirmBookmarkEventEvidence', scope, reading.id, 'rev-reading', 'reading');

    // arXiv pages go to Academic; a second rule matches the page Sync projects below.
    const scoped = { scope: { collectionId: scope.collectionId } };
    const bundle = ruleBundle([compiledRule({ folder: folder('academic'), definition: scoped }),
      compiledRule({ ruleId: 'rule-example', host: 'example.test', folder: folder('academic'), definition: scoped })], { issuedAt: Date.now() });
    await putAutomationState(page, 'known.automation.bundle.v1', {
      version: 1, ownerKey: JSON.stringify([scope.serverOrigin, scope.accountId]), bundle, serverUuid: SERVER_UUID,
      installedAt: Date.now(), lastRefreshAt: Date.now(), lastAttemptAt: Date.now(), failures: 0, pausedSince: null, problem: null });

    // AC-09: starred into the Bookmarks bar.
    const starred = await page.evaluate((parentId) => chrome.bookmarks.create({ parentId, title: 'Attention Is All You Need',
      url: 'https://arxiv.org/abs/1706.03762' }), bar);
    await page.waitForTimeout(1_500);
    expect(await parentOf(page, starred.id)).toBe(bar); // still settling
    await expect.poll(() => parentOf(page, starred.id), { timeout: 10_000 }).toBe(academic.id);
    // AC-49: picked a folder in the dialog (created there), or moved it there before it settled.
    const chosen = await page.evaluate((parentId) => chrome.bookmarks.create({ parentId, title: 'Scaling Laws',
      url: 'https://arxiv.org/abs/2001.08361' }), reading.id);
    const redirected = await page.evaluate(async ({ bar, reading }) => {
      const node = await chrome.bookmarks.create({ parentId: bar, title: 'GPT-3', url: 'https://arxiv.org/abs/2005.14165' });
      await chrome.bookmarks.move(node.id, { parentId: reading }); return node;
    }, { bar, reading: reading.id });
    // AC-12 locally: a bookmark Sync projects from the server is never intake here.
    await evidence(page, 'stagePullCreateEvidence', scope, bar);
    const projected = (await page.evaluate(() => chrome.bookmarks.search({ url: 'https://example.test/' })))[0]!;
    await page.waitForTimeout(6_000);

    expect(await parentOf(page, chosen.id)).toBe(reading.id);
    expect(await parentOf(page, redirected.id)).toBe(reading.id);
    expect(await parentOf(page, projected.id)).toBe(bar);
    expect(await parentOf(page, starred.id)).toBe(academic.id);
    // One move for the starred page, staged for Sync like any other.
    const exported = await evidence<{ bookmarkEvents: { nativeId: string; kind: string }[] }>(page, 'exportScope', scope);
    expect(exported.bookmarkEvents.filter((event) => event.nativeId === starred.id).map((event) => event.kind)).toEqual(['create', 'move']);
    // One notice, and one receipt naming the placement.
    const notice = 'Moved “Attention Is All You Need” to Academic by rule “Place research papers in Academic”.';
    expect(await page.evaluate(() => (chrome.action as unknown as { getTitle(details: object): Promise<string> }).getTitle({}))).toBe(notice);
    expect(await page.evaluate(async () => (await chrome.storage.local.get('known.save.feedback.v1'))['known.save.feedback.v1']))
      .toMatchObject({ code: 'saved', entry: 'page', message: notice, nativeId: starred.id });
    const receipts = await automationState<{ path: string; native: { nativeId: string; destinationNativeId: string }; beforeFolder?: { nodeId: string } }[]>(
      page, 'known.automation.receipts.v1');
    expect(receipts).toEqual([expect.objectContaining({ path: 'observed', native: expect.objectContaining({ nativeId: starred.id,
      destinationNativeId: academic.id }), beforeFolder: expect.objectContaining({ nodeId: 'event-evidence-root' }) })]);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

async function grantBookmarks(page: Page) {
  await page.evaluate(() => {
    const button = document.createElement('button'); button.textContent = 'Grant automation access';
    button.addEventListener('click', () => { void chrome.permissions.request({ permissions: ['bookmarks'] }); });
    document.body.append(button);
  });
  await grantOptionalBookmarks(page, 'Grant automation access', 'Known automation permission');
  await expect.poll(() => page.evaluate(() => chrome.permissions.contains({ permissions: ['bookmarks'] }))).toBe(true);
}
async function evidence<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  const result = await page.evaluate(({ method, args }) => chrome.runtime.sendMessage({ kind: 'known.sync-state.evidence', method, args }),
    { method, args }) as { readonly ok: boolean; readonly error?: string; readonly value?: T };
  if (!result.ok) throw new Error(result.error ?? 'evidence_failed'); return result.value as T;
}
async function waitForMapping(page: Page, nativeId: string) {
  await expect.poll(async () => (await evidence<{ mappings: { nativeId: string }[] }>(page, 'exportScope', scope)).mappings
    .some((mapping) => mapping.nativeId === nativeId)).toBe(true);
}
async function parentOf(page: Page, nativeId: string): Promise<string | undefined> {
  return page.evaluate(async (id) => (await chrome.bookmarks.get(id))[0]?.parentId, nativeId);
}
