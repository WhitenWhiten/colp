import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { EXTENSION_ID } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import type { CaptureTask } from '../src/capture/contracts.js';

const extensionPath = resolve(import.meta.dirname, '../dist/development');
const launch = (profile: string) => chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium', args: [
  `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
] });

/** Delete lives in the row's More actions menu now; the confirmation is the batch dialog. */
async function deleteRow(page: Page, title: string) {
  const row = page.locator('.mgr-row').filter({ has: page.getByLabel(`More actions ${title}`, { exact: true }) }).first();
  await row.hover();
  await row.getByRole('button', { name: `More actions ${title}`, exact: true }).click();
  await page.locator('.mgr-menu-item', { hasText: 'Delete' }).click();
}
/** Checkboxes only show once Select is on. */
async function selectRows(page: Page, ids: readonly string[]) {
  await page.locator('#manager-select').click();
  for (const id of ids) await page.locator(`.mgr-row[data-id="${id}"] input.mgr-select`).check();
}

test('folder descriptions survive offline editing and restarting a signed-out browser', async () => {
  const profile = await mkdtemp(resolve(tmpdir(), 'known-local-folder-description-'));
  let context = await launch(profile);
  try {
    let page = context.pages()[0] ?? await context.newPage();
    await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#bookmarks`);
    await expect(page.locator('body')).toHaveAttribute('data-pane', 'bookmarks');
    await grantOptionalBookmarks(page, 'Allow bookmark access', 'Folder description'); await page.reload();
    await context.setOffline(true);
    await page.getByRole('button', { name: 'New folder', exact: true }).click();
    await page.getByRole('textbox', { name: 'New folder name', exact: true }).fill('Offline described folder');
    await page.getByLabel('Description (optional)', { exact: true }).fill('Developer tools and documentation');
    await page.locator('.mgr-composer button[type="submit"]').click();
    let row = page.locator('.mgr-row').filter({ has: page.getByRole('button', { name: 'Offline described folder', exact: true }) });
    await expect(row.locator('.mgr-folder-description')).toHaveText('Developer tools and documentation');
    expect(await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.auth.status' }))).toMatchObject({ state: { status: 'signed_out' } });
    await context.close(); context = await launch(profile); await context.setOffline(true);
    page = context.pages()[0] ?? await context.newPage();
    await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#bookmarks`);
    row = page.locator('.mgr-row').filter({ has: page.getByRole('button', { name: 'Offline described folder', exact: true }) });
    await expect(row.locator('.mgr-folder-description')).toHaveText('Developer tools and documentation');
    const folderId = await row.getAttribute('data-id');
    await row.getByRole('button', { name: 'Edit folder Offline described folder', exact: true }).locator('svg').click();
    row = page.locator(`.mgr-row[data-id="${folderId}"]`);
    await expect(row.locator('.mgr-select')).not.toBeChecked();
    await expect(page.getByLabel('Description (optional)', { exact: true })).toHaveValue('Developer tools and documentation');
    await page.getByLabel('Description (optional)', { exact: true }).fill('');
    await expect(row.locator('.mgr-select')).not.toBeChecked();
    await page.getByRole('dialog', { name: 'Edit folder' }).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('#manager-feedback')).toHaveText('Folder saved.');
    await expect(page.getByRole('dialog', { name: 'Edit folder' })).toHaveCount(0);
    await expect(page.locator('.mgr-folder-description')).toHaveCount(0);
    await page.reload(); await expect(page.getByRole('button', { name: 'Offline described folder', exact: true }).first()).toBeVisible();
    await expect(page.locator('.mgr-folder-description')).toHaveCount(0);
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});

