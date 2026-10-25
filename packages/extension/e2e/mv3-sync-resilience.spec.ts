import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startRealStack, type RealStack } from './real-stack.js';
import { openExtensionOptions, showOptionsPane, signInExtension } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';

const extension = resolve(import.meta.dirname, '../dist/production');
const SUBJECT_URL = 'https://example.test/resilience/subject';
async function launch(profile: string, stack: RealStack) {
  return chromium.launchPersistentContext(profile, { channel: 'chromium', headless: false, ignoreHTTPSErrors: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      `--host-resolver-rules=${stack.browserHostResolverRules}`, '--no-proxy-server', '--ignore-certificate-errors'] });
}
async function evidence(page: Page, method: string) {
  const result: any = await page.evaluate(method => chrome.runtime.sendMessage({ kind: 'known.sync-state.evidence', method, args: [] }), method);
  expect(result.ok, JSON.stringify(result)).toBe(true); return result.value;
}
async function setupBrowser(context: BrowserContext, stack: RealStack) {
  const { page } = await openExtensionOptions(context);
  await showOptionsPane(page, 'bookmarks');
  await grantOptionalBookmarks(page, page.locator('#manager-grant'), 'Sync resilience acceptance');
  const bookmark = await page.evaluate(async url => chrome.bookmarks.create({ parentId: '1', title: 'Protected subject', url }), SUBJECT_URL);
  await signInExtension(page, stack.collectionId);
  await completeSetup(page);
  await expect.poll(async () => (await stack.observations()).canonicalNodes as any[], { timeout: 60000 })
    .toEqual(expect.arrayContaining([expect.objectContaining({ url: SUBJECT_URL, deleted_at: null })]));
  const web = await context.newPage(); await web.goto(`${stack.serverOrigin}/sync`);
  await expect(web.getByRole('heading', { name: 'Sync center', exact: true })).toBeVisible();
  return { page, web, bookmark };
}
async function completeSetup(page: Page) {
  await showOptionsPane(page, 'folders');
  for (const title of ['Bookmarks bar', 'Other bookmarks']) {
    const selected = page.locator('.root-row').filter({ has: page.locator('.folder-name', { hasText: title }) }).locator('.root-select input');
    await expect(selected).toBeVisible(); if (!await selected.isChecked()) await selected.check();
  }
  await expect(page.locator('#first-run-start')).toBeEnabled({ timeout: 30000 });
  await page.locator('#first-run-start').click();
  await expect.poll(() => page.evaluate(async () => (await chrome.runtime.sendMessage({ kind: 'known.firstRun.status' }) as any).firstRun),
    { timeout: 90000 }).toBe('completed');
}
async function status(web: Page) { return web.evaluate(async () => (await fetch('/api/v1/sync/status')).json()); }
async function refresh(web: Page) { await web.getByRole('button', { name: 'Refresh', exact: true }).click(); }
async function currentReplica(page: Page): Promise<string> {
  return page.evaluate(async () => ((await chrome.storage.local.get('known.auth.binding.v1'))['known.auth.binding.v1'] as { replicaId: string }).replicaId);
}
async function pendingDelete(page: Page, stack: RealStack, url: string) {
  const policy: any = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.remoteDelete.policy.get' }));
  const configured: any = await page.evaluate(expectedCasVersion => chrome.runtime.sendMessage({ kind: 'known.remoteDelete.policy.set',
    policy: 'confirm', expectedCasVersion, userGesture: true }), policy.casVersion);
  expect(configured.ok, JSON.stringify(configured)).toBe(true);
  const canonical = ((await stack.observations()).canonicalNodes as any[]).find(node => node.url === url && node.deleted_at === null);
  expect(canonical).toBeTruthy(); await stack.resilience!.deleteNode(canonical.id);
  await expect.poll(async () => { await evidence(page, 'wakeDurableEngineEvidence');
    return (await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.remoteDelete.pending.list' })) as any).pendingCount;
  }, { timeout: 45000 }).toBe(1);
  await evidence(page, 'reportReplicaHealthEvidence');
}
async function webRebuild(web: Page) {
  await refresh(web); await web.getByRole('button', { name: 'Reset sync', exact: true }).first().click();
  await web.getByRole('dialog').getByRole('button', { name: 'Reset sync', exact: true }).click();
}

test('reset and remerge preserve every existing folder, bookmark, duplicate occurrence and native identity', async () => {
  test.setTimeout(180000); const stack = await startRealStack();
  const profile = await mkdtemp(resolve(tmpdir(), 'colp-reset-identity-')); let context: BrowserContext | undefined;
  const localTree = (page: Page) => page.evaluate(async () => {
    const rows: { id: string; parentId?: string; title: string; url?: string }[] = [];
    const visit = (node: chrome.bookmarks.BookmarkTreeNode) => {
      rows.push({ id: node.id, parentId: node.parentId, title: node.title, ...(node.url ? { url: node.url } : {}) });
      node.children?.forEach(visit);
    };
    (await chrome.bookmarks.getTree()).forEach(visit);
    return rows.sort((a, b) => a.id.localeCompare(b.id));
  });
  try {
    context = await launch(profile, stack);
    const { page } = await openExtensionOptions(context);
    await showOptionsPane(page, 'bookmarks');
    await grantOptionalBookmarks(page, page.locator('#manager-grant'), 'Reset identity acceptance');
    await page.evaluate(async () => {
      const folder = await chrome.bookmarks.create({ parentId: '1', title: 'Existing folder' });
      const nested = await chrome.bookmarks.create({ parentId: folder.id, title: 'Existing nested folder' });
      for (const parentId of ['1', folder.id, nested.id, nested.id, '2']) {
        await chrome.bookmarks.create({ parentId, title: 'Intentionally repeated', url: 'https://example.test/reset-existing' });
      }
    });
    await signInExtension(page, stack.collectionId); await completeSetup(page);
    await expect.poll(async () => ((await stack.observations()).canonicalNodes as any[])
      .filter(node => node.url === 'https://example.test/reset-existing' && node.deleted_at === null).length,
    { timeout: 45000 }).toBe(5);
    const beforeLocal = await localTree(page);
    const beforeRemote = ((await stack.observations()).canonicalNodes as any[])
      .filter(node => node.deleted_at === null).map(node => node.id).sort();
    await page.evaluate(async () => {
      await chrome.alarms.clear('known-sync-engine');
      const response: any = await chrome.runtime.sendMessage({ kind: 'known.sync.engine.status' });
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('known-phase3-indexeddb-entry');
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('sync_engine', 'readwrite');
          tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
          const store = tx.objectStore('sync_engine'); const request = store.get(response.engine.scopeKey);
          request.onsuccess = () => store.put({ ...request.result, revision: request.result.revision + 1,
            phase: 'error', recoveryFrozen: true, lastError: 'payload_too_large', notBefore: 0 });
        });
      } finally { db.close(); }
    });
    const preview: any = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.scope.rebuild.preview' }));
    expect(preview.ok, JSON.stringify(preview)).toBe(true);
    const reset = await page.evaluate(preview => chrome.runtime.sendMessage({ kind: 'known.scope.rebuild.confirm', userGesture: true,
      replicaId: preview.replicaId, generation: preview.generation, revision: preview.revision, targetFence: preview.targetFence }), preview.preview);
    expect(reset).toEqual({ ok: true, result: 'setup_required' });
    await page.reload(); await completeSetup(page);
    await evidence(page, 'wakeDurableEngineEvidence');
    expect(await localTree(page)).toEqual(beforeLocal);
    expect(((await stack.observations()).canonicalNodes as any[]).filter(node => node.deleted_at === null)
      .map(node => node.id).sort()).toEqual(beforeRemote);
    const queued = await evidence(page, 'exportOutboundPushEvidence');
    expect(queued.queue.filter((row: any) => row.payload.type === 'create_node')).toHaveLength(0);
  } finally { await context?.close(); await stack.close(); await rm(profile, { recursive: true, force: true }); }
});

