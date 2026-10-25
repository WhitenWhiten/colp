import { test, expect, chromium, type BrowserContext, type CDPSession, type Page, type Worker } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startRealStack, type RealStack } from './real-stack.js';
import { EXTENSION_ID, EXTENSION_FIXTURE_EMAIL, EXTENSION_FIXTURE_PASSWORD, installFixtureReplicaBinding, openExtensionOptions, signInExtension, showOptionsPane } from './extension-auth.js';
import { fixtureCollectionId } from './external-backend.js';

const extensionPath = resolve(import.meta.dirname, '../dist/production');
let stack: RealStack | undefined;

test.beforeEach(async () => { stack = await startRealStack(); });
test.afterEach(async () => { await stack?.close(); stack = undefined; });

test('production MV3 completes Better Auth login, PostgreSQL Session and logout', async ({}, testInfo) => {
  const context = await launch();
  try {
    const { worker, page } = await options(context);
    expect(new URL(worker.url()).host).toBe(EXTENSION_ID);
    expect(await page.evaluate(() => chrome.permissions.contains({ permissions: ['bookmarks'] }))).toBe(false);
    await installBinding(page);
    await signInExtension(page);
    // Connection details live in Help & diagnostics, not on the Account page.
    await showOptionsPane(page, 'help');
    await expect(page.locator('#manifest-state')).toHaveText('Verified');
    await expect(page.locator('#session-state')).toContainText('Active until');
    await page.screenshot({ path: testInfo.outputPath('manifest-verified.png'), fullPage: true });
    await showOptionsPane(page, 'account');
    expect(await page.evaluate(() => chrome.permissions.contains({ permissions: ['bookmarks'] }))).toBe(false);
    const syncScope = { environment: 'production', serverId: 'https://known.example', serverOrigin: 'https://known.example',
      accountId: requireStack().authUserId, browserProfileId: requireStack().extensionBinding.browserProfileId,
      collectionId: fixtureCollectionId(), replicaId: requireStack().extensionBinding.replicaId, generation: 1 };
    const durableScopes = await readStore(page, 'sync_scopes') as Array<Record<string, unknown>>;
    expect(durableScopes).toContainEqual(expect.objectContaining({ accountId: syncScope.accountId,
      replicaId: syncScope.replicaId }));
    const connected = await requireStack().observations();
    expect(connected).toMatchObject({ sessions: 1, receipts: 1, replicaStatus: 'active' });
    await page.getByRole('button', { name: 'Sign out' }).click();
    // E11 gates sign-out behind a confirmation dialog: this document keeps its
    // local bookmarks, so the exit is deliberate.
    await expect(page.locator('#logout-dialog')).toBeVisible();
    await page.locator('#logout-confirm').click();
    await expect(page.locator('#login-panel')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible();
    await expect(page.locator('#login-form')).toBeVisible();
    const archives = await readStore(page, 'retired_archives') as Array<Record<string, unknown>>;
    expect(archives).toContainEqual(expect.objectContaining({ accountId: syncScope.accountId,
      replicaId: syncScope.replicaId, lifecycle: 'retired' }));
    expect(await requireStack().observations()).toMatchObject({ revokeCount: 1, replicaStatus: 'retired' });
    expect(await worker.evaluate(() => chrome.storage.local.get([
      'known.auth.transaction.v1', 'known.auth.credential.v1', 'known.auth.session.v1', 'known.auth.binding.v1']))).toEqual({});
  } finally { await context.close(); }
});

test('production MV3 rejects wrong password, missing gesture and offline sign-in', async () => {
  const context = await launch();
  try {
    const { page } = await options(context);
    await installBinding(page);

    await page.locator('#login-email').fill(EXTENSION_FIXTURE_EMAIL);
    await page.locator('#login-password').fill('definitely-not-the-fixture-password');
    await page.locator('#login-submit').click();
    await expect(page.locator('.toast--error:not(.is-closing) .toast-message')).toHaveText('Username, email or password is incorrect.', { timeout: 10_000 });

    requireStack().setMode('offline');
    await page.locator('#login-password').fill(EXTENSION_FIXTURE_PASSWORD);
    await page.locator('#login-submit').click();
    await expect(page.locator('.toast--error:not(.is-closing) .toast-message')).toHaveText('Check your connection and try again.', { timeout: 10_000 });

    requireStack().setMode('normal');
    await page.reload();
    await expect(page.locator('#login-email')).toBeVisible();
    await page.locator('#login-email').fill(EXTENSION_FIXTURE_EMAIL);
    await page.locator('#login-password').fill(EXTENSION_FIXTURE_PASSWORD);
    await expect(page.locator('#login-submit')).toBeEnabled();
    await page.evaluate(() => { setTimeout(() => (document.getElementById('login-submit') as HTMLButtonElement).click(), 50); });
    await expect(page.locator('.toast--error:not(.is-closing) .toast-message')).toHaveText('Use the button to start sign-in.');
    const authority = await page.evaluate(() => chrome.storage.local.get([
      'known.auth.transaction.v1', 'known.auth.credential.v1', 'known.auth.session.v1']));
    expect(authority).toEqual({});
  } finally { await context.close(); }
});

test('server revocation clears credential and Session while preserving replica identity', async () => {
  const context = await launch();
  try {
    const { page } = await options(context);
    await installBinding(page);
    await signInExtension(page);
    await requireStack().revokeCurrentCredential();
    const response = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.auth.refresh' })) as {
      readonly ok: boolean;
      readonly state: { readonly status: string; readonly errorCode?: string };
    };
    expect(response.ok).toBe(false);
    expect(response.state).toMatchObject({ status: 'error', errorCode: 'authentication_required' });
    expect(await page.evaluate(() => chrome.storage.local.get([
      'known.auth.transaction.v1', 'known.auth.credential.v1', 'known.auth.session.v1']))).toEqual({});
    expect(await page.evaluate(() => chrome.storage.local.get('known.auth.binding.v1'))).toEqual({
      'known.auth.binding.v1': { replicaId: requireStack().extensionBinding.replicaId,
        browserProfileId: requireStack().extensionBinding.browserProfileId, generation: requireStack().extensionBinding.generation },
    });
  } finally { await context.close(); }
});

