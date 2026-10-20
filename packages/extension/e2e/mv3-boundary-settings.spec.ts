import { expect, test, type BrowserContext } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { KNS08_BINDINGS, evidence, grantBookmarks, launchPersistent, login, optionsPage,
  liveCanonical, previewFirstRun, specialRoots, startRealStack, terminateWorker, waitFirstRunProductQuiet, wakeEngine } from './kns-08-harness.js';
import { showOptionsPane } from './extension-auth.js';

test.describe.configure({ timeout: 180_000 });

test('direct bookmarks stay selectable after Later, all child exclusions and reopening', async () => {
  const stack = await startRealStack(); const profile = await mkdtemp(resolve(tmpdir(), 'known-root-only-ui-'));
  let context: BrowserContext | undefined;
  try {
    context = await launchPersistent(profile, stack.browserHostResolverRules);
    const page = await optionsPage(context); await login(page, KNS08_BINDINGS[0]); await grantBookmarks(page);
    const roots = await specialRoots(page);
    await page.evaluate(async parentId => {
      await chrome.bookmarks.create({ parentId, title: 'Direct bookmark to sync', url: 'https://example.test/direct' });
      const child = await chrome.bookmarks.create({ parentId, title: 'Keep this child local' });
      await chrome.bookmarks.create({ parentId: child.id, title: 'Private child bookmark', url: 'https://example.test/private-child' });
    }, roots.barId);
    await page.reload(); await showOptionsPane(page, 'folders');
    await expect(page.locator('#first-run-start')).toBeEnabled({ timeout: 15_000 });
    await page.locator('#tree-clear-selection').click();
    const bar = page.locator('.root-row[data-depth="0"] .root-select input').first();
    await bar.check();
    await page.locator('.root-row').filter({ has: page.getByText('Keep this child local', { exact: true }) })
      .locator('.root-select input').uncheck();
    await expect(page.locator('#first-run-totals')).toContainText('1 bookmark');
    await expect(page.locator('.root-select input:checked')).toHaveCount(0);
    expect(await bar.evaluate(element => (element as HTMLInputElement).indeterminate)).toBe(true);
    await expect(page.locator('#first-run-start')).toBeEnabled();
    await page.locator('#first-run-later').click();
    await expect(page.locator('#first-run-error')).toHaveText('Sync is off');
    await page.reload(); await showOptionsPane(page, 'folders');
    await expect(page.locator('#first-run-start')).toBeEnabled({ timeout: 15_000 });
    await page.locator('#first-run-start').click();
    await waitFirstRunProductQuiet(page, stack, KNS08_BINDINGS[0]);
    const live = await liveCanonical(stack);
    expect(live.filter(node => node.url === 'https://example.test/direct')).toHaveLength(1);
    expect(live.filter(node => node.url === 'https://example.test/private-child')).toHaveLength(0);
    await expect(page.locator('#hub-status')).toHaveText('Synced', { timeout: 35_000 });
    await page.reload(); await showOptionsPane(page, 'folders');
    await expect(page.locator('#hub-status')).toHaveText('Synced', { timeout: 15_000 });
  } finally { await context?.close(); await stack.close(); await rm(profile, { recursive: true, force: true }); }
});

test('an older options-page confirmation and a replay after worker restart cannot undo Clear', async () => {
  const stack = await startRealStack(); const profile = await mkdtemp(resolve(tmpdir(), 'known-boundary-ui-'));
  let context: BrowserContext | undefined;
  type Export = { scope: { selectedRoots: string[]; boundaryVersion: string };
    mountBindings: { mountId: string; status: string; pauseBaseline?: unknown }[];
    boundaryCommands: { kind: string; commandId: string; previewId: string; result: unknown }[] };
  try {
    context = await launchPersistent(profile, stack.browserHostResolverRules);
    const pageA = await optionsPage(context); await login(pageA, KNS08_BINDINGS[0]); await grantBookmarks(pageA);
    const roots = await specialRoots(pageA);
    await pageA.evaluate(parentId => chrome.bookmarks.create({ parentId,
      title: 'Boundary admission bookmark', url: 'https://example.test/boundary-admission' }), roots.barId);
    const firstView = await pageA.evaluate(async () => chrome.runtime.sendMessage({ kind: 'known.roots.get' })) as {
      view: { viewId: string; roots: { ref: string; depth: number }[] } };
    const oldPreview = await previewFirstRun(pageA, [roots.barTitle, roots.otherTitle]);
    const pageB = await optionsPage(context); await showOptionsPane(pageB, 'folders');
    await expect(pageB.locator('#first-run-start')).toBeEnabled({ timeout: 15_000 });
    const stillUsable = await pageA.evaluate(async view => chrome.runtime.sendMessage({
      kind: 'known.firstRun.preview', viewId: view.viewId,
      selectedRefs: view.roots.filter(root => root.depth === 0).map(root => root.ref), excludedRefs: [],
    }), firstView.view);
    expect(stillUsable).toMatchObject({ ok: true });
    await pageB.locator('#first-run-start').click();
    await waitFirstRunProductQuiet(pageB, stack, KNS08_BINDINGS[0]);
    await pageB.reload(); await showOptionsPane(pageB, 'folders');
    await pageB.locator('#tree-clear-selection').click(); await pageB.locator('#save-roots').click();
    await expect(pageB.locator('#range-preview')).toBeVisible();
    await pageB.locator('#range-confirm').click();
    await expect(pageB.locator('#root-feedback')).toHaveText('Folder settings saved');
    const cleared = await evidence<Export>(pageB, 'exportOutboundPushEvidence');
    expect(cleared.scope.selectedRoots).toEqual([]);
    expect(cleared.mountBindings.every(mount => mount.status === 'detached' && mount.pauseBaseline)).toBe(true);
    const stale = await pageA.evaluate(async ({ previewId, libraryId }) => chrome.runtime.sendMessage({
      kind: 'known.firstRun.confirm', previewId, confirmationId: crypto.randomUUID(), libraryId,
    }), { previewId: oldPreview.previewId, libraryId: stack.collectionId });
    expect(stale).toMatchObject({ ok: false, error: 'preview_stale' });
    const confirmed = cleared.boundaryCommands.find(command => command.kind === 'first-run')!;
    expect(confirmed).toBeDefined();
    await terminateWorker(context, pageB);
    const replayed = await pageB.evaluate(async ({ command, libraryId }) => chrome.runtime.sendMessage({
      kind: 'known.firstRun.confirm', previewId: command.previewId, confirmationId: command.commandId, libraryId,
    }), { command: confirmed, libraryId: stack.collectionId });
    expect(replayed).toEqual(confirmed.result);
    const after = await evidence<Export>(pageB, 'exportOutboundPushEvidence');
    expect(after.scope.selectedRoots).toEqual([]);
    expect(after.scope.boundaryVersion).toBe(cleared.scope.boundaryVersion);
    expect(after.mountBindings).toEqual(cleared.mountBindings);
  } finally { await context?.close(); await stack.close(); await rm(profile, { recursive: true, force: true }); }
});