test('duplicate bookmarks complete first sync and stay independent; legacy duplicate reviews clear without a reset', async () => {
  test.setTimeout(180000); const stack = await startRealStack({ web: true });
  const profile = await mkdtemp(resolve(tmpdir(), 'colp-duplicate-sync-')); let context: BrowserContext | undefined;
  const repeated = 'https://example.test/resilience/repeated';
  try {
    context = await launch(profile, stack);
    const { page } = await openExtensionOptions(context);
    await showOptionsPane(page, 'bookmarks');
    await grantOptionalBookmarks(page, page.locator('#manager-grant'), 'Duplicate bookmark sync acceptance');
    const saved = await page.evaluate(async url => {
      const folder = await chrome.bookmarks.create({ parentId: '1', title: 'Duplicates in another folder' });
      const nodes = [];
      for (const parentId of ['1', '1', '1', folder.id, folder.id, '2']) {
        nodes.push(await chrome.bookmarks.create({ parentId, title: 'Repeated bookmark', url }));
      }
      return nodes;
    }, repeated);
    await signInExtension(page, stack.collectionId); await completeSetup(page);
    await expect.poll(async () => ((await stack.observations()).canonicalNodes as any[])
      .filter(node => node.url === repeated && node.deleted_at === null).length, { timeout: 45000 }).toBe(6);
    await page.evaluate(id => chrome.bookmarks.update(id, { title: 'Edited one occurrence' }), saved[0]!.id);
    await expect.poll(async () => ((await stack.observations()).canonicalNodes as any[])
      .filter(node => node.url === repeated && node.deleted_at === null && node.title === 'Edited one occurrence').length,
    { timeout: 45000 }).toBe(1);
    await page.evaluate(url => chrome.bookmarks.create({ parentId: '1', title: 'Repeated bookmark', url }), repeated);
    await expect.poll(async () => ((await stack.observations()).canonicalNodes as any[])
      .filter(node => node.url === repeated && node.deleted_at === null).length, { timeout: 45000 }).toBe(7);
    const replica = await currentReplica(page);
    // Reproduce the report left by an older build, without changing any
    // bookmark, mapping, upload, or replica identity.
    await page.evaluate(async () => {
      const state: any = await chrome.runtime.sendMessage({ kind: 'known.sync.engine.status' });
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('known-phase3-indexeddb-entry');
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('bootstrap_runs', 'readwrite');
          tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
          const store = tx.objectStore('bootstrap_runs'); const request = store.getAll();
          request.onsuccess = () => {
            const run = request.result.find((row: any) => row.scopeKey === state.engine.scopeKey && !row.previewOnly);
            if (!run) { tx.abort(); return; }
            store.put({ ...run, phase: 'needs_attention', attention: { reportId: run.runId, version: 1,
              candidateCount: 14, conflictCount: 0, localOnlyCount: 0, remoteOnlyCount: 0, matchedCount: 7,
              createdAt: Date.now(), items: Array.from({ length: 14 }, (_, i) => ({ itemId: `legacy-duplicate-${i}`,
                kind: 'duplicate_candidate', locationCount: 2, decision: 'open' })) } });
          };
        });
      } finally { db.close(); }
    });
    await page.reload();
    const firstRun: any = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.firstRun.status' }));
    expect(firstRun).toMatchObject({ ok: true, firstRun: 'completed', phase: 'completed', attention: { pendingCount: 0 } });
    await expect(page.locator('#first-run-attention')).toBeHidden();
    const progress: any = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.sync.progress.get' }));
    expect(progress.progress?.issueCount ?? 0).toBe(0);
    await evidence(page, 'reportReplicaHealthEvidence');
    const web = await context.newPage(); await web.goto(`${stack.serverOrigin}/sync`);
    await expect.poll(async () => (await status(web)).replicas.find((row: any) => row.id === replica)?.health)
      .toMatchObject({ state: 'syncing', issueCount: 0, actions: [] });
    expect(await currentReplica(page)).toBe(replica);
    expect(await page.evaluate(async url => (await chrome.bookmarks.search({ url })).length, repeated)).toBe(7);
  } finally { await context?.close(); await stack.close(); await rm(profile, { recursive: true, force: true }); }
});

