import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { automationIntents, automationState, putAutomationIntent } from './automation-store.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { EXTENSION_ID, openExtensionOptions } from './extension-auth.js';
import { compiledRule, ruleBundle } from '../tests/automation-fixture.js';

/**
 * AW-21 / AC-10 in real Chromium (xvfb): the installed rules, the placement
 * receipts and the write-ahead intents of observed moves outlive a killed
 * worker and a browser restart, and nothing is moved twice. The server's join
 * of a receipt to its Sync operation needs a server; it is covered by the
 * AW-50 receipt tests against the server's own digests.
 */
const extensionPath = resolve(import.meta.dirname, '../dist/production');
const scope = { environment: 'production', serverId: 'https://api.known.example', serverOrigin: 'https://api.known.example',
  accountId: 'account-aw-21', browserProfileId: 'profile-aw-21', collectionId: 'collection-aw-21', replicaId: 'replica-aw-21', generation: 1 } as const;
const SERVER_UUID = 'server-aw-21';
const OWNER_KEY = JSON.stringify([scope.serverOrigin, scope.accountId]);
const BUNDLE_KEY = 'known.automation.bundle.v1', RECEIPTS_KEY = 'known.automation.receipts.v1';
const folder = (nodeId: string) => ({ serverUuid: SERVER_UUID, collectionId: scope.collectionId, nodeId });
interface Receipt { readonly localReceiptId: string; readonly path: string; readonly state: string; readonly native: { readonly nativeId: string } }

