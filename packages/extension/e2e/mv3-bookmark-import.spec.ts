import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startRealStack } from './real-stack.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { installFixtureReplicaBinding, openExtensionOptions, signInExtension, showOptionsPane } from './extension-auth.js';
import { KNS08_BINDINGS, confirmFirstRun, waitFirstRunProductQuiet } from './kns-08-harness.js';

const EXTENSION_ID = 'pplpnpegpnghcddhmpgkbfkdfadjiaen';
const extensionPath = resolve(import.meta.dirname, '../dist/production');

test('production MV3 commits a real Netscape import durably and refresh does not duplicate terminal effects', async () => {
  test.setTimeout(180_000); const stack = await startRealStack();
  const profile = await mkdtemp(resolve(tmpdir(), 'known-p3-35-import-'));
  const context = await chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium', ignoreHTTPSErrors: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
      `--host-resolver-rules=${stack.browserHostResolverRules}`,
      '--no-proxy-server', '--ignore-certificate-errors'] });
  try {
    const page = await extensionPage(context); await login(page, KNS08_BINDINGS[0]);
    await showOptionsPane(page, 'folders');
    await grantOptionalBookmarks(page, 'Allow bookmark access', 'Known P3-35 import');
    await initializeImportSync(page, stack);
    await showOptionsPane(page, 'import');
    await page.locator('#import-native').click();
    await expect(page.locator('#import-preview')).toBeVisible();
    await expect(page.locator('#import-count')).not.toHaveText('0 nodes');
    const afterNativePreview = await evidence<any>(page, 'exportOutboundPushEvidence');
    expect(afterNativePreview.importPlans).toEqual([]);
    expect(afterNativePreview.queue).toEqual([]);
    await page.reload();
    await showOptionsPane(page, 'account');
    await expect(page.locator('body')).toHaveAttribute('data-state', 'connected');
    const fixture = resolve(import.meta.dirname, '../tests/fixtures/chrome-bookmarks-export.html');
    await showOptionsPane(page, 'import');
    await page.locator('#import-file').setInputFiles({ name: 'bookmarks.html', mimeType: 'text/html',
      buffer: await readFile(fixture) });
    await expect(page.locator('.import-map-label').filter({ hasText: 'Bookmarks bar' })).toBeVisible();
    const mappings = page.locator('#import-mappings select');
    for (let index = 0; index < await mappings.count(); index += 1) {
      const label = await page.locator('.import-map-label').nth(index).textContent();
      await mappings.nth(index).selectOption(label?.includes('Other bookmarks') ? 'skip' : { index: 1 });
    }
    await page.getByRole('button', { name: 'Import bookmarks' }).click();
    await expect(page.locator('#import-progress')).toBeVisible();
    await expect.poll(async () => { await evidence(page, 'wakeDurableEngineEvidence');
      const value = await evidence<any>(page, 'bookmarkImportStatus'); const durable = await evidence<any>(page, 'exportOutboundPushEvidence');
      const observed = await stack.observations(KNS08_BINDINGS[0].replicaId) as any;
      const done = value.progress.terminal + value.progress.skipped === value.progress.total;
      return done && value.state === 'complete' ? 'complete' : JSON.stringify({ state: value.state, progress: value.progress,
        queue: durable.queue.map((item: any) => ({ sequence: item.sequence, status: item.status, retryAttempt: item.retry.attempt,
          hasAttempt: Boolean(item.attempt), recovery: item.recovery })), server: { canonicalNodes: observed.canonicalNodes.length,
          sequenceReceipts: observed.sequenceReceipts.length, pushErrors: observed.pushErrors,
          lastPushResponses: observed.pushResponses.slice(-3) } }); },
    { timeout: 60_000 }).toBe('complete');
    const before = await evidence<any>(page, 'exportOutboundPushEvidence');
    const serverBefore = await stack.observations(KNS08_BINDINGS[0].replicaId) as any;
    expect(before.importPlans).toHaveLength(1); expect(before.importNodes.length).toBeGreaterThan(0);
    expect(before.queue.every((item: any) => Number.isSafeInteger(item.sequence) && item.opId)).toBe(true);
    const skipped = before.importNodes.filter((node: any) => node.choice === 'skip');
    const imported = before.importNodes.filter((node: any) => node.choice === 'import');
    expect(skipped.length).toBeGreaterThan(0);
    expect(imported.length).toBeGreaterThan(0);
    expect(before.queue.some((item: any) => skipped.some((node: any) => node.opId === item.opId))).toBe(false);
    expect(imported.every((node: any) => before.queue.some((item: any) => item.opId === node.opId
      && item.status === 'terminal'))).toBe(true);
    await expect.poll(async () => {
      await evidence(page, 'wakeDurableEngineEvidence');
      const titles = await page.evaluate(async () => {
        const out: string[] = [];
        const walk = (nodes: Array<{ title?: string; children?: unknown[] }> | undefined) => {
          for (const node of nodes ?? []) { out.push(node.title ?? ''); walk(node.children as typeof nodes); }
        };
        walk((await chrome.bookmarks.getTree())[0]?.children);
        return out;
      });
      const exported = await evidence<any>(page, 'exportOutboundPushEvidence');
      const importedNodes = exported.importNodes.filter((node: any) => node.choice === 'import');
      const mapped = importedNodes.every((node: any) => typeof node.authoritativeTarget?.colpId === 'string'
        && exported.mappings.some((mapping: any) => mapping.colpId === node.authoritativeTarget.colpId));
      const hasImported = titles.includes('Example & reference') && titles.includes('HTML standard');
      const skippedWritten = titles.includes('Local notes');
      return hasImported && !skippedWritten && mapped ? 'tree-ok'
        : JSON.stringify({ titles, mapped, hasImported, skippedWritten });
    }, { timeout: 60_000 }).toBe('tree-ok');
    await terminateExtensionWorker(context, page); await page.reload();
    await expect.poll(async () => (await evidence<any>(page, 'bookmarkImportStatus')).state).toBe('complete');
    await evidence(page, 'wakeDurableEngineEvidence');
    const after = await evidence<any>(page, 'exportOutboundPushEvidence');
    const serverAfter = await stack.observations(KNS08_BINDINGS[0].replicaId) as any;
    expect(new Set(after.queue.map((item: any) => item.opId)).size).toBe(after.queue.length);
    expect(serverAfter.canonicalNodes.length).toBe(serverBefore.canonicalNodes.length);
    expect(serverAfter.sequenceReceipts.length).toBe(serverBefore.sequenceReceipts.length);
  } finally { await context.close(); await stack.close(); await rm(profile, { recursive: true, force: true }); }
});