test('web Retry executes in MV3; result loss and browser restart retain the real server receipt', async () => {
  test.setTimeout(240000); const stack = await startRealStack({ web: true });
  const profile = await mkdtemp(resolve(tmpdir(), 'colp-resilience-retry-')); let context: BrowserContext | undefined;
  let releaseRetry = () => {};
  try {
    context = await launch(profile, stack); let { page, web } = await setupBrowser(context, stack);
    const replicaId = await currentReplica(page);
    stack.resilience!.setPullDenial(true);
    // A manual wake may first encounter the normal polling deadline. Wait for the actual circuit state,
    // instead of assuming six immediate wake requests have each sent a Pull.
    await expect.poll(async () => {
      await evidence(page, 'wakeDurableEngineEvidence');
      const { engine } = await evidence(page, 'exportOutboundPushEvidence');
      return engine?.phase === 'error' && engine?.lastError === 'need_authority' && engine?.circuitBreaker?.retryAt !== undefined;
    }, { timeout: 75000, intervals: [1000] }).toBe(true);
    await evidence(page, 'reportReplicaHealthEvidence'); await refresh(web);
    await expect.poll(async () => (await status(web)).replicas.find((r: any) => r.id === replicaId)?.health)
      .toMatchObject({ state: 'degraded', code: 'need_authority', actions: ['retry'] });
    await expect(web.locator('.replica-card').filter({ hasText: 'hit repeated errors and is waiting to try again' }))
      .toContainText('need_authority');
    // Hold the POST until the first status read: a click can finish before the
    // server records the command, so polling must tolerate an empty command list.
    const retryReady = new Promise<void>(resolve => { releaseRetry = resolve; });
    await web.route(`**/api/v1/sync/replicas/${replicaId}/commands`, async route => {
      await retryReady; await route.continue();
    }, { times: 1 });
    await web.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect.poll(async () => {
      try { return (await status(web)).replicas.find((r: any) => r.id === replicaId)?.health?.commands[0]?.state; }
      finally { releaseRetry(); }
    }).toBe('pending');
    stack.resilience!.setPullDenial(false); stack.resilience!.loseResultResponse();
    await evidence(page, 'reportReplicaHealthEvidence');
    await expect.poll(async () => (await status(web)).replicas.find((r: any) => r.id === replicaId)?.health?.commands[0]?.state).toBe('done');
    await context.close(); context = await launch(profile, stack);
    page = (await openExtensionOptions(context)).page;
    await evidence(page, 'reportReplicaHealthEvidence');
    web = await context.newPage(); await web.goto(`${stack.serverOrigin}/sync`);
    await expect(web.locator('.replica-card').filter({ hasText: /tried again, and it now reports that sync is running/ })).toBeVisible();
    const replica = (await status(web)).replicas.find((r: any) => r.id === replicaId);
    expect(replica.health.commands).toHaveLength(1);
    expect(replica.health.commands[0]).toMatchObject({ state: 'done', resultCode: 'retry_completed' });
    expect(replica.health.state).toBe('syncing');
  } finally { releaseRetry(); stack.resilience?.releaseCommandResponse(); await context?.close(); await stack.close(); await rm(profile, { recursive: true, force: true }); }
});

