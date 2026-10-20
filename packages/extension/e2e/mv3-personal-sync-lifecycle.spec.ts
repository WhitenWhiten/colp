import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startRealStack, type PushRequestObservation } from './real-stack.js';
import { installFixtureReplicaBinding, openExtensionOptions, chooseLibraryMetadata, signInExtension, showOptionsPane, waitForLibraryBinding, EXTENSION_FIXTURE_EMAIL, EXTENSION_FIXTURE_PASSWORD } from './extension-auth.js';
import type { SyncScope, QueueOperation } from '../src/sync-state-store.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';

const extension = resolve(import.meta.dirname, '../dist/production');
// These scopes sync through the pre-bootstrapped fixture replica without a first sync in this browser,
// which the card reports as ready to sync; either way the policy is enabled.
const ENABLED = /^(Sync is on|Ready to sync\. Review your browser’s bookmarks to start the first sync\.)$/u;
const launch = (profile: string, rules: string) => chromium.launchPersistentContext(profile, {
  headless: false, channel: 'chromium', ignoreHTTPSErrors: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
    `--host-resolver-rules=${rules}`, '--no-proxy-server', '--ignore-certificate-errors'],
});

for (const nested of [false, true]) test(`paused local deletions survive browser restart and a required server snapshot, then reach the server${nested ? ' (nested subtree)' : ''}`, async () => {
  test.setTimeout(180000);
  const stack = await startRealStack(), profile = await mkdtemp(resolve(tmpdir(), 'known-paused-delete-recovery-'));
  let context: BrowserContext | undefined;
  try {
    const canonical = await stack.seedCanonicalFixture(nested);
    context = await launch(profile, stack.browserHostResolverRules);
    let page = (await openExtensionOptions(context)).page;
    await installFixtureReplicaBinding(page, stack.extensionBinding);
    await signInExtension(page); await showOptionsPane(page, 'folders');
    await grantOptionalBookmarks(page, 'Allow bookmark access', 'Know-N paused deletion');
    const local = await page.evaluate(async nested => {
      const bar = (await chrome.bookmarks.getTree())[0]!.children![0]!.id;
      const root = await chrome.bookmarks.create({ parentId: bar, title: 'Paused deletion root' });
      const folder = await chrome.bookmarks.create({ parentId: root.id, title: 'Authority folder' });
      const bookmark = await chrome.bookmarks.create({ parentId: nested ? folder.id : root.id, title: 'Authority bookmark', url: 'https://example.test/p3-31/authority' });
      return { root: root.id, folder: folder.id, bookmark: bookmark.id };
    }, nested);
    await evidence(page, 'drainBookmarkEventCaptureEvidence');
    await evidence(page, 'configureOutboundCanonicalFixture', local.root, null, local.folder, local.bookmark, canonical);
    const exported = await evidence(page, 'exportOutboundPushEvidence') as { scope: SyncScope };
    const record = exported.scope;
    const scope: SyncScope = { environment: record.environment, serverId: record.serverId, serverOrigin: record.serverOrigin,
      accountId: record.accountId, browserProfileId: record.browserProfileId, collectionId: record.collectionId,
      replicaId: record.replicaId, generation: record.generation };
    await change(page, 'Pause sync');
    const nativeIds = nested ? [local.folder] : [local.folder, local.bookmark];
    const preview = await page.evaluate(nativeIds => chrome.runtime.sendMessage({ kind: 'known.batch.preview', operation: 'delete', nativeIds }), nativeIds) as { ok: boolean; preview: { digest: string } };
    expect(preview).toMatchObject({ ok: true });
    const deleted = await page.evaluate(({ nativeIds, digest }) => chrome.runtime.sendMessage({ kind: 'known.batch.confirm', operation: 'delete', nativeIds,
      commandId: crypto.randomUUID(), previewDigest: digest, secondConfirm: true, userGesture: true }), { nativeIds, digest: preview.preview.digest });
    expect(deleted).toMatchObject({ ok: true, status: { applied: nativeIds.length } });
    await expect.poll(() => page.evaluate(async scope => {
      const { createSyncStateStore } = await import(chrome.runtime.getURL('sync-state-store.js'));
      const store = createSyncStateStore();
      try { return (await store.listBookmarkEventsByStatus(scope, 'pending')).filter((row: { kind: string }) => row.kind === 'remove').length; }
      finally { store.close(); }
    }, scope)).toBe(nativeIds.length);
    expect(await page.evaluate(id => chrome.bookmarks.getChildren(id), local.root)).toHaveLength(0);
    expect((await stack.listDeletedCanonicalNodes()).filter(row => [canonical.folderId, canonical.bookmarkId].includes(row.id))).toHaveLength(0);
    await stack.forceFixtureReplicaRecovery();
    await context.close(); context = await launch(profile, stack.browserHostResolverRules);
    page = (await openExtensionOptions(context)).page;
    await change(page, 'Resume sync', 'Resume sync');
    await expect.poll(async () => (await stack.listDeletedCanonicalNodes()).map(row => row.id), { timeout: 60000 })
      .toEqual(expect.arrayContaining([canonical.folderId, canonical.bookmarkId])).catch(async error => {
        const debug = await evidence(page, 'exportScope', scope) as Record<string, unknown>;
        const observations = await stack.observations();
        console.info('paused-delete-state', JSON.stringify({ engine: debug.engine, recovery: debug.recovery,
          bookmarkEvents: debug.bookmarkEvents, queue: debug.queue, ackIntents: debug.ackIntents,
          pushResponses: observations.pushResponses, pushErrors: observations.pushErrors }));
        throw error;
      });
    expect(await page.evaluate(id => chrome.bookmarks.getChildren(id), local.root)).toHaveLength(0);
    await page.reload();
    expect(await page.evaluate(id => chrome.bookmarks.getChildren(id), local.root)).toHaveLength(0);
  } finally { await context?.close(); await stack.close(); await rm(profile, { recursive: true, force: true }); }
});