test('pauses mid-import, survives worker restart and lost push, then resumes the same plan', async () => {
  test.setTimeout(180_000); const stack = await startRealStack();
  const profile = await mkdtemp(resolve(tmpdir(), 'known-p1-06-import-resume-'));
  const context = await chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium', ignoreHTTPSErrors: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
      `--host-resolver-rules=${stack.browserHostResolverRules}`,
      '--no-proxy-server', '--ignore-certificate-errors'] });
  try {
    const page = await extensionPage(context); await login(page, KNS08_BINDINGS[0]);
    await showOptionsPane(page, 'folders');
    await grantOptionalBookmarks(page, 'Allow bookmark access', 'Known P1-06 import');
    await initializeImportSync(page, stack);
    await stack.commitAfterDisconnect();
    await commitNetscapeFixture(page);
    await expect(page.locator('#import-progress')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
    await expect.poll(async () => ((await stack.observations(KNS08_BINDINGS[0].replicaId)) as any).pushRequests.length, { timeout: 40_000 })
      .toBeGreaterThan(0);
    const lost = await stack.observations(KNS08_BINDINGS[0].replicaId) as any;
    const lostPush = lost.pushRequests[0] as { fingerprint: string; body: string };
    const lostOpId = pushOpId(lostPush.body);
    expect(typeof lostOpId).toBe('string');
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect.poll(async () => {
      await evidence(page, 'wakeDurableEngineEvidence');
      return (await evidence<any>(page, 'bookmarkImportStatus')).state;
    }, { timeout: 30_000 }).toBe('paused');
    const paused = await evidence<any>(page, 'exportOutboundPushEvidence');
    expect(paused.importPlans).toHaveLength(1);
    expect(paused.importPlans[0].state).toBe('paused');
    const planId = paused.importPlans[0].planId as string;
    const opIds = paused.importNodes.map((node: any) => node.opId);
    expect(opIds).toContain(lostOpId);
    expect(new Set(opIds).size).toBe(opIds.length);
    await evidence(page, 'wakeDurableEngineEvidence');
    const stillPaused = await evidence<any>(page, 'exportOutboundPushEvidence');
    expect(stillPaused.importPlans[0].planId).toBe(planId);
    expect(stillPaused.importPlans[0].state).toBe('paused');
    expect(stillPaused.queue.filter((item: any) => item.status === 'terminal').length)
      .toBe(paused.queue.filter((item: any) => item.status === 'terminal').length);
    await terminateExtensionWorker(context, page); await page.reload();
    await expect(page.locator('body')).toHaveAttribute('data-state', 'connected', { timeout: 20_000 });
    await showOptionsPane(page, 'import');
    await expect.poll(async () => (await evidence<any>(page, 'bookmarkImportStatus')).state, { timeout: 20_000 })
      .toBe('paused');
    const afterRestart = await evidence<any>(page, 'exportOutboundPushEvidence');
    expect(afterRestart.importPlans[0].planId).toBe(planId);
    expect(afterRestart.importNodes.map((node: any) => node.opId)).toEqual(opIds);
    await stack.restorePushResponses();
    // The progress card reads the stored plan when the page opens and repolls while it is running; Resume appears on its own.
    await expect(page.getByRole('button', { name: 'Resume import' })).toBeVisible();
    await page.getByRole('button', { name: 'Resume import' }).click();
    await expect.poll(async () => { await evidence(page, 'wakeDurableEngineEvidence');
      const value = await evidence<any>(page, 'bookmarkImportStatus');
      return value.progress.terminal + value.progress.skipped === value.progress.total && value.state === 'complete'
        ? 'complete' : JSON.stringify({ state: value.state, progress: value.progress, planId: value.planId });
    }, { timeout: 60_000 }).toBe('complete');
    const finished = await evidence<any>(page, 'exportOutboundPushEvidence');
    const server = await stack.observations(KNS08_BINDINGS[0].replicaId) as any;
    expect(finished.importPlans[0].planId).toBe(planId);
    expect(finished.importNodes.map((node: any) => node.opId)).toEqual(opIds);
    expect(new Set(finished.queue.map((item: any) => item.opId)).size).toBe(finished.queue.length);
    const imported = finished.importNodes.filter((node: any) => node.choice === 'import');
    expect(imported.every((node: any) => finished.queue.some((item: any) => item.opId === node.opId
      && item.status === 'terminal'))).toBe(true);
    expect(imported.every((node: any) => typeof node.authoritativeTarget?.colpId === 'string'
      && finished.mappings.some((mapping: any) => mapping.colpId === node.authoritativeTarget.colpId))).toBe(true);
    const replayed = (server.pushRequests as Array<{ fingerprint: string; body: string }>)
      .filter((request) => pushOpId(request.body) === lostOpId);
    expect(replayed.length).toBeGreaterThanOrEqual(2);
    expect(new Set(replayed.map((request) => request.fingerprint)).size).toBe(1);
    expect(replayed.every((request) => request.body === lostPush.body)).toBe(true);
    const receiptOpIds = (server.sequenceReceipts as Array<{ op_id: string }>).map((row) => row.op_id);
    expect(receiptOpIds.filter((opId) => opId === lostOpId)).toHaveLength(1);
    expect(new Set(receiptOpIds).size).toBe(receiptOpIds.length);
    await expect.poll(async () => {
      const titles = await chromeTitles(page);
      const hasImported = titles.includes('Example & reference') && titles.includes('HTML standard');
      return hasImported && !titles.includes('Local notes') ? 'tree-ok' : JSON.stringify(titles);
    }, { timeout: 60_000 }).toBe('tree-ok');
    const remoteTitles = (server.canonicalNodes as Array<{ title?: string; deleted_at?: unknown; is_root?: boolean }>)
      .filter((node) => node.deleted_at == null && node.is_root !== true).map((node) => String(node.title ?? ''));
    expect(remoteTitles).toContain('Example & reference');
    expect(remoteTitles).toContain('HTML standard');
    expect(remoteTitles).not.toContain('Local notes');
  } finally { await context.close(); await stack.close(); await rm(profile, { recursive: true, force: true }); }
});