test('a guest restores a deleted local folder and its contents after browser restart', async () => {
  const profile = await mkdtemp(resolve(tmpdir(), 'known-local-delete-'));
  let context: BrowserContext | undefined;
  try {
    context = await launch(profile);
    let page = context.pages()[0] ?? await context.newPage();
    await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#bookmarks`);
    await expect(page.locator('body')).toHaveAttribute('data-pane', 'bookmarks');
    await page.waitForTimeout(800);
    await grantOptionalBookmarks(page, 'Allow bookmark access', 'Known local deletion');
    await page.reload();
    const parentId = await page.evaluate(async () => {
      const parentId = (await chrome.bookmarks.getTree())[0]!.children![0]!.id;
      const folder = await chrome.bookmarks.create({ parentId, title: 'Restore my local folder' });
      const nested = await chrome.bookmarks.create({ parentId: folder.id, title: 'Nested folder' });
      await chrome.bookmarks.create({ parentId: nested.id, title: 'First copy', url: 'https://example.org/restore-local' });
      await chrome.bookmarks.create({ parentId: nested.id, title: 'Second copy', url: 'https://example.org/restore-local' });
      return parentId;
    });
    await deleteRow(page, 'Restore my local folder');
    await page.locator('#manager-batch-confirm').click();
    await expect(page.locator('#manager-batch-undo')).toBeVisible();
    expect(await page.evaluate(() => chrome.bookmarks.search({ url: 'https://example.org/restore-local' }))).toHaveLength(0);
    await context.close(); context = await launch(profile);
    page = context.pages()[0] ?? await context.newPage();
    await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#bookmarks`);
    await context.setOffline(true);
    await expect(page.locator('#manager-batch-undo')).toBeVisible();
    await page.locator('#manager-batch-undo').click();
    await expect(page.locator('#manager-feedback')).toHaveText('Undone.');
    const restored = await page.evaluate(async parentId => {
      const root = (await chrome.bookmarks.getChildren(parentId)).find(node => node.title === 'Restore my local folder')!;
      return (await chrome.bookmarks.getSubTree(root.id))[0];
    }, parentId);
    expect(restored).toMatchObject({ parentId, title: 'Restore my local folder', children: [{ title: 'Nested folder',
      children: [{ title: 'First copy', url: 'https://example.org/restore-local' }, { title: 'Second copy', url: 'https://example.org/restore-local' }] }] });
    const status = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.batch.status' }));
    expect(status).toMatchObject({ ok: true, status: { state: 'undone', undone: 1, failed: 0 } });
  } finally { await context?.close(); await rm(profile, { recursive: true, force: true }); }
});

test('folder deletion preserves a bookmark added while the confirmation dialog is open', async () => {
  const profile = await mkdtemp(resolve(tmpdir(), 'known-local-delete-preview-'));
  const context = await launch(profile);
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#bookmarks`);
    await expect(page.locator('body')).toHaveAttribute('data-pane', 'bookmarks'); await page.waitForTimeout(800);
    await grantOptionalBookmarks(page, 'Allow bookmark access', 'Known deletion preview'); await page.reload();
    const id = await page.evaluate(async () => {
      const parentId = (await chrome.bookmarks.getTree())[0]!.children![0]!.id;
      return (await chrome.bookmarks.create({ parentId, title: 'Folder changing after preview' })).id;
    });
    await deleteRow(page, 'Folder changing after preview');
    await expect(page.locator('#manager-batch-dialog')).toBeVisible();
    await page.evaluate(parentId => chrome.bookmarks.create({ parentId, title: 'Added while confirming', url: 'https://example.org/new-after-preview' }), id);
    await page.locator('#manager-batch-confirm').click();
    await expect(page.locator('#manager-feedback')).toHaveText('The tree changed. Preview again.');
    expect(await page.evaluate(id => chrome.bookmarks.get(id), id)).toHaveLength(1);
    expect(await page.evaluate(() => chrome.bookmarks.search({ url: 'https://example.org/new-after-preview' }))).toHaveLength(1);
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});