test('browser restart and forced service-worker termination restore bounded authority and fail closed', async () => {
  const profile = await mkdtemp(resolve(tmpdir(), 'known-p3-27-browser-'));
  let context = await launch(profile);
  try {
    let opened = await options(context);
    await installBinding(opened.page);
    await signInExtension(opened.page);
    const beforeRestart = await requireStack().observations();
    await context.close();

    context = await launch(profile);
    opened = await options(context);
    await expect(opened.page.locator('body')).toHaveAttribute('data-state', 'connected', { timeout: 10_000 });
    // Session secrets are browser-session scoped. Restart restores the cookie
    // and mints exactly one fresh COLP Session while retaining replica identity.
    expect(beforeRestart).toMatchObject({ sessions: expect.any(Number), receipts: expect.any(Number) });
    const restored = { sessions: Number(beforeRestart.sessions) + 1, receipts: Number(beforeRestart.receipts) + 1 };
    await expect.poll(() => requireStack().observations()).toMatchObject(restored);
    expect(await opened.page.locator('body').textContent()).not.toMatch(/eyJ[A-Za-z0-9_-]+\.|refresh-/u);

    const cdp = await context.newCDPSession(opened.page);
    const initialVersionPromise = waitForWorkerStatus(cdp, 'running');
    await cdp.send('ServiceWorker.enable');
    const initialVersion = await initialVersionPromise;
    const stoppedPromise = waitForWorkerStatus(cdp, 'stopped');
    await cdp.send('ServiceWorker.stopWorker', { versionId: initialVersion.versionId });
    await stoppedPromise;
    const runningPromise = waitForWorkerStatus(cdp, 'running');
    await opened.page.reload();
    await expect(opened.page.locator('body')).toHaveAttribute('data-state', 'connected', { timeout: 10_000 });
    await runningPromise;
    expect(await requireStack().observations()).toMatchObject(restored);
    expect(await opened.page.evaluate(() => chrome.storage.local.get('known.auth.transaction.v1'))).toEqual({});
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('options UI is accessible without overflow at narrow HiDPI and desktop dimensions', async ({}, testInfo) => {
  const context = await launch();
  try {
    const { page } = await options(context);
    await page.setViewportSize({ width: 360, height: 700 });
    expect(await noOverflow(page)).toBe(true);
    await expect(page.locator('#login-email')).toBeVisible();
    await page.locator('#login-email').focus();
    await expect(page.locator('#login-email')).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath('options-narrow-hidpi.png'), fullPage: true });
    await page.setViewportSize({ width: 900, height: 720 });
    expect(await noOverflow(page)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('options-desktop-hidpi.png'), fullPage: true });
  } finally { await context.close(); }
});

async function launch(profile = ''): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profile, {
    headless: false,
    channel: 'chromium',
    viewport: { width: 900, height: 720 },
    deviceScaleFactor: 2,
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      `--host-resolver-rules=${requireStack().browserHostResolverRules}`,
      '--no-proxy-server',
      '--ignore-certificate-errors',
    ],
  });
}

async function options(context: BrowserContext): Promise<{ worker: Worker; page: Page }> {
  return openExtensionOptions(context);
}

async function installBinding(page: Page): Promise<void> {
  await installFixtureReplicaBinding(page, requireStack().extensionBinding);
  await page.evaluate(collection => chrome.storage.local.set({ 'known.sync.collection.v1': collection }), fixtureCollectionId());
}

async function noOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    && document.documentElement.scrollHeight >= document.documentElement.clientHeight);
}

function requireStack(): RealStack {
  if (!stack) throw new Error('P3-27 real stack is unavailable');
  return stack;
}

function waitForWorkerStatus(session: CDPSession, status: 'running' | 'stopped') {
  return new Promise<{ readonly versionId: string }>((resolveWorker, reject) => {
    const timeout = setTimeout(() => {
      session.off('ServiceWorker.workerVersionUpdated', listener);
      reject(new Error(`Timed out waiting for service worker ${status}`));
    }, 10_000);
    const listener = (event: { versions: Array<{ versionId: string; scriptURL: string; runningStatus: string }> }) => {
      const version = event.versions.find((candidate) => candidate.scriptURL === `chrome-extension://${EXTENSION_ID}/service-worker.js`
        && candidate.runningStatus === status);
      if (!version) return;
      clearTimeout(timeout);
      session.off('ServiceWorker.workerVersionUpdated', listener);
      resolveWorker(version);
    };
    session.on('ServiceWorker.workerVersionUpdated', listener);
  });
}
async function readStore(page: Page, storeName: string): Promise<unknown[]> {
  return page.evaluate(async (name) => {
    const request = indexedDB.open('known-phase3-indexeddb-entry');
    const database = await new Promise<IDBDatabase>((resolveRequest, reject) => {
      request.onsuccess = () => resolveRequest(request.result); request.onerror = () => reject(request.error);
    });
    try {
      const values = database.transaction(name, 'readonly').objectStore(name).getAll();
      return await new Promise<unknown[]>((resolveRequest, reject) => {
        values.onsuccess = () => resolveRequest(values.result); values.onerror = () => reject(values.error);
      });
    } finally { database.close(); }
  }, storeName);
}
