/**
 * KNS-08 trash restore dual-Profile matrix.
 * Owner: KNS-08 (QA). Fixture: e2e/real-stack.ts restoreDeletedNode (production restore_node)
 * plus profileA/profileB persistent Chromium. Do not copy Profile management.
 * Run: npm run evidence:trash-restore
 * Evidence: test-results/known-extension-first-run-sync/<commit>/trash-restore/
 *
 * kns08:KNS-08-AC-07-delete-restore kns08:KNS-08-AC-07-parent-delete kns08:FRR-05-split-mount-restore
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  KNS08_BINDINGS, PUBLIC_URL, assertQueueTerminal, bookmarkPlacement, captureReplayFacts,
  collectLogs, confirmFirstRun, grantBookmarks, hasBrowserTrashFolder, launchPersistent, login,
  optionsPage, saveReplayFixture, specialRoots, startRealStack, scopeFacts, treeProjection, liveCanonical,
  waitFirstRunProductQuiet, waitQueueQuiet, waitTitles, waitTitlesGone, wakeEngine, writeScenarioEvidence,
  type ProfileBinding,
} from './kns-08-harness.js';
import { assertUniqueMappings, chromeTree, exportedScope, mappingsByNative } from './first-run-remediation-oracle.js';

const bindingA = KNS08_BINDINGS[0];
const bindingB = KNS08_BINDINGS[1];

test.describe.configure({ timeout: 600_000 });

test('KNS-08-AC-07 delete restores in place and never creates a browser Trash folder', async ({}, testInfo) => {
  const id = 'KNS-08-AC-07-delete-restore';
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
    const nativeId = await pageA.evaluate(async ({ barId, url }) => {
      const created = await chrome.bookmarks.create({ parentId: barId, title: 'KNS08 restore item', url });
      return created.id;
    }, { barId: rootsA.barId, url: PUBLIC_URL });
    const start = await treeProjection(pageA);
    await confirmFirstRun(pageA, [rootsA.barTitle]);
    await waitFirstRunProductQuiet(pageA, stack, bindingA);
    await confirmFirstRun(pageB, [rootsB.barTitle]);
    await waitFirstRunProductQuiet(pageB, stack, bindingB);
    await waitTitles(pageB, ['KNS08 restore item']);

    await pageA.evaluate((id) => chrome.bookmarks.remove(id), nativeId);
    await waitQueueQuiet(pageA, stack, bindingA, 90_000);
    await wakeEngine(pageB);
    await waitTitlesGone(pageB, ['KNS08 restore item']);
    expect(hasBrowserTrashFolder((await treeProjection(pageA)).titles)).toBe(false);
    expect(hasBrowserTrashFolder((await treeProjection(pageB)).titles)).toBe(false);

    const deleted = await stack.listDeletedCanonicalNodes();
    const target = deleted.find((row) => row.kind === 'bookmark') ?? deleted[0];
    expect(target).toBeTruthy();
    expect(target!.titlePresent).toBe(true);
    const restored = await stack.restoreDeletedNode(target!.id);
    expect(restored.revision.length).toBeGreaterThan(0);
    await wakeEngine(pageA); await wakeEngine(pageB);
    await waitTitles(pageA, ['KNS08 restore item']);
    await waitTitles(pageB, ['KNS08 restore item']);
    await assertRestoredIdentity(pageA, pageB, stack, target!.id, 'KNS08 restore item',
      [rootsA.barTitle, rootsB.barTitle]);
    expect(hasBrowserTrashFolder((await treeProjection(pageA)).titles)).toBe(false);
    expect(hasBrowserTrashFolder((await treeProjection(pageB)).titles)).toBe(false);
    const factsA = await scopeFacts(pageA, stack, bindingA);
    const factsB = await scopeFacts(pageB, stack, bindingB);
    assertQueueTerminal(factsA);
    assertQueueTerminal(factsB);
    expect((await stack.listDeletedCanonicalNodes()).some((row) => row.id === target!.id)).toBe(false);
    await writeScenarioEvidence({
      testInfo, id, startDigest: start.digest, ops: ['delete_node', 'restore_node', 'pull'],
      endTree: { a: (await treeProjection(pageA)).digest, b: (await treeProjection(pageB)).digest },
      mapping: { a: factsA.mappingCount, b: factsB.mappingCount, restoredIdentityVerified: true },
      cursor: { a: factsA.cursor, b: factsB.cursor }, receipt: { a: factsA.receiptCount, b: factsB.receiptCount }, logs,
      extraRedact: [stack.authUserId],
    });
  } catch (error) {
    const facts = a ? await captureReplayFacts(await optionsPage(a), stack, bindingA).catch((cause) => ({
      owner: 'unknown', error: cause instanceof Error ? cause.message : String(cause),
    })) : { owner: 'unknown' };
    await saveReplayFixture(testInfo, id, error, facts);
    throw error;
  } finally { await closeAll(a, b); await stack.close(); await rmDirs(dirs); }
});

test('KNS-08-AC-07 parent delete restores the child into Recovered, not a browser Trash folder', async ({}, testInfo) => {
  const id = 'KNS-08-AC-07-parent-delete';
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
    const folderId = await pageA.evaluate(async ({ barId, url }) => {
      const folder = await chrome.bookmarks.create({ parentId: barId, title: 'KNS08 parent folder' });
      await chrome.bookmarks.create({ parentId: folder.id, title: 'KNS08 orphan child', url: `${url}/orphan` });
      return folder.id;
    }, { barId: rootsA.barId, url: PUBLIC_URL });
    const start = await treeProjection(pageA);
    await confirmFirstRun(pageA, [rootsA.barTitle]);
    await waitFirstRunProductQuiet(pageA, stack, bindingA);
    await confirmFirstRun(pageB, [rootsB.barTitle]);
    await waitFirstRunProductQuiet(pageB, stack, bindingB);
    await waitTitles(pageB, ['KNS08 orphan child']);

    await pageA.evaluate((id) => chrome.bookmarks.removeTree(id), folderId);
    await waitQueueQuiet(pageA, stack, bindingA, 90_000);
    await wakeEngine(pageB);
    await waitTitlesGone(pageB, ['KNS08 parent folder']);
    const deleted = await stack.listDeletedCanonicalNodes();
    const child = deleted.find((row) => row.kind === 'bookmark') ?? deleted[0];
    expect(child).toBeTruthy();
    await stack.restoreDeletedNode(child!.id);
    await wakeEngine(pageA); await wakeEngine(pageB);
    await waitTitles(pageA, ['Recovered', 'KNS08 orphan child']);
    expect((await bookmarkPlacement(pageA, 'KNS08 orphan child')).parentTitle).toBe('Recovered');
    await waitTitles(pageB, ['KNS08 orphan child']);
    expect((await bookmarkPlacement(pageB, 'KNS08 orphan child')).parentTitle).toBe('Recovered');
    await waitQueueQuiet(pageA, stack, bindingA);
    await waitQueueQuiet(pageB, stack, bindingB);
    await assertRestoredIdentity(pageA, pageB, stack, child!.id, 'KNS08 orphan child',
      ['Recovered', 'Recovered']);
    expect(hasBrowserTrashFolder((await treeProjection(pageA)).titles)).toBe(false);
    expect(hasBrowserTrashFolder((await treeProjection(pageB)).titles)).toBe(false);
    const factsA = await scopeFacts(pageA, stack, bindingA);
    const factsB = await scopeFacts(pageB, stack, bindingB);
    assertQueueTerminal(factsA);
    assertQueueTerminal(factsB);
    await writeScenarioEvidence({
      testInfo, id, startDigest: start.digest, ops: ['delete_subtree', 'restore_node'],
      endTree: { a: (await treeProjection(pageA)).digest, b: (await treeProjection(pageB)).digest,
        recoveredPlacementVerified: { a: true, b: true } },
      mapping: { a: factsA.mappingCount, b: factsB.mappingCount, restoredIdentityVerified: true },
      cursor: { a: factsA.cursor, b: factsB.cursor }, receipt: { a: factsA.receiptCount, b: factsB.receiptCount },
      logs, extraRedact: [stack.authUserId],
    });
  } catch (error) {
    const capture = async (context: BrowserContext | undefined, binding: ProfileBinding) => context
      ? captureReplayFacts(await optionsPage(context), stack, binding).catch((cause) => ({
        error: cause instanceof Error ? cause.message : String(cause),
      })) : { owner: 'unknown' };
    const facts = { a: await capture(a, bindingA), b: await capture(b, bindingB) };
    await saveReplayFixture(testInfo, id, error, facts);
    throw error;
  } finally { await closeAll(a, b); await stack.close(); await rmDirs(dirs); }
});

test('FRR-05 split-mount restore keeps Recovered on the owning mount and skips the unmounted bar', async ({}, testInfo) => {
  const id = 'FRR-05-split-mount-restore';
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
    await confirmFirstRun(pageA, [rootsA.barTitle]);
    await waitFirstRunProductQuiet(pageA, stack, bindingA);
    await confirmFirstRun(pageB, [rootsB.otherTitle]);
    await waitFirstRunProductQuiet(pageB, stack, bindingB);
    const start = await treeProjection(pageB);
    const folderId = await pageB.evaluate(async ({ otherId, url }) => {
      const folder = await chrome.bookmarks.create({ parentId: otherId, title: 'KNS08 other parent' });
      await chrome.bookmarks.create({ parentId: folder.id, title: 'KNS08 other orphan', url: `${url}/other-orphan` });
      return folder.id;
    }, { otherId: rootsB.otherId, url: PUBLIC_URL });
    await waitQueueQuiet(pageB, stack, bindingB, 90_000);
    await wakeEngine(pageA);
    await waitTitles(pageB, ['KNS08 other orphan']);
    await waitTitlesGone(pageA, ['KNS08 other orphan']);

    await pageB.evaluate((id) => chrome.bookmarks.removeTree(id), folderId);
    await waitQueueQuiet(pageB, stack, bindingB, 90_000);
    await wakeEngine(pageA);
    await waitTitlesGone(pageB, ['KNS08 other parent']);
    const deleted = await stack.listDeletedCanonicalNodes();
    const child = deleted.find((row) => row.kind === 'bookmark') ?? deleted[0];
    expect(child).toBeTruthy();
    await stack.restoreDeletedNode(child!.id);
    await wakeEngine(pageA); await wakeEngine(pageB);
    await waitTitles(pageB, ['Recovered', 'KNS08 other orphan']);
    expect((await bookmarkPlacement(pageB, 'KNS08 other orphan')).parentTitle).toBe('Recovered');
    const treeB = await chromeTree(pageB);
    const recoveredB = treeB.filter((node) => node.title === 'Recovered');
    expect(recoveredB).toHaveLength(1);
    expect(treeB.find((node) => node.id === recoveredB[0]!.parentId)?.title).toBe(rootsB.otherTitle);
    await expect(async () => {
      const treeA = await chromeTree(pageA);
      expect(treeA.some((node) => node.title === 'Recovered')).toBe(false);
      expect(treeA.some((node) => node.title === 'KNS08 other orphan')).toBe(false);
      const exported = await exportedScope(pageA);
      assertUniqueMappings(exported);
      const mapping = (exported.mappings ?? []).find((row: { colpId?: string }) => row.colpId === child!.id);
      expect(mapping?.nativeId).toBe(`unmounted:${child!.id}`);
    }).toPass({ timeout: 90_000 });
    expect(hasBrowserTrashFolder((await treeProjection(pageA)).titles)).toBe(false);
    expect(hasBrowserTrashFolder((await treeProjection(pageB)).titles)).toBe(false);
    const factsA = await scopeFacts(pageA, stack, bindingA);
    const factsB = await scopeFacts(pageB, stack, bindingB);
    assertQueueTerminal(factsA);
    assertQueueTerminal(factsB);
    await writeScenarioEvidence({
      testInfo, id, startDigest: start.digest, ops: ['delete_subtree', 'restore_node'],
      endTree: { a: (await treeProjection(pageA)).digest, b: (await treeProjection(pageB)).digest,
        recoveredPlacementVerified: { a: false, b: true } },
      mapping: { a: factsA.mappingCount, b: factsB.mappingCount, unmountedOnA: true },
      cursor: { a: factsA.cursor, b: factsB.cursor }, receipt: { a: factsA.receiptCount, b: factsB.receiptCount },
      logs, extraRedact: [stack.authUserId],
    });
  } catch (error) {
    const facts = a ? await captureReplayFacts(await optionsPage(a), stack, bindingA).catch((cause) => ({
      owner: 'unknown', error: cause instanceof Error ? cause.message : String(cause),
    })) : { owner: 'unknown' };
    await saveReplayFixture(testInfo, id, error, facts);
    throw error;
  } finally { await closeAll(a, b); await stack.close(); await rmDirs(dirs); }
});

test('P1-03 Product trash restores a deleted folder tree on original Node ids', async ({}, testInfo) => {
  const id = 'P1-03-product-trash-subtree';
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
      const folder = await chrome.bookmarks.create({ parentId: barId, title: 'KNS08 product tree' });
      await chrome.bookmarks.create({ parentId: folder.id, title: 'KNS08 product leaf', url: `${url}/leaf` });
      return folder.id;
    }, { barId: rootsA.barId, url: PUBLIC_URL });
    const start = await treeProjection(pageA);
    await confirmFirstRun(pageA, [rootsA.barTitle]);
    await waitFirstRunProductQuiet(pageA, stack, bindingA);
    await confirmFirstRun(pageB, [rootsB.barTitle]);
    await waitFirstRunProductQuiet(pageB, stack, bindingB);
    await waitTitles(pageB, ['KNS08 product leaf']);
    const folderNative = await pageA.evaluate(async () => {
      const tree = await chrome.bookmarks.getTree();
      const visit = (nodes: chrome.bookmarks.BookmarkTreeNode[]): string | null => {
        for (const node of nodes) {
          if (node.title === 'KNS08 product tree' && node.id) return node.id;
          if (node.children) {
            const found = visit(node.children);
            if (found) return found;
          }
        }
        return null;
      };
      return visit(tree);
    });
    expect(folderNative).toBeTruthy();
    await pageA.evaluate((id) => chrome.bookmarks.removeTree(id), folderNative!);
    await waitQueueQuiet(pageA, stack, bindingA, 90_000);
    await wakeEngine(pageB);
    await waitTitlesGone(pageB, ['KNS08 product tree']);
    const trash = await stack.listProductTrash();
    const folder = trash.find((row) => row.kind === 'folder' && row.title === 'KNS08 product tree');
    expect(folder).toBeTruthy();
    const restored = await stack.restoreProductTrashSubtree(folder!.deletionId, folder!.revision);
    expect(restored.results.some((row) => row.outcome === 'applied' && row.nodeId === folder!.nodeId)).toBe(true);
    const leaf = trash.find((row) => row.kind === 'bookmark' && row.title === 'KNS08 product leaf');
    expect(leaf).toBeTruthy();
    expect(restored.results.some((row) => row.outcome === 'applied' && row.nodeId === leaf!.nodeId)).toBe(true);
    await wakeEngine(pageA); await wakeEngine(pageB);
    await waitTitles(pageA, ['KNS08 product tree', 'KNS08 product leaf']);
    await waitTitles(pageB, ['KNS08 product tree', 'KNS08 product leaf']);
    expect((await bookmarkPlacement(pageA, 'KNS08 product leaf')).parentTitle).toBe('KNS08 product tree');
    expect((await bookmarkPlacement(pageB, 'KNS08 product leaf')).parentTitle).toBe('KNS08 product tree');
    await waitQueueQuiet(pageA, stack, bindingA);
    await waitQueueQuiet(pageB, stack, bindingB);
    await assertRestoredIdentity(pageA, pageB, stack, leaf!.nodeId, 'KNS08 product leaf',
      ['KNS08 product tree', 'KNS08 product tree']);
    const remaining = await stack.listDeletedCanonicalNodes();
    expect(remaining.some((row) => row.id === folder!.nodeId || row.id === leaf!.nodeId)).toBe(false);
    const factsA = await scopeFacts(pageA, stack, bindingA);
    const factsB = await scopeFacts(pageB, stack, bindingB);
    assertQueueTerminal(factsA);
    assertQueueTerminal(factsB);
    await writeScenarioEvidence({
      testInfo, id, startDigest: start.digest, ops: ['delete_subtree', 'restore_node'],
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
  } finally { await closeAll(a, b); await stack.close(); await rmDirs(dirs); }
});

/** Read-only convergence: both native parents must map to the canonical restored parent. */
async function assertRestoredIdentity(pageA: Page, pageB: Page,
  stack: Awaited<ReturnType<typeof startRealStack>>, nodeId: string, title: string,
  parentTitles: readonly [string, string]): Promise<void> {
  await expect(async () => {
    const canonical = (await liveCanonical(stack)).filter((node) => node.id === nodeId);
    expect(canonical).toHaveLength(1);
    expect((await stack.listDeletedCanonicalNodes()).some((node) => node.id === nodeId)).toBe(false);
    for (const [index, page] of [pageA, pageB].entries()) {
      const tree = await chromeTree(page);
      const matches = tree.filter((node) => node.kind === 'bookmark' && node.title === title);
      expect(matches).toHaveLength(1);
      const native = matches[0]!;
      expect(tree.find((node) => node.id === native.parentId)?.title).toBe(parentTitles[index]);
      const exported = await exportedScope(page);
      assertUniqueMappings(exported);
      const mappings = mappingsByNative(exported);
      expect(mappings.get(native.id)?.colpId).toBe(nodeId);
      expect(mappings.get(native.parentId)?.colpId).toBe(canonical[0]!.parent_id);
      expect(mappings.get(native.id)?.parentColpId).toBe(canonical[0]!.parent_id);
      const facts = await scopeFacts(page, stack, index === 0 ? bindingA : bindingB);
      assertQueueTerminal(facts);
      expect(facts.recoveryFrozen).toBe(false);
      expect(facts.rejectedPending).toBe(false);
    }
  }).toPass({ timeout: 90_000 });
}

async function ready(context: BrowserContext, binding: ProfileBinding): Promise<Page> {
  const page = await optionsPage(context);
  await login(page, binding);
  await grantBookmarks(page);
  return page;
}

async function twinDirs(): Promise<{ a: string; b: string }> {
  return {
    a: await mkdtemp(resolve(tmpdir(), 'known-kns08-trash-a-')),
    b: await mkdtemp(resolve(tmpdir(), 'known-kns08-trash-b-')),
  };
}

async function closeAll(...contexts: Array<BrowserContext | undefined>): Promise<void> {
  await Promise.all(contexts.map(async (context) => { if (context) await context.close().catch(() => undefined); }));
}

async function rmDirs(dirs: { a: string; b: string }): Promise<void> {
  await Promise.all([rm(dirs.a, { recursive: true, force: true }), rm(dirs.b, { recursive: true, force: true })]);
}