test('options import remains keyboard-operable and coherent at 320px', async ({}, testInfo) => {
  const profile = await mkdtemp(resolve(tmpdir(), 'known-p3-35-narrow-'));
  const context = await chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium',
    viewport: { width: 900, height: 720 }, deviceScaleFactor: 2,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
  try { const page = await extensionPage(context); const email = page.locator('#login-email');
    await expect(email).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('options-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 320, height: 720 }); await page.bringToFront();
    await email.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
    await expect(email).toBeFocused();
    expect(await email.evaluate((element) => { const style = getComputedStyle(element);
      return style.boxShadow !== 'none' || style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0; })).toBe(true);
    const layout = await page.evaluate(() => ({ innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth, overflow: Array.from(document.querySelectorAll<HTMLElement>('body *'))
        .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 0.5)
        .map((element) => ({ id: element.id, className: element.className, right: element.getBoundingClientRect().right })) }));
    expect(layout.innerWidth).toBe(320);
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.innerWidth);
    expect(layout.overflow).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('options-narrow-keyboard.png'), fullPage: true });
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});

async function extensionPage(context: BrowserContext) {
  return (await openExtensionOptions(context)).page;
}
async function initializeImportSync(page: Page, stack: Awaited<ReturnType<typeof startRealStack>>) {
  const barTitle = await page.evaluate(async () => (await chrome.bookmarks.getTree())[0]!.children![0]!.title);
  await confirmFirstRun(page, [barTitle]);
  await waitFirstRunProductQuiet(page, stack, KNS08_BINDINGS[0]);
}
async function login(page: Page, binding: import('./real-stack.js').FixtureReplicaBinding) { await installFixtureReplicaBinding(page, binding); await signInExtension(page); }
async function evidence<T = unknown>(page: Page, method: string, ...args: unknown[]): Promise<T> { const result = await page.evaluate(
  ({ method, args }) => chrome.runtime.sendMessage({ kind: 'known.sync-state.evidence', method, args }), { method, args }) as any;
  if (!result.ok) throw new Error(result.error); return result.value as T; }