test('rules, receipts and observed moves survive a killed worker and a browser restart, and nothing moves twice', async () => {
  test.setTimeout(150_000);
  const profile = await mkdtemp(resolve(tmpdir(), 'known-aw-21-profile-'));
  let context = await launch(profile);
  try {
    let page = (await openExtensionOptions(context)).page;
    await grantBookmarks(page);
    const bar = (await page.evaluate(() => chrome.bookmarks.getTree()))[0]!.children![0]!.id;
    await evidence(page, 'configureEventEvidence', scope, bar, null);
    const academic = await page.evaluate((parentId) => chrome.bookmarks.create({ parentId, title: 'Academic' }), bar);
    await waitForMapping(page, academic.id); await evidence(page, 'confirmBookmarkEventEvidence', scope, academic.id, 'rev-academic', 'academic');

    // An earlier build kept the installed bundle in chrome.storage.local.
    const bundle = ruleBundle([compiledRule({ folder: folder('academic'), definition: { scope: { collectionId: scope.collectionId } } })],
      { issuedAt: Date.now() });
    await page.evaluate(({ key, record }) => chrome.storage.local.set({ [key]: record }), { key: BUNDLE_KEY, record: {
      version: 1, ownerKey: OWNER_KEY, bundle, serverUuid: SERVER_UUID,
      installedAt: Date.now(), lastRefreshAt: Date.now(), lastAttemptAt: Date.now(), pausedSince: null, problem: null } });

    // Worker kill: the next worker moves it into IndexedDB, once.
    await stopWorker(context, page);
    await evidence(page, 'recoverBookmarkEventEvidence', scope);
    await expect.poll(() => automationState(page, BUNDLE_KEY)).toMatchObject({ ownerKey: OWNER_KEY, bundle: { revision: bundle.revision } });
    expect(await page.evaluate((key) => chrome.storage.local.get(key), BUNDLE_KEY)).toEqual({});

    // Starred into the Bookmarks bar and filed by the migrated rules.
    const starred = await page.evaluate((parentId) => chrome.bookmarks.create({ parentId, title: 'Attention Is All You Need',
      url: 'https://arxiv.org/abs/1706.03762' }), bar);
    await expect.poll(() => parentOf(page, starred.id), { timeout: 10_000 }).toBe(academic.id);
    await expect.poll(async () => (await receipts(page)).length).toBe(1);
    const filed = (await receipts(page))[0]!;
    expect(filed).toMatchObject({ path: 'observed', state: 'local', native: { nativeId: starred.id } });
    expect(await automationIntents(page)).toEqual([]);

    // A worker stopped between two moves and their receipts: one move reached the bookmark tree,
    // the other never happened. Only their intents were written.
    const moved = await page.evaluate((parentId) => chrome.bookmarks.create({ parentId, title: 'Scaling Laws',
      url: 'https://arxiv.org/abs/2001.08361' }), academic.id);
    const unmoved = await page.evaluate((parentId) => chrome.bookmarks.create({ parentId, title: 'Notes',
      url: 'https://example.org/notes' }), bar);
    for (const [intentId, node] of [['intent-moved', moved], ['intent-unmoved', unmoved]] as const) {
      await putAutomationIntent(page, intent(intentId, node, academic.id, bar));
    }
    await stopWorker(context, page);
    await evidence(page, 'recoverBookmarkEventEvidence', scope);
    // The automation alarm resumes them for this account.
    await page.evaluate(() => chrome.alarms.create('known-automation', { when: Date.now() + 200 }));
    await expect.poll(() => automationIntents(page), { timeout: 15_000 }).toEqual([]);
    const recovered = await receipts(page);
    expect(recovered.map((receipt) => receipt.localReceiptId).sort()).toEqual([filed.localReceiptId, 'intent-moved'].sort());
    expect(recovered.find((receipt) => receipt.localReceiptId === 'intent-moved')).toMatchObject({ path: 'observed', native: { nativeId: moved.id } });
    // A move that never happened is not made late.
    expect(await parentOf(page, unmoved.id)).toBe(bar);

    // Browser restart: everything is still there, and the starred page is not filed again.
    const before = { bundle: await automationState(page, BUNDLE_KEY), receipts: recovered };
    await context.close();
    context = await launch(profile);
    page = (await openExtensionOptions(context)).page;
    await evidence(page, 'recoverBookmarkEventEvidence', scope);
    expect(await automationState(page, BUNDLE_KEY)).toEqual(before.bundle);
    expect(await receipts(page)).toEqual(before.receipts);
    await page.waitForTimeout(5_000);
    expect(await parentOf(page, starred.id)).toBe(academic.id);
    expect(await parentOf(page, unmoved.id)).toBe(bar);
    const exported = await evidence<{ bookmarkEvents: { nativeId: string; kind: string }[] }>(page, 'exportScope', scope);
    // One create and one move (the export after a restart is not in staging order).
    expect(exported.bookmarkEvents.filter((event) => event.nativeId === starred.id).map((event) => event.kind).sort()).toEqual(['create', 'move']);
    expect(await receipts(page)).toEqual(before.receipts);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

function launch(profile: string) {
  return chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium',
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
}
function intent(intentId: string, node: chrome.bookmarks.BookmarkTreeNode, destinationNativeId: string, fromParentId: string) {
  const rule = compiledRule();
  return { intentId, id: intentId, ownerKey: OWNER_KEY, fromParentId, dateAdded: node.dateAdded ?? null, createdAt: Date.now(),
    automation: { outcome: 'placed', ruleIds: [rule.ruleId], bundleRevision: 'b-aw-21', settingsRevision: 1, satisfies: ['classify.root'],
      rule: { id: rule.ruleId, name: rule.definition.name, revision: rule.ruleRevision, bindingRevision: rule.bindingRevision, semanticDigest: rule.semanticDigest },
      destination: folder('academic'), folderTitle: 'Academic', fromNativeId: fromParentId,
      collectionId: scope.collectionId, replicaId: scope.replicaId, generation: scope.generation },
    page: { title: node.title, url: node.url }, native: { nativeId: node.id, destinationNativeId, movedAt: Date.now() } };
}
async function receipts(page: Page): Promise<Receipt[]> { return await automationState<Receipt[]>(page, RECEIPTS_KEY) ?? []; }
async function stopWorker(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  const target = (await cdp.send('Target.getTargets')).targetInfos
    .find((item) => item.type === 'service_worker' && item.url.includes(EXTENSION_ID));
  expect(target).toBeTruthy();
  await cdp.send('Target.closeTarget', { targetId: target!.targetId }); await cdp.detach();
}
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