for (const state of ['residual-binding', 'account-no-collection'] as const) test(`${state}: native bookmark deletion and undo stay available`, async () => {
  const profile = await mkdtemp(resolve(tmpdir(), 'known-local-batch-authority-'));
  const context = await launch(profile);
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#bookmarks`);
    await expect(page.locator('body')).toHaveAttribute('data-pane', 'bookmarks'); await page.waitForTimeout(800);
    await grantOptionalBookmarks(page, 'Allow bookmark access', 'Known batch authority'); await page.reload();
    const id = await page.evaluate(async state => {
      await chrome.storage.local.set({ 'known.auth.binding.v1': { replicaId: 'replica-fixture', browserProfileId: 'profile-fixture', generation: '1' } });
      if (state === 'account-no-collection') {
        const config = await fetch(chrome.runtime.getURL('generated-config.json')).then(response => response.json());
        const fence = (await chrome.storage.local.get('known.auth.authority-generation.v1'))['known.auth.authority-generation.v1'] as { generation?: number } | undefined;
        await chrome.storage.session.set({ 'known.auth.credential.v1': { accessToken: 'local-batch-fixture', tokenType: 'Bearer',
          expiresAt: Date.now() + 3600000, scope: ['known.sync'], issuer: config.issuer, audience: config.audience,
          clientId: config.clientId, serverOrigin: config.serverOrigin, subject: 'a'.repeat(32), authorityGeneration: fence?.generation ?? 0 } });
      }
      const parentId = (await chrome.bookmarks.getTree())[0]!.children![0]!.id;
      return (await chrome.bookmarks.create({ parentId, title: 'Local item without collection', url: 'https://example.org/local-batch-authority' })).id;
    }, state);
    const auth = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.auth.status' }));
    expect(auth).toMatchObject({ state: { status: state === 'residual-binding' ? 'signed_out' : 'connected' } });
    await deleteRow(page, 'Local item without collection');
    await page.locator('#manager-batch-confirm').click();
    await expect(page.locator('#manager-feedback')).toHaveText('Deleted.');
    expect(await page.evaluate(id => chrome.bookmarks.get(id).catch(() => []), id)).toHaveLength(0);
    await page.locator('#manager-batch-undo').click();
    await expect(page.locator('#manager-feedback')).toHaveText('Undone.');
    expect(await page.evaluate(() => chrome.bookmarks.search({ url: 'https://example.org/local-batch-authority' }))).toHaveLength(1);
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});

test('a guest edits batch-rename titles, confirms them and can undo the rename', async () => {
  const profile = await mkdtemp(resolve(tmpdir(), 'known-local-batch-rename-')), context = await launch(profile);
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#bookmarks`);
    await expect(page.locator('body')).toHaveAttribute('data-pane', 'bookmarks'); await page.waitForTimeout(800);
    await grantOptionalBookmarks(page, 'Allow bookmark access', 'Known batch rename'); await page.reload();
    const ids = await page.evaluate(async () => {
      const parentId = (await chrome.bookmarks.getTree())[0]!.children![0]!.id;
      const first = await chrome.bookmarks.create({ parentId, title: 'Before first', url: 'https://example.org/rename-first' });
      const second = await chrome.bookmarks.create({ parentId, title: 'Before second', url: 'https://example.org/rename-second' });
      return [first.id, second.id];
    });
    await selectRows(page, ids);
    await page.locator('#manager-batch-rename').click();
    const fields = page.locator('#manager-batch-body input');
    await fields.nth(0).fill('After first'); await fields.nth(1).fill('After second');
    await page.locator('#manager-batch-confirm').click();
    await expect(page.locator('#manager-feedback')).toHaveText('Renamed.');
    expect(await page.evaluate(ids => Promise.all(ids.map(id => chrome.bookmarks.get(id).then(nodes => nodes[0]!.title))), ids)).toEqual(['After first', 'After second']);
    await page.locator('#manager-batch-undo').click();
    await expect(page.locator('#manager-feedback')).toHaveText('Undone.');
    expect(await page.evaluate(ids => Promise.all(ids.map(id => chrome.bookmarks.get(id).then(nodes => nodes[0]!.title))), ids)).toEqual(['Before first', 'Before second']);
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});

test('a guest deletes adjacent bookmarks as one batch and restores their original order', async () => {
  const profile = await mkdtemp(resolve(tmpdir(), 'known-local-batch-position-')), context = await launch(profile);
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#bookmarks`);
    await expect(page.locator('body')).toHaveAttribute('data-pane', 'bookmarks'); await page.waitForTimeout(800);
    await grantOptionalBookmarks(page, 'Allow bookmark access', 'Known batch position'); await page.reload();
    const fixture = await page.evaluate(async () => {
      const parentId = (await chrome.bookmarks.getTree())[0]!.children![0]!.id;
      const first = await chrome.bookmarks.create({ parentId, title: 'First adjacent', url: 'https://example.org/adjacent-first' });
      const second = await chrome.bookmarks.create({ parentId, title: 'Second adjacent', url: 'https://example.org/adjacent-second' });
      await chrome.bookmarks.create({ parentId, title: 'Untouched sibling', url: 'https://example.org/adjacent-untouched' });
      return { parentId, ids: [first.id, second.id] };
    });
    await selectRows(page, fixture.ids);
    await page.locator('#manager-batch-delete').click(); await page.locator('#manager-batch-confirm').click();
    await expect(page.locator('#manager-feedback')).toHaveText('Deleted.');
    expect(await page.evaluate(id => chrome.bookmarks.getChildren(id).then(nodes => nodes.map(node => node.title)), fixture.parentId)).toEqual(['Untouched sibling']);
    await page.locator('#manager-batch-undo').click(); await expect(page.locator('#manager-feedback')).toHaveText('Undone.');
    expect(await page.evaluate(id => chrome.bookmarks.getChildren(id).then(nodes => nodes.map(node => node.title)), fixture.parentId)).toEqual(['First adjacent', 'Second adjacent', 'Untouched sibling']);
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});

