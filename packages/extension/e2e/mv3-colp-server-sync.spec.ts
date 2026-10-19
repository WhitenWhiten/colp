import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { gotoOptions, openExtensionOptions, waitForLibraryBinding, showOptionsPane } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';

// Uses an operator-provided self-hosted server. No in-process backend, seeded
// bindings, manufactured receipts, or mocked server responses.
const origin = process.env.COLP_I2_ORIGIN;
const email = process.env.COLP_I2_EMAIL;
const password = process.env.COLP_I2_PASSWORD;
const extension = resolve(import.meta.dirname, '../dist/production');
// Login actions contain operator credentials; keep them out of trace artifacts.
test.use({ trace: 'off', actionTimeout: 20_000 });

test('COLP Server: real first sync, two profiles, web edit, conflict and disconnect', async ({}, info) => {
  test.skip(!origin || !email || !password, 'Set COLP_I2_ORIGIN, COLP_I2_EMAIL and COLP_I2_PASSWORD');
  test.setTimeout(600_000);
  const dirs: string[] = [], contexts: BrowserContext[] = [];
  const webBrowser = await chromium.launch({ headless: false, channel: 'chromium' });
  let web: Page | undefined;
  try {
    const webContext = await webBrowser.newContext({ ignoreHTTPSErrors: false });
    web = await webContext.newPage();
    const webPage = web;
    web.on('pageerror', error => process.stdout.write(`I2 web error: ${error.message}\n`));
    await web.goto(`${origin}/login`);
    await web.locator('#login-identifier').fill(email!);
    await web.locator('#login-password').fill(password!);
    await web.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(web).not.toHaveURL(/\/login/u);
    await web.goto(`${origin}/library`);
    await expect(web.getByTestId('library-nav').getByRole('link', { name: /Bookmarks bar/ })).toBeVisible();
    const collection = await web.evaluate(async () => {
      const response = await fetch('/api/v1/me/library', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`Library discovery returned ${response.status}`);
      const library = await response.json() as { id: string; library: boolean };
      if (!library.library || !library.id) throw new Error('The account library is unavailable');
      return library.id;
    });
    const open = async () => {
      const dir = await mkdtemp(resolve(tmpdir(), 'colp-i2-profile-')); dirs.push(dir);
      const context = await chromium.launchPersistentContext(dir, {
        headless: false, channel: 'chromium', ignoreHTTPSErrors: false,
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-proxy-server'],
      });
      contexts.push(context);
      const { page } = await openExtensionOptions(context);
      page.on('pageerror', error => process.stdout.write(`I2 extension error: ${error.message}\n`));
      await connect(page);
      await showOptionsPane(page, 'bookmarks');
      await grantOptionalBookmarks(page, page.locator('#manager-grant'), 'COLP I2 bookmarks');
      return { context, page };
    };
    const a = await open();
    const first = await addBookmark(a.page, 'I2 first sync', 'https://example.test/i2/first');
    await firstSync(a.page, collection);
    process.stdout.write('I2: first sync completed\n');
    await web.reload();
    await web.getByTestId('library-nav').getByRole('link', { name: /Bookmarks bar/ }).click();
    await expect(web).toHaveURL(/\?folder=/u);
    const libraryUrl = web.url();
    await expect(web.getByRole('button', { name: 'Actions for I2 first sync', exact: true })).toBeVisible({ timeout: 45_000 });
    await a.page.screenshot({ path: info.outputPath('first-sync.png'), fullPage: true });

    const added = await addBookmark(a.page, 'I2 browser addition', 'https://example.test/i2/added');
    await expect.poll(async () => {
      await webPage.reload();
      await webPage.getByRole('button', { name: 'Actions for I2 browser addition', exact: true })
        .waitFor({ state: 'visible', timeout: 3_000 }).catch(() => undefined);
      return webPage.getByRole('button', { name: 'Actions for I2 browser addition', exact: true }).count();
    }, { timeout: 60_000 }).toBe(1);
    process.stdout.write('I2: browser addition visible in web\n');
    await editInWeb(web, 'I2 browser addition', 'I2 edited in web');
    await expect.poll(() => bookmarkTitle(a.page, added.id), { timeout: 60_000 }).toBe('I2 edited in web');
    process.stdout.write('I2: web edit visible in browser\n');
    await web.screenshot({ path: info.outputPath('web-edit.png'), fullPage: true });

    const b = await open();
    await firstSync(b.page, collection);
    await expect.poll(() => findBookmarks(b.page, 'I2 edited in web'), { timeout: 60_000 }).toHaveLength(1);
    const reverse = await addBookmark(b.page, 'I2 second profile', 'https://example.test/i2/reverse');
    await expect.poll(() => findBookmarks(a.page, 'I2 second profile'), { timeout: 60_000 }).toHaveLength(1);
    await b.page.evaluate(({ id }) => chrome.bookmarks.update(id, { title: 'I2 reverse rename' }), reverse);
    await expect.poll(() => findBookmarks(a.page, 'I2 reverse rename'), { timeout: 60_000 }).toHaveLength(1);
    await exerciseBrowserMutations(a.page, b.page, added.id);

    // US-09: B edits offline while A deletes the same bookmark. Neither change
    // may silently erase the other; reconnect must expose a delete/edit conflict.
    const firstOnB = (await findBookmarks(b.page, 'I2 first sync'))[0]!;
    await b.context.setOffline(true);
    await b.page.evaluate(({ id }) => chrome.bookmarks.update(id, { title: 'I2 offline browser conflict' }), firstOnB);
    await a.page.evaluate(({ id }) => chrome.bookmarks.remove(id), first);
    await web.goto(libraryUrl);
    await expect.poll(async () => {
      await webPage.reload();
      await webPage.getByRole('button', { name: 'Actions for I2 move folder', exact: true }).waitFor({ state: 'visible', timeout: 5_000 });
      return webPage.getByRole('button', { name: 'Actions for I2 first sync', exact: true }).count();
    }, { timeout: 60_000 }).toBe(0);
    await b.context.setOffline(false);
    await web.goto(`${origin}/sync`);
    let conflictId: string | undefined;
    await expect.poll(async () => {
      // Use the browser's validated TLS connection and cookie authority; the
      // Playwright Node HTTP client has an independent CA store.
      const page = await webPage.evaluate(async () => {
        const response = await fetch('/api/v1/sync/conflicts?limit=100', { headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error(`Conflict list returned ${response.status}`);
        return response.json() as Promise<{ items: { id: string; collectionId: string; type: string }[] }>;
      });
      conflictId = page.items.find(item => item.collectionId === collection && item.type === 'delete_update')?.id;
      if (!conflictId) return 0;
      await webPage.reload();
      await webPage.locator(`[data-conflict-id="${conflictId}"]`)
        .waitFor({ state: 'visible', timeout: 3_000 }).catch(() => undefined);
      return webPage.locator(`[data-conflict-id="${conflictId}"]`).count();
    }, { timeout: 90_000 }).toBe(1);
    const conflict = web.locator(`[data-conflict-id="${conflictId}"]`);
    await expect(conflict).toContainText('Deleted in one place, changed in the other');
    process.stdout.write('I2: deliberate conflict visible in Sync center\n');
    await web.screenshot({ path: info.outputPath('sync-center-conflict.png'), fullPage: true });

    for (const profile of [a, b]) {
      await showOptionsPane(profile.page, 'account');
      await profile.page.locator('#disconnect-server').click();
      await expect(profile.page.locator('#server-origin')).toHaveValue('');
      expect(await profile.page.evaluate(() => chrome.storage.local.get('runtimeServerOrigin'))).toEqual({});
      expect(await profile.page.evaluate(value => chrome.permissions.contains({ origins: [`${value}/*`] }), origin)).toBe(false);
    }
    // Synced deletions remove the native item; the rejected edit must survive
    // in the retirement archive instead of disappearing when disconnected.
    expect(await findBookmarks(b.page, 'I2 paused addition')).toHaveLength(1);
    expect(await b.page.evaluate(async () => {
      const request = indexedDB.open('known-phase3-indexeddb-entry');
      const db = await new Promise<IDBDatabase>((resolveDb, reject) => {
        request.onsuccess = () => resolveDb(request.result); request.onerror = () => reject(request.error);
      });
      try {
        const rows = db.transaction('retired_archives', 'readonly').objectStore('retired_archives').getAll();
        const archives = await new Promise<unknown[]>((resolveRows, reject) => {
          rows.onsuccess = () => resolveRows(rows.result); rows.onerror = () => reject(rows.error);
        });
        return JSON.stringify(archives).includes('I2 offline browser conflict');
      } finally { db.close(); }
    })).toBe(true);
  } catch (error) {
    await web?.screenshot({ path: info.outputPath('web-failure.png'), fullPage: true }).catch(() => undefined);
    for (const [index, context] of contexts.entries()) {
      const page = context.pages().find(candidate => candidate.url().includes('/options.html'));
      if (!page) continue;
      const facts = await page.evaluate(async () => {
        const exported = await chrome.runtime.sendMessage({ kind: 'known.sync-state.evidence', method: 'exportOutboundPushEvidence', args: [] }) as {
          value?: { scope?: { firstRun?: string };
            engine?: { lastPublishedCursor?: string; lastAckedCursor?: string; lastError?: string; notBefore: number; updatedAt: number };
            queue?: { status: string; recovery?: { code: string }; payload?: { type: string } }[];
            diagnostics?: { code: string }[] };
        };
        const state = await chrome.runtime.sendMessage({ kind: 'known.sync-state.evidence', method: 'syncEngineState', args: [] }) as {
          value?: { phase?: string; errorCode?: string; recoveryFrozen?: boolean };
        };
        const value = exported.value ?? {};
        const alarm = await chrome.alarms.get('known-sync-engine');
        return { scope: { firstRun: value.scope?.firstRun,
          cursorAligned: value.engine?.lastPublishedCursor === value.engine?.lastAckedCursor },
          queue: (value.queue ?? []).map((row: { status: string; recovery?: { code: string }; payload?: { type: string } }) =>
            ({ status: row.status, recovery: row.recovery?.code, type: row.payload?.type })),
          diagnostics: (value.diagnostics ?? []).map((row: { code: string }) => row.code),
          engine: { phase: state.value?.phase, lastError: value.engine?.lastError, errorCode: state.value?.errorCode,
            recoveryFrozen: state.value?.recoveryFrozen, notBeforeDeltaMs: value.engine ? value.engine.notBefore - Date.now() : null,
            updatedAgoMs: value.engine ? Date.now() - value.engine.updatedAt : null,
            alarmDeltaMs: alarm ? alarm.scheduledTime - Date.now() : null },
          titles: (await chrome.bookmarks.search({ query: 'I2' })).map(row => row.title) };
      }).catch(() => ({}));
      await info.attach(`profile-${index}-failure`, { body: JSON.stringify(facts, null, 2), contentType: 'application/json' });
    }
    throw error;
  } finally {
    for (const context of contexts) {
      const page = context.pages().find(candidate => candidate.url().includes('/options.html'));
      if (page && await page.locator('body').getAttribute('data-state').catch(() => '') === 'connected') {
        await showOptionsPane(page, 'account').then(() => page.locator('#disconnect-server').click()).catch(() => undefined);
      }
    }
    await Promise.all(contexts.map(context => context.close()));
    await webBrowser.close();
    await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })));
  }
});

