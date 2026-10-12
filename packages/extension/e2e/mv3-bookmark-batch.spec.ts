/**
 * P2-02 dual-Profile undoable batch delete.
 * Reuses e2e/kns-08-harness.ts. Delete undo must restore the original COLP Node id.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { assertUniqueMappings, chromeTree, exportedScope, mappingsByNative } from './first-run-remediation-oracle.js';
import {
  KNS08_BINDINGS, PUBLIC_URL, assertQueueTerminal, captureReplayFacts, collectLogs, confirmFirstRun,
  drainBookmarkEvents, grantBookmarks, launchPersistent, login, optionsPage, saveReplayFixture,
  specialRoots, startRealStack, scopeFacts, treeProjection, liveCanonical, waitFirstRunProductQuiet,
  waitQueueQuiet, waitTitles, waitTitlesGone, wakeEngine, writeScenarioEvidence, type ProfileBinding,
} from './kns-08-harness.js';

const bindingA = KNS08_BINDINGS[0];
const bindingB = KNS08_BINDINGS[1];

test.describe.configure({ timeout: 600_000 });

test('P2-02 batch delete undo restores the original COLP Node id on both Profiles', async ({}, testInfo) => {
  const id = 'P2-02-batch-delete-undo';
  const stack = await startRealStack();
  const dirs = await twinDirs();
  let a: BrowserContext | undefined; let b: BrowserContext | undefined;
  try {
    a = await launchPersistent(dirs.a, stack.browserHostResolverRules);
    b = await launchPersistent(dirs.b, stack.browserHostResolverRules);
    const logs = collectLogs(a);
    const pageA = await ready(a, bindingA);
    const pageB = await ready(b, bindingB);
    const rootsA = await specialRoots(pageA);
    const rootsB = await specialRoots(pageB);
    await pageA.evaluate(async ({ barId, url }) => {
      await chrome.bookmarks.create({ parentId: barId, title: 'P2-02 batch item', url });
    }, { barId: rootsA.barId, url: PUBLIC_URL });
    const start = await treeProjection(pageA);
    await confirmFirstRun(pageA, [rootsA.barTitle]);
    await waitFirstRunProductQuiet(pageA, stack, bindingA);
    await confirmFirstRun(pageB, [rootsB.barTitle]);
    await waitFirstRunProductQuiet(pageB, stack, bindingB);
    await waitTitles(pageB, ['P2-02 batch item']);
    const before = mappingsByNative(await exportedScope(pageA));
    const native = (await chromeTree(pageA)).find((node) => node.title === 'P2-02 batch item');
    expect(native).toBeTruthy();
    const colpId = before.get(native!.id)?.colpId;
    expect(colpId).toBeTruthy();

    await openManager(pageA);
    const row = pageA.locator(`.mgr-row[data-id="${native!.id}"]`);
    await row.locator('input.mgr-select').check();
    await pageA.getByRole('button', { name: 'Delete selected' }).click();
    await pageA.locator('#manager-batch-confirm').click();
    await expect(pageA.locator('#manager-feedback')).toHaveText(/Deleted/);
    await waitTitlesGone(pageA, ['P2-02 batch item']);
    await drainBookmarkEvents(pageA);
    await waitQueueQuiet(pageA, stack, bindingA, 90_000);
    await expect(pageA.getByRole('button', { name: 'Undo' })).toBeVisible();
    await pageA.getByRole('button', { name: 'Undo' }).click();
    await drainBookmarkEvents(pageA);
    await waitQueueQuiet(pageA, stack, bindingA, 90_000);
    await wakeEngine(pageA); await wakeEngine(pageB);
    await waitTitles(pageA, ['P2-02 batch item'], 90_000);
    await waitTitles(pageB, ['P2-02 batch item']);

    const canonical = (await liveCanonical(stack)).filter((node) => node.id === colpId);
    expect(canonical).toHaveLength(1);
    for (const page of [pageA, pageB]) {
      const tree = await chromeTree(page);
      const match = tree.find((node) => node.title === 'P2-02 batch item');
      expect(match).toBeTruthy();
      const exported = await exportedScope(page);
      assertUniqueMappings(exported);
      expect(mappingsByNative(exported).get(match!.id)?.colpId).toBe(colpId);
    }
    const factsA = await scopeFacts(pageA, stack, bindingA);
    const factsB = await scopeFacts(pageB, stack, bindingB);
    assertQueueTerminal(factsA);
    assertQueueTerminal(factsB);
    await writeScenarioEvidence({
      testInfo, id, startDigest: start.digest, ops: ['delete_node', 'restore_node'],
      endTree: { a: (await treeProjection(pageA)).digest, b: (await treeProjection(pageB)).digest },
      mapping: { a: factsA.mappingCount, b: factsB.mappingCount, restoredIdentityVerified: true },
      cursor: { a: factsA.cursor, b: factsB.cursor }, receipt: { a: factsA.receiptCount, b: factsB.receiptCount },
      logs, extraRedact: [stack.authUserId],
    });
  } catch (error) {
    const facts = a ? await captureReplayFacts(await optionsPage(a), stack, bindingA).catch((cause) => ({
      owner: 'unknown', error: cause instanceof Error ? cause.message : String(cause),
    })) : { owner: 'unknown' };
    await saveReplayFixture(testInfo, id, error, facts);
    throw error;
  } finally {
    await Promise.all([a, b].map(async (context) => { if (context) await context.close().catch(() => undefined); }));
    await stack.close();
    await rm(dirs.a, { recursive: true, force: true });
    await rm(dirs.b, { recursive: true, force: true });
  }
});

async function openManager(page: Page): Promise<void> {
  await page.locator('#nav-bookmarks').click();
  if (!await page.evaluate(() => chrome.permissions.contains({ permissions: ['bookmarks'] }))) {
    await grantOptionalBookmarks(page, 'Allow bookmark access', 'Known bookmark manager');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#nav-bookmarks').click();
  }
  await expect(page.locator('#manager-body')).toBeVisible();
}

async function ready(context: BrowserContext, binding: ProfileBinding): Promise<Page> {
  const page = await optionsPage(context);
  await login(page, binding);
  await grantBookmarks(page);
  return page;
}

async function twinDirs(): Promise<{ a: string; b: string }> {
  return {
    a: await mkdtemp(resolve(tmpdir(), 'known-p2-02-batch-a-')),
    b: await mkdtemp(resolve(tmpdir(), 'known-p2-02-batch-b-')),
  };
}