for (const mode of ['paused', 'enabled'] as const) test(`${mode} personal sync permits deleting mapped local folders and undoing offline after restart`, async () => {
  const profile = await mkdtemp(resolve(tmpdir(), 'known-local-batch-delete-'));
  let context = await launch(profile);
  try {
    let page = context.pages()[0] ?? await context.newPage();
    await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#bookmarks`);
    await expect(page.locator('body')).toHaveAttribute('data-pane', 'bookmarks');
    await grantOptionalBookmarks(page, 'Allow bookmark access', 'Known paused deletion'); await page.reload();
    const fixture = await page.evaluate(async mode => {
      const config = await fetch(chrome.runtime.getURL('generated-config.json')).then(response => response.json());
      const accountId = 'a'.repeat(32), collectionId = 'paused-collection';
      const binding = { replicaId: 'replica-paused-batch', browserProfileId: 'profile-paused-batch', generation: '1' };
      const parentId = (await chrome.bookmarks.getTree())[0]!.children![0]!.id;
      const first = await chrome.bookmarks.create({ parentId, title: 'First duplicate folder' });
      const second = await chrome.bookmarks.create({ parentId, title: 'Second duplicate folder' });
      await chrome.bookmarks.create({ parentId: first.id, title: 'Nested bookmark', url: 'https://example.org/paused-delete' });
      const { createSyncStateStore } = await import(chrome.runtime.getURL('sync-state-store.js'));
      const store = createSyncStateStore();
      try {
        const scope = { environment: config.environment, serverId: config.serverOrigin, serverOrigin: config.serverOrigin,
          accountId, browserProfileId: binding.browserProfileId, collectionId, replicaId: binding.replicaId, generation: 1 };
        await store.registerScope({ ...scope, lifecycle: 'active', selectedRoots: [parentId],
          lease: { leaseId: 'paused-lease', expiresAt: Date.now() + 3600000 }, checkpoint: { serverRevision: 'r0', cursor: 'c0' } });
        for (const node of [first, second]) await store.putMapping(scope, { nativeId: node.id, colpId: `remote-${node.id}`,
          parentNativeId: parentId, rootNativeId: parentId, nodeKind: 'folder', projection: { revision: 'r1', digest: 'sha256:fixture' } });
      } finally { await store.close(); }
      const policyKey = `known.personal-sync.v1:${JSON.stringify([config.serverOrigin, accountId])}`;
      await chrome.storage.local.set({ 'known.auth.binding.v1': binding, 'known.sync.collection.v1': collectionId,
        [policyKey]: { version: 1, mode, collectionId, revision: crypto.randomUUID(), reason: 'user' } });
      const fence = (await chrome.storage.local.get('known.auth.authority-generation.v1'))['known.auth.authority-generation.v1'] as { generation?: number } | undefined;
      await chrome.storage.session.set({ 'known.auth.credential.v1': { accessToken: 'paused-batch-fixture', tokenType: 'Bearer',
        expiresAt: Date.now() + 3600000, scope: ['known.sync'], issuer: config.issuer, audience: config.audience,
        clientId: config.clientId, serverOrigin: config.serverOrigin, subject: accountId, authorityGeneration: fence?.generation ?? 0 } });
      return { ids: [first.id, second.id], parentId, policyKey };
    }, mode);
    await context.setOffline(true);
    await page.reload();
    await selectRows(page, fixture.ids);
    await page.locator('#manager-batch-delete').click();
    await expect(page.locator('#manager-batch-dialog')).toBeVisible();
    await page.locator('#manager-batch-confirm').click();
    await expect(page.locator('#manager-feedback')).toHaveText('Deleted.');
    expect(await page.evaluate(ids => Promise.all(ids.map(id => chrome.bookmarks.get(id).catch(() => []))), fixture.ids)).toEqual([[], []]);
    if (mode === 'enabled') {
      await context.close(); context = await launch(profile); await context.setOffline(true);
      page = context.pages()[0] ?? await context.newPage();
      await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#bookmarks`);
    }
    await page.locator('#manager-batch-undo').click();
    await expect(page.locator('#manager-feedback')).toHaveText('Undone.');
    const restored = await page.evaluate(async parentId => (await chrome.bookmarks.getSubTree(parentId))[0]!.children, fixture.parentId);
    expect(restored).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'First duplicate folder', children: [expect.objectContaining({ url: 'https://example.org/paused-delete' })] }),
      expect.objectContaining({ title: 'Second duplicate folder', children: [] }),
    ]));
    expect(await page.evaluate(key => chrome.storage.local.get(key).then(value => value[key]), fixture.policyKey)).toMatchObject({ mode });
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});