test('offline logout preserves device facts and same-account reconnect requires review', async () => {
  test.setTimeout(150000);
  const stack = await startRealStack(), profile = await mkdtemp(resolve(tmpdir(), 'known-lifecycle-logout-'));
  let context: BrowserContext | undefined;
  try {
    context = await launch(profile, stack.browserHostResolverRules);
    const page = (await openExtensionOptions(context)).page;
    await installFixtureReplicaBinding(page, stack.extensionBinding);
    await signInExtension(page); await showOptionsPane(page, 'folders');
    await grantOptionalBookmarks(page, 'Allow bookmark access', 'Know-N logout lifecycle');
    const saved = await page.evaluate(async () => {
      const parentId = (await chrome.bookmarks.getTree())[0]!.children![0]!.id;
      // The real capture worker writes the device diary; this is a trusted options entry.
      return chrome.runtime.sendMessage({ kind: 'known.capture.start', trigger: 'manual-popup', title: 'Logout local fact',
        url: 'https://example.test/logout-local', parentNativeId: parentId, commandId: crypto.randomUUID(),
        saveAnother: false, allowUnverifiedCloud: false, userGesture: true });
    });
    expect(saved).toMatchObject({ ok: true });
    await expect.poll(() => page.evaluate(() => chrome.bookmarks.search({ url: 'https://example.test/logout-local' }).then(items => items.length))).toBe(1);
    await change(page, 'Pause sync');
    await context.setOffline(true);
    const logout = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.auth.logout', userGesture: true }));
    expect(logout, JSON.stringify(logout)).toMatchObject({ ok: true, state: { status: 'signed_out' } });
    await page.reload();
    expect(await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.capture.history', days: 7, timezone: 'UTC',
      status: 'all', q: '', source: '', collectionId: '' }))).toMatchObject({ ok: true,
      items: [expect.objectContaining({ title: 'Logout local fact', historyReadOnly: true, historyOrigin: 'device' })] });
    await context.setOffline(false);
    await showOptionsPane(page, 'account');
    await page.locator('#login-email').fill(EXTENSION_FIXTURE_EMAIL);
    await page.locator('#login-password').fill(EXTENSION_FIXTURE_PASSWORD);
    await page.locator('#login-submit').click();
    await expect(page.locator('body')).toHaveAttribute('data-state', 'connected');
    await showOptionsPane(page, 'sync-center');
    await expect(page.locator('#personal-sync-status')).toHaveText('Sync is paused');
    await change(page, 'Resume sync', 'Resume sync');
    await expect(page.locator('#personal-sync-status')).toHaveText(ENABLED);
    await change(page, 'Pause sync');
    await change(page, 'Disconnect sync', 'Disconnect sync');
    await expect(page.locator('#personal-sync-status')).toHaveText('Sync is disconnected');
    await change(page, 'Reconnect sync', 'Resume sync');
    await expect(page.locator('#personal-sync-status')).toHaveText(ENABLED);
  } finally { await context?.close(); await stack.close(); await rm(profile, { recursive: true, force: true }); }
});
async function evidence(page: Page, method: string, ...args: unknown[]) {
  const reply = await page.evaluate(({ method, args }) => chrome.runtime.sendMessage({ kind: 'known.sync-state.evidence', method, args }), { method, args }) as { ok: boolean; value: unknown };
  expect(reply.ok).toBe(true); return reply.value;
}
async function change(page: Page, label: string, confirm?: string) {
  // Personal sync controls live in Sync › Status.
  await showOptionsPane(page, 'sync-center');
  await page.getByRole('button', { name: label, exact: true }).click();
  if (confirm) await page.getByRole('dialog').getByRole('button', { name: confirm, exact: true }).click();
}
test('Pause survives browser restart, reconciles edits on both sides, and disconnect/reconnect keeps native data', async () => {
  test.setTimeout(180000);
  const stack = await startRealStack(), profile = await mkdtemp(resolve(tmpdir(), 'known-personal-lifecycle-'));
  let context: BrowserContext | undefined;
  try {
    const canonical = await stack.seedCanonicalFixture();
    context = await launch(profile, stack.browserHostResolverRules);
    let page = (await openExtensionOptions(context)).page;
    await installFixtureReplicaBinding(page, stack.extensionBinding);
    await signInExtension(page); await showOptionsPane(page, 'folders');
    await grantOptionalBookmarks(page, 'Allow bookmark access', 'Know-N personal lifecycle');
    const local = await page.evaluate(async () => {
      const bar = (await chrome.bookmarks.getTree())[0]!.children![0]!.id;
      const root = await chrome.bookmarks.create({ parentId: bar, title: 'Lifecycle selected' });
      const folder = await chrome.bookmarks.create({ parentId: root.id, title: 'Authority folder' });
      const bookmark = await chrome.bookmarks.create({ parentId: root.id, title: 'Authority bookmark', url: 'https://example.test/p3-31/authority' });
      return { root: root.id, folder: folder.id, bookmark: bookmark.id };
    });
    await evidence(page, 'drainBookmarkEventCaptureEvidence');
    await evidence(page, 'configureOutboundCanonicalFixture', local.root, null, local.folder, local.bookmark, canonical);
    await change(page, 'Pause sync');
    await expect(page.locator('#personal-sync-status')).toHaveText('Sync is paused');
    const lease = await page.evaluate(() => chrome.storage.local.get('known.auth.binding.v1'));
    const saved = await page.evaluate(parentId => chrome.bookmarks.create({ parentId, title: 'Saved while paused', url: 'https://example.test/lifecycle-paused' }), local.root);
    await stack.concurrentlyUpdateCanonicalBookmark(canonical);
    expect((await stack.observations()).canonicalNodes).not.toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Saved while paused' })]));
    await context.close(); context = await launch(profile, stack.browserHostResolverRules);
    page = (await openExtensionOptions(context)).page;
    await showOptionsPane(page, 'sync-center');
    await expect(page.locator('#personal-sync-status')).toHaveText('Sync is paused');
    expect(await page.evaluate(() => chrome.storage.local.get('known.auth.binding.v1'))).toEqual(lease);
    await change(page, 'Resume sync', 'Resume sync');
    await expect(page.locator('#personal-sync-status')).toHaveText(ENABLED);
    await expect.poll(async () => (await stack.observations()).canonicalNodes,
      { timeout: 45000 }).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Saved while paused' })]));
    await expect.poll(() => page.evaluate(id => chrome.bookmarks.get(id).then(nodes => nodes[0]!.title), local.bookmark),
      { timeout: 45000 }).toBe('Concurrent authority update');
    await change(page, 'Pause sync');
    await expect(page.locator('#personal-sync-status')).toHaveText('Sync is paused');
    await change(page, 'Disconnect sync', 'Disconnect sync');
    await expect(page.locator('#personal-sync-status')).toHaveText('Sync is disconnected');
    expect(await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.auth.status' }))).toMatchObject({ ok: true, state: { status: 'connected' } });
    expect(await page.evaluate(id => chrome.bookmarks.get(id), saved.id)).toHaveLength(1);
    await change(page, 'Reconnect sync', 'Resume sync');
    await expect(page.locator('#personal-sync-status')).toHaveText(ENABLED);
    await expect.poll(() => page.evaluate(() => chrome.storage.local.get('known.auth.binding.v1').then(items => (items['known.auth.binding.v1'] as { replicaId?: string })?.replicaId))).not.toBe(stack.extensionBinding.replicaId);
    expect(await page.evaluate(() => chrome.bookmarks.search({ url: 'https://example.test/lifecycle-paused' }))).toHaveLength(1);
  } finally { await context?.close(); await stack.close(); await rm(profile, { recursive: true, force: true }); }
});

test('metadata opt-out holds an immutable old retry until user-confirmed reset archives it', async () => {
  test.setTimeout(120000);
  const startedAt = Date.now(); let currentStage = 'start'; let completedStage = 'none';
  async function step<T>(name: string, action: () => Promise<T>): Promise<T> {
    currentStage = name;
    console.info('metadata-opt-out-stage', JSON.stringify({ phase: 'start', name, elapsedMs: Date.now() - startedAt }));
    return test.step(name, async () => {
      const value = await action(); completedStage = name;
      console.info('metadata-opt-out-stage', JSON.stringify({ phase: 'complete', name, elapsedMs: Date.now() - startedAt }));
      return value;
    });
  }
  const stack = await step('start real PostgreSQL and HTTP stack', () => startRealStack());
  const profile = await mkdtemp(resolve(tmpdir(), 'known-metadata-queue-'));
  let context: BrowserContext | undefined;
  let diagnosticPage: Page | undefined; let diagnosticScope: SyncScope | undefined;
  try {
    const canonical = await step('seed canonical bookmark through HTTP Push', () => stack.seedCanonicalFixture());
    context = await step('launch browser profile', () => launch(profile, stack.browserHostResolverRules));
    const page = (await step('open extension options', () => openExtensionOptions(context!))).page;
    diagnosticPage = page;
    await step('install fixture replica binding', () => installFixtureReplicaBinding(page, stack.extensionBinding));
    await step('sign in and bind account library', () => signInExtension(page));
    await step('open folders and grant optional bookmark permission', async () => {
      await showOptionsPane(page, 'folders');
      await grantOptionalBookmarks(page, 'Allow bookmark access', 'Know-N metadata queue');
    });
    const local = await step('create native bookmark fixture', () => page.evaluate(async () => {
      const bar = (await chrome.bookmarks.getTree())[0]!.children![0]!.id;
      const root = await chrome.bookmarks.create({ parentId: bar, title: 'Metadata selected' });
      const folder = await chrome.bookmarks.create({ parentId: root.id, title: 'Authority folder' });
      const bookmark = await chrome.bookmarks.create({ parentId: root.id, title: 'Authority bookmark', url: 'https://example.test/p3-31/authority' });
      return { root: root.id, folder: folder.id, bookmark: bookmark.id };
    }));
    await step('settle native event capture', () => evidence(page, 'drainBookmarkEventCaptureEvidence'));
    await step('bind native fixture to canonical revisions', () =>
      evidence(page, 'configureOutboundCanonicalFixture', local.root, null, local.folder, local.bookmark, canonical));
    const exported = await step('read bound durable scope', () => evidence(page, 'exportOutboundPushEvidence')) as
      { scope: SyncScope; queue: QueueOperation[] };
    const record = exported.scope;
    const scope: SyncScope = { environment: record.environment, serverId: record.serverId, serverOrigin: record.serverOrigin,
      accountId: record.accountId, browserProfileId: record.browserProfileId, collectionId: record.collectionId, replicaId: record.replicaId, generation: record.generation };
    diagnosticScope = scope;
    await step('verify library binding before metadata consent', () => waitForLibraryBinding(page, scope.collectionId));
    await step('choose metadata sync in the real options dialog', () => chooseLibraryMetadata(page, 'sync'));
    // Seed an old-build queue through the real IndexedDB repository. All sends,
    // refusals, reset confirmation and server observations use production paths.
    stack.setPushFault('service_unavailable_once');
    await step('persist legacy metadata and later title queue rows', () => page.evaluate(async ({ scope, canonical }) => {
      const { createSyncStateStore } = await import(chrome.runtime.getURL('sync-state-store.js'));
      const store = createSyncStateStore();
      try {
        for (const sequence of [1, 2]) {
          const opId = crypto.randomUUID(), payload = sequence === 1
            ? { base: { tags: [] }, value: { tags: ['private-metadata'] } }
            : { base: { title: canonical.bookmarkTitle }, value: { title: 'Later title' } };
          await store.allocateSequenceAndEnqueue(scope, { opId, batchId: opId, idempotencyKey: opId,
            digest: `sha256:${opId}`, endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: canonical.bookmarkRevision,
            operationRevision: `local-${opId}`, status: 'pending', retry: { attempt: 0, notBefore: 0 },
            payload: { opId, replicaId: scope.replicaId, sequence, collectionId: scope.collectionId,
              type: 'update_node_content', targetId: canonical.bookmarkId, baseRevision: canonical.bookmarkRevision,
              occurredAt: new Date().toISOString(), dependencies: [], payload } }, { allowUnstamped: true });
        }
      } finally { store.close(); }
    }, { scope, canonical }));
    await step('wake Push and observe the forced 503', () => evidence(page, 'wakeOutboundPushEvidence'));
    const before = await step('verify durable unknown attempt', async () => {
      const state = await evidence(page, 'exportOutboundPushEvidence') as { queue: QueueOperation[] };
      expect(state.queue[0]!.status).toBe('unknown'); expect(state.queue[0]!.attempt).toBeDefined(); return state;
    });
    await step('verify library binding before opt-out', () => waitForLibraryBinding(page, scope.collectionId));
    await step('choose keep metadata local in the real options dialog', () => chooseLibraryMetadata(page, 'local-only'));
    await step('wait for the persisted retry deadline', () =>
      expect.poll(() => Date.now() >= before.queue[0]!.retry.notBefore, { timeout: 20000 }).toBe(true));
    await step('retry the retained metadata operation', () => evidence(page, 'wakeOutboundPushEvidence'));
    await step('verify metadata refusal and immutable blocked bytes', async () => {
      const after = await evidence(page, 'exportOutboundPushEvidence') as { queue: QueueOperation[] };
      expect(after.queue[0]!.status).toBe('blocked'); expect(after.queue[0]!.attempt).toEqual(before.queue[0]!.attempt);
      expect(after.queue[1]!.status).toBe('pending');
      expect(await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.sync.attention.get' })))
        .toMatchObject({ ok: true, attention: { terminal: true, terminalCode: 'metadata_sync_disabled' } });
    });
    await step('render the blocked metadata explanation', async () => {
      await showOptionsPane(page, 'sync-center');
      await expect(page.locator('#sync-attention-settings-terminal-copy')).toContainText('not allowed to sync', { timeout: 12000 });
    });
    await step('open the reset confirmation dialog', () =>
      page.getByRole('button', { name: 'Reset sync on this device', exact: true }).click());
    await step('confirm reset and wait for the existing load boundary', () =>
      Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Reset sync', exact: true }).click()]));
    await step('verify the new replica binding after reset', async () => {
      await expect(page.locator('body')).toHaveAttribute('data-pane', 'sync');
      await expect.poll(() => page.evaluate(() => chrome.storage.local.get('known.auth.binding.v1').then(values =>
        (values['known.auth.binding.v1'] as { replicaId?: string })?.replicaId))).not.toBe(scope.replicaId);
    });
    const archived = await step('read the old scope archive', () => page.evaluate(async scope => {
      const { createSyncStateStore } = await import(chrome.runtime.getURL('sync-state-store.js'));
      const store = createSyncStateStore(); try { return await store.exportArchive(scope); } finally { store.close(); }
    }, scope)) as { queue: QueueOperation[] };
    await step('verify archived attempts and preserved Chrome bookmark', async () => {
      expect(archived.queue[0]!.attempt).toEqual(before.queue[0]!.attempt);
      expect(archived.queue[1]!.status).toBe('pending');
      expect(await page.evaluate(id => chrome.bookmarks.get(id), local.bookmark)).toHaveLength(1);
    });
  } catch (error) {
    console.info('metadata-opt-out-failed-stage', JSON.stringify({ currentStage, completedStage, elapsedMs: Date.now() - startedAt }));
    const diagnostics = await Promise.allSettled([
      diagnosticPage ? readMetadataRecoveryDiagnostics(diagnosticPage, diagnosticScope) : Promise.resolve({ page: 'not-open' }),
      stack.observations().then(observed => ({ serverMutationCount: observed.serverMutationCount,
        sessions: observed.sessions, replicaStatus: observed.replicaStatus,
        pushRequests: (observed.pushRequests as readonly PushRequestObservation[]).map(request => ({ fingerprint: request.fingerprint,
          responseStatus: request.responseStatus, responseCode: request.responseCode })),
        pushErrors: observed.pushErrors, sequenceReceipts: (observed.sequenceReceipts as readonly {
          op_id: string; sequence_number: string | number; result_digest: string;
        }[]).map(row => ({
          opId: row.op_id, sequence: row.sequence_number, resultDigest: row.result_digest,
        })) })),
    ]);
    console.info('metadata-opt-out-readonly-diagnostics', JSON.stringify(diagnostics.map(result => result.status === 'fulfilled'
      ? { status: 'fulfilled', value: result.value } : { status: 'rejected', error: String(result.reason) })));
    throw error;
  } finally { await context?.close(); await stack.close(); await rm(profile, { recursive: true, force: true }); }
});

/** Failure evidence reads durable state directly, without waking the worker or retrying a command. */
async function readMetadataRecoveryDiagnostics(page: Page, scope?: SyncScope) {
  return page.evaluate(async scope => {
    const metadataKey = scope ? 'known.metadata-sync-policy.v1:'
      + JSON.stringify([scope.serverOrigin, scope.accountId, scope.collectionId]) : undefined;
    const stored = await chrome.storage.local.get(['known.sync.collection.v1', 'known.sync.library.v1',
      'known.auth.binding.v1', ...(metadataKey ? [metadataKey] : [])]);
    const binding = stored['known.auth.binding.v1'] as { replicaId?: string; generation?: number } | undefined;
    const library = stored['known.sync.library.v1'] as { status?: string; library?: { id?: string } } | undefined;
    const ui = { url: location.href, readyState: document.readyState, pane: document.body.dataset.pane,
      personalSyncStatus: document.querySelector('#personal-sync-status')?.textContent,
      metadata: document.querySelector('#library-metadata-configure')?.closest('.set-row')?.textContent,
      terminal: document.querySelector('#sync-attention-settings-terminal-copy')?.textContent,
      dialogs: Array.from(document.querySelectorAll('dialog, [role="dialog"]')).map(dialog => dialog.textContent?.slice(0, 2000)) };
    const result: Record<string, unknown> = { ui, collectionId: stored['known.sync.collection.v1'],
      library: { status: library?.status, id: library?.library?.id },
      replica: { replicaId: binding?.replicaId, generation: binding?.generation },
      metadataPolicy: metadataKey ? stored[metadataKey] : undefined };
    if (!scope) return result;
    const { createSyncStateStore } = await import(chrome.runtime.getURL('sync-state-store.js'));
    const store = createSyncStateStore();
    const summarize = (state: Record<string, unknown>) => ({ scope: state.scope, engine: state.engine,
      queue: (state.queue as QueueOperation[] | undefined)?.map(row => ({ opId: row.opId, sequence: row.sequence,
        status: row.status, digest: row.digest, retry: row.retry, recovery: row.recovery,
        operationType: row.payload.type, payloadKeys: Object.keys(row.payload), attemptDigest: row.attempt?.bodyDigest })),
      receiptCount: Array.isArray(state.receipts) ? state.receipts.length : null });
    try {
      const states = await Promise.allSettled([store.exportScope(scope), store.exportArchive(scope)]);
      result.durable = states.map((state, index) => ({ kind: index === 0 ? 'active' : 'archive',
        ...(state.status === 'fulfilled' ? { state: summarize(state.value) } : { error: String(state.reason) }) }));
    } finally { store.close(); }
    return result;
  }, scope);
}