async function connect(page: Page): Promise<void> {
  await gotoOptions(page, '#account');
  // A fragment navigation reuses the install document's pending initialization.
  // Reload with an explicit pane so its welcome redirect has finished first.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#login-panel')).toBeVisible();
  let warnings = 0;
  page.on('dialog', dialog => { if (dialog.type() === 'confirm') warnings += 1; });
  // The field saves on `change`, so a retry that refills the same text never
  // asks for the host permission again. Alternate the trailing slash to fire
  // `change` on every attempt; the field normalizes both to the same origin.
  let permissionAttempt = 0;
  await grantOptionalBookmarks(page, page.locator('#login-email'), 'COLP I2 server permission',
    { origins: [`${origin}/*`] }, async () => { await page.locator('#server-origin').fill(`${origin}${permissionAttempt++ % 2 ? '/' : ''}`); });
  if (origin!.startsWith('http:')) expect(warnings).toBeGreaterThanOrEqual(1);
  await page.locator('#login-email').fill(email!);
  await page.locator('#login-password').fill(password!);
  await page.locator('#login-submit').click();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'connected', { timeout: 25_000 });
  await waitForLibraryBinding(page);
}

async function firstSync(page: Page, collection: string): Promise<void> {
  await waitForLibraryBinding(page, collection);
  await showOptionsPane(page, 'folders');
  const start = page.locator('#first-run-start');
  await expect(start).toBeVisible({ timeout: 20_000 });
  const root = page.locator('.root-row .root-select').first();
  if (!await root.locator('input').isChecked()) await root.click();
  await expect(start).toBeEnabled({ timeout: 20_000 });
  await start.click();
  await expect.poll(() => page.evaluate(async () => (await chrome.runtime.sendMessage({ kind: 'known.firstRun.status' }) as { firstRun?: string }).firstRun),
    { timeout: 90_000 }).toBe('completed');
}