test('a saved capture keeps its folder, tags and note edits offline across browser restart', async () => {
  const profile = await mkdtemp(resolve(tmpdir(), 'known-local-capture-edit-'));
  let context = await launch(profile);
  try {
    let page = context.pages()[0] ?? await context.newPage();
    await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#bookmarks`);
    await grantOptionalBookmarks(page, 'Allow bookmark access', 'Known local capture edit'); await page.reload();
    await context.setOffline(true);
    const fixture = await page.evaluate(async () => {
      const parentId = (await chrome.bookmarks.getTree())[0]!.children![0]!.id;
      const from = await chrome.bookmarks.create({ parentId, title: 'Original capture folder' });
      const to = await chrome.bookmarks.create({ parentId, title: 'Offline capture destination' });
      const reply = await chrome.runtime.sendMessage({ kind: 'known.capture.start', commandId: crypto.randomUUID(),
        trigger: 'manual-popup', userGesture: true, url: 'https://example.org/offline-capture-edit', title: 'Offline editable capture',
        parentNativeId: from.id, saveAnother: false, allowUnverifiedCloud: false, annotation: { tags: ['Original tag'], note: 'Keep this note' } }) as { ok: boolean; task: CaptureTask };
      if (!reply?.ok) throw new Error(JSON.stringify(reply));
      return { captureId: reply.task.captureId as string, targetId: to.id };
    });
    await expect.poll(() => page.evaluate(async captureId => (await chrome.runtime.sendMessage({ kind: 'known.capture.get', captureId }) as { task: CaptureTask }).task?.annotationPersisted, fixture.captureId)).toBe(true);
    await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#history?task=${fixture.captureId}`);
    await expect(page.getByRole('heading', { name: 'Offline editable capture' })).toBeVisible();
    await expect(page.locator('.detail-fields .tag-input .chip')).toContainText('Original tag');
    await expect(page.getByLabel('Note', { exact: true })).toHaveValue('Keep this note');
    await page.getByRole('button', { name: /^Folder: / }).click();
    await page.getByRole('tree', { name: 'Folder', exact: true }).locator(`[data-folder-id="${fixture.targetId}"]`).click();
    await page.getByLabel('Tags', { exact: true }).fill('Local tag');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.detail-fields [role=status]')).toContainText('Saved.');
    await context.close(); context = await launch(profile); await context.setOffline(true);
    page = context.pages()[0] ?? await context.newPage();
    await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#history?task=${fixture.captureId}`);
    await expect(page.locator('.detail-fields .tag-input .chip')).toHaveCount(2);
    await expect(page.locator('.detail-fields .tag-input')).toContainText('Local tag');
    await expect(page.getByLabel('Note', { exact: true })).toHaveValue('Keep this note');
    await expect(page.getByRole('button', { name: /^Folder: / })).toHaveAttribute('data-value', fixture.targetId);
    const task = await page.evaluate(captureId => chrome.runtime.sendMessage({ kind: 'known.capture.get', captureId }), fixture.captureId) as { ok: boolean; task: CaptureTask };
    expect(task).toMatchObject({ ok: true, task: { sync: 'local-only', editIntent: { completed: true, execution: 'native' } } });
    expect((await page.evaluate(id => chrome.bookmarks.get(id), task.task.nativeId!))[0]?.parentId).toBe(fixture.targetId);
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