test('pending deletion allows unrelated live sync; delayed web Rebuild recognizes a local reset, then a normal web Rebuild archives and reports setup', async () => {
  test.setTimeout(300000); const stack = await startRealStack({ web: true });
  const profile = await mkdtemp(resolve(tmpdir(), 'colp-resilience-rebuild-')); let context: BrowserContext | undefined;
  try {
    context = await launch(profile, stack); const { page, web, bookmark } = await setupBrowser(context, stack);
    const original = await currentReplica(page);
    await pendingDelete(page, stack, SUBJECT_URL);
    await page.evaluate(() => chrome.bookmarks.create({ parentId: '1', title: 'Anchored to pending deletion', url: 'https://example.test/resilience/related' }));
    const independent = await page.evaluate(() => chrome.bookmarks.create({ parentId: '2', title: 'Independent after issue', url: 'https://example.test/resilience/independent' }));
    try { await expect.poll(async () => { await evidence(page, 'wakeDurableEngineEvidence');
      return ((await stack.observations()).canonicalNodes as any[]).some(node => node.url === independent.url && node.deleted_at === null);
    }, { timeout: 45000 }).toBe(true); } catch (error) {
      const diagnostic = await evidence(page, 'exportOutboundPushEvidence');
      console.log(JSON.stringify({ engine: diagnostic.engine, queue: diagnostic.queue.map((row: any) => ({ status: row.status, recovery: row.recovery, payload: row.payload })) })); throw error;
    }
    const held = await evidence(page, 'exportOutboundPushEvidence');
    expect(held.queue.some((row: any) => row.status === 'set_aside' && !row.attempt
      && row.payload.payload?.node?.url === 'https://example.test/resilience/related')).toBe(true);
    await page.bringToFront();
    const progress: any = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.sync.progress.get' }));
    expect(progress.ok, JSON.stringify(progress)).toBe(true);
    expect(progress.progress.issueCount).toBeGreaterThan(0);
    await expect(page.locator('#sync-progress-title')).toHaveText('Action required', { timeout: 35000 });
    expect(await page.evaluate(id => chrome.bookmarks.get(id).then(nodes => nodes.length), bookmark.id)).toBe(1);
    await evidence(page, 'reportReplicaHealthEvidence');
    await refresh(web); await expect(web.locator('.replica-card').filter({ hasText: /items? on this browser/ })).toBeVisible();
    await webRebuild(web); stack.resilience!.delayCommandResponse();
    await page.evaluate(() => { void chrome.runtime.sendMessage({ kind: 'known.sync-state.evidence', method: 'reportReplicaHealthEvidence', args: [] }); });
    await expect.poll(() => stack.resilience!.commandResponseWaiting()).toBe(true);
    // A local Reset completes the server-fenced rebuild while its receipt waits on HTTP.
    // The old archive proves completion; the delayed command must not reset the new scope.
    const preview: any = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.scope.rebuild.preview' }));
    expect(preview.ok, JSON.stringify(preview)).toBe(true);
    const reset = await page.evaluate(preview => chrome.runtime.sendMessage({ kind: 'known.scope.rebuild.confirm', userGesture: true,
      replicaId: preview.replicaId, generation: preview.generation, revision: preview.revision, targetFence: preview.targetFence }), preview.preview);
    expect(reset).toEqual({ ok: true, result: 'setup_required' });
    const replacement = await currentReplica(page); expect(replacement).not.toBe(original);
    stack.resilience!.releaseCommandResponse();
    await evidence(page, 'reportReplicaHealthEvidence');
    await expect.poll(async () => (await status(web)).replicas.find((r: any) => r.id === original)?.health?.commands[0]?.state).toBe('done');
    const retired = (await status(web)).replicas.find((r: any) => r.id === original);
    expect(retired.status).toBe('retired');
    expect(retired.health.code).toBe('replica_rebuilt');
    expect(retired.health.commands).toHaveLength(1);
    expect(retired.health.commands[0]).toMatchObject({ action: 'rebuild', state: 'done', resultCode: null });
    expect(await currentReplica(page)).toBe(replacement);
    await refresh(web); await expect(web.getByText(/Sync on this browser was reset/)).toBeVisible();
    await expect(page.locator('#first-run-start')).toBeVisible();
    await completeSetup(page);
    await expect.poll(async () => ((await stack.observations()).canonicalNodes as any[])
      .some(node => node.url === 'https://example.test/resilience/related' && node.deleted_at === null),
    { timeout: 45000 }).toBe(true);
    await pendingDelete(page, stack, String(independent.url));
    await webRebuild(web); await evidence(page, 'reportReplicaHealthEvidence');
    await expect.poll(async () => (await status(web)).replicas.find((r: any) => r.id === replacement)?.health?.commands[0]?.state).toBe('done');
    const final = (await status(web)).replicas.find((r: any) => r.id === replacement);
    expect(final.health.code).toBe('replica_rebuilt');
    expect(await currentReplica(page)).not.toBe(replacement);
    await expect(page.locator('#first-run-start')).toBeVisible();
    expect(await page.evaluate(id => chrome.bookmarks.get(id).then(nodes => nodes.length), independent.id)).toBe(1);
    await refresh(web); await expect(web.getByText(/Sync on this browser was reset/).last()).toBeVisible();
  } finally { stack.resilience?.releaseCommandResponse(); await context?.close(); await stack.close(); await rm(profile, { recursive: true, force: true }); }
});