async function addBookmark(page: Page, title: string, url: string): Promise<{ id: string }> {
  return page.evaluate(async value => {
    const bar = (await chrome.bookmarks.getTree())[0]!.children![0]!.id;
    return chrome.bookmarks.create({ parentId: bar, ...value });
  }, { title, url });
}

async function bookmarkTitle(page: Page, id: string): Promise<string | undefined> {
  return page.evaluate(async value => (await chrome.bookmarks.get(value))[0]?.title, id);
}

async function findBookmarks(page: Page, title: string): Promise<{ id: string }[]> {
  return page.evaluate(value => chrome.bookmarks.search({ title: value }), title);
}

async function editInWeb(page: Page, current: string, next: string): Promise<void> {
  await page.getByRole('button', { name: `Actions for ${current}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit details', exact: true }).click();
  const drawer = page.getByTestId('node-drawer');
  await drawer.locator('#nd-title').fill(next);
  const saved = page.waitForResponse(response => response.request().method() === 'PATCH'
    && /\/nodes\/[^/?]+$/u.test(new URL(response.url()).pathname));
  await drawer.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByRole('button', { name: `Actions for ${next}`, exact: true })).toBeVisible();
  await drawer.getByRole('button', { name: 'Close editor', exact: true }).click();
  await expect(drawer).toBeHidden();
}

async function exerciseBrowserMutations(a: Page, b: Page, addedId: string): Promise<void> {
  const folder = await a.evaluate(async () => {
    const bar = (await chrome.bookmarks.getTree())[0]!.children![0]!.id;
    return chrome.bookmarks.create({ parentId: bar, title: 'I2 move folder' });
  });
  await expect.poll(() => findBookmarks(b, 'I2 move folder'), { timeout: 90_000 }).toHaveLength(1);
  await a.evaluate(({ id, parentId }) => chrome.bookmarks.move(id, { parentId }), { id: addedId, parentId: folder.id });
  await expect.poll(() => parentTitle(b, 'I2 edited in web'), { timeout: 90_000 }).toBe('I2 move folder');
  const reverseOnA = (await findBookmarks(a, 'I2 reverse rename'))[0]!;
  await a.evaluate(({ id, parentId }) => chrome.bookmarks.move(id, { parentId }), { id: reverseOnA.id, parentId: folder.id });
  await expect.poll(() => parentTitle(b, 'I2 reverse rename'), { timeout: 90_000 }).toBe('I2 move folder');
  await a.evaluate(({ id }) => chrome.bookmarks.move(id, { index: 0 }), reverseOnA);
  await expect.poll(() => b.evaluate(async () => {
    const target = (await chrome.bookmarks.search({ title: 'I2 move folder' }))[0]!;
    return (await chrome.bookmarks.getChildren(target.id)).map(node => node.title);
  }), { timeout: 90_000 }).toEqual(['I2 reverse rename', 'I2 edited in web']);
  await a.evaluate(({ id }) => chrome.bookmarks.remove(id), reverseOnA);
  await expect.poll(() => findBookmarks(b, 'I2 reverse rename'), { timeout: 90_000 }).toHaveLength(0);
  process.stdout.write('I2: browser move, reorder and delete reached the second profile\n');

  await showOptionsPane(a, 'sync-center');
  await a.locator('#personal-sync-toggle').click();
  await expect(a.locator('#personal-sync-status')).toHaveText('Sync is paused');
  await addBookmark(a, 'I2 paused addition', 'https://example.test/i2/paused');
  expect(await findBookmarks(b, 'I2 paused addition')).toHaveLength(0);
  await a.locator('#personal-sync-toggle').click();
  await a.getByRole('dialog', { name: 'Review before resuming', exact: true })
    .getByRole('button', { name: 'Resume sync', exact: true }).click();
  await expect(a.locator('#personal-sync-status')).toHaveText('Sync is on');
  await expect.poll(() => findBookmarks(b, 'I2 paused addition'), { timeout: 90_000 }).toHaveLength(1);
  for (const page of [a, b]) {
    expect(await findBookmarks(page, 'I2 edited in web')).toHaveLength(1);
    expect(await findBookmarks(page, 'I2 paused addition')).toHaveLength(1);
  }
  process.stdout.write('I2: pause/resume reconciled changes without duplicate bookmarks\n');
}

async function parentTitle(page: Page, title: string): Promise<string | undefined> {
  return page.evaluate(async value => {
    const node = (await chrome.bookmarks.search({ title: value }))[0];
    return node?.parentId ? (await chrome.bookmarks.get(node.parentId))[0]?.title : undefined;
  }, title);
}