test('closing options after Start resumes one durable confirmation when reopened', async () => {
  const stack = await startRealStack(); const profile = await mkdtemp(resolve(tmpdir(), 'known-confirm-close-ui-'));
  let context: BrowserContext | undefined;
  try {
    context = await launchPersistent(profile, stack.browserHostResolverRules);
    const page = await optionsPage(context); await login(page, KNS08_BINDINGS[0]); await grantBookmarks(page);
    const roots = await specialRoots(page);
    await page.evaluate(parentId => chrome.bookmarks.create({ parentId, title: 'Close options during confirmation',
      url: 'https://example.test/confirmation-close' }), roots.barId);
    await page.reload(); await showOptionsPane(page, 'folders');
    await expect(page.locator('#first-run-start')).toBeEnabled({ timeout: 15_000 });
    stack.setSyncOffline(true);
    await page.locator('#first-run-start').click();
    await expect(page.locator('#first-run-later')).toBeDisabled();
    await expect(page.locator('#refresh-roots')).toBeDisabled();
    await expect(page.locator('.root-select input:not(:disabled)')).toHaveCount(0);
    await page.close();
    const reopened = await optionsPage(context); await showOptionsPane(reopened, 'folders');
    await expect(reopened.locator('body')).toHaveAttribute('data-first-run', 'syncing', { timeout: 30_000 });
    stack.setSyncOffline(false); await wakeEngine(reopened);
    await waitFirstRunProductQuiet(reopened, stack, KNS08_BINDINGS[0]);
    await expect(reopened.locator('#first-run-confirm')).toBeHidden({ timeout: 15_000 });
    expect((await liveCanonical(stack)).filter(node => node.url === 'https://example.test/confirmation-close')).toHaveLength(1);
  } finally { await context?.close(); await stack.close(); await rm(profile, { recursive: true, force: true }); }
});

test('Start recovers an undelivered hanging message in the open page with the same confirmation id', async () => {
  const stack = await startRealStack(); const profile = await mkdtemp(resolve(tmpdir(), 'known-confirm-retry-ui-'));
  let context: BrowserContext | undefined;
  try {
    context = await launchPersistent(profile, stack.browserHostResolverRules);
    const page = await optionsPage(context); await login(page, KNS08_BINDINGS[0]); await grantBookmarks(page);
    const roots = await specialRoots(page);
    await page.evaluate(parentId => chrome.bookmarks.create({ parentId, title: 'Retry the reviewed command',
      url: 'https://example.test/confirmation-undelivered' }), roots.barId);
    await page.reload(); await showOptionsPane(page, 'folders');
    await expect(page.locator('#first-run-start')).toBeEnabled({ timeout: 15_000 });
    await page.evaluate(() => {
      const runtime = chrome.runtime as unknown as { sendMessage(request: { kind: string; confirmationId?: string }): Promise<unknown> };
      const send = runtime.sendMessage.bind(runtime); const attempts: string[] = [];
      (window as unknown as { confirmationAttempts: string[] }).confirmationAttempts = attempts;
      runtime.sendMessage = request => {
        if (request.kind === 'known.firstRun.confirm') {
          attempts.push(request.confirmationId!);
          if (attempts.length === 1) return new Promise(() => {});
        }
        return send(request);
      };
    });
    await page.locator('#first-run-start').click();
    await expect(page.locator('#first-run-later')).toBeDisabled();
    await waitFirstRunProductQuiet(page, stack, KNS08_BINDINGS[0]);
    const attempts = await page.evaluate(() => (window as unknown as { confirmationAttempts: string[] }).confirmationAttempts);
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(new Set(attempts).size).toBe(1);
    expect((await liveCanonical(stack)).filter(node => node.url === 'https://example.test/confirmation-undelivered')).toHaveLength(1);
    await expect(page.locator('#first-run-confirm')).toBeHidden();
  } finally { await context?.close(); await stack.close(); await rm(profile, { recursive: true, force: true }); }
});