async function terminateExtensionWorker(context: BrowserContext, page: Page) { const cdp = await context.newCDPSession(page);
  await cdp.send('ServiceWorker.enable'); const targets = await cdp.send('Target.getTargets');
  const target = targets.targetInfos.find((item) => item.type === 'service_worker' && item.url.includes(EXTENSION_ID));
  if (!target) throw new Error('extension_service_worker_missing');
  await cdp.send('Target.closeTarget', { targetId: target.targetId }); await cdp.detach(); }
async function commitNetscapeFixture(page: Page) {
  const fixture = resolve(import.meta.dirname, '../tests/fixtures/chrome-bookmarks-export.html');
  await showOptionsPane(page, 'import');
  await page.locator('#import-file').setInputFiles({ name: 'bookmarks.html', mimeType: 'text/html',
    buffer: await readFile(fixture) });
  await expect(page.locator('.import-map-label').filter({ hasText: 'Bookmarks bar' })).toBeVisible();
  const mappings = page.locator('#import-mappings select');
  for (let index = 0; index < await mappings.count(); index += 1) {
    const label = await page.locator('.import-map-label').nth(index).textContent();
    await mappings.nth(index).selectOption(label?.includes('Other bookmarks') ? 'skip' : { index: 1 });
  }
  await page.getByRole('button', { name: 'Import bookmarks' }).click();
}
function pushOpId(body: string): string {
  const parsed = JSON.parse(body) as { operations?: Array<{ opId?: unknown }> };
  const opId = parsed.operations?.[0]?.opId;
  if (typeof opId !== 'string') throw new Error('push_opid_missing');
  return opId;
}
async function chromeTitles(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const out: string[] = [];
    const walk = (nodes: Array<{ title?: string; children?: unknown[] }> | undefined) => {
      for (const node of nodes ?? []) { out.push(node.title ?? ''); walk(node.children as typeof nodes); }
    };
    walk((await chrome.bookmarks.getTree())[0]?.children);
    return out;
  });
}
