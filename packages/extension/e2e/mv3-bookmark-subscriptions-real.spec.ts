import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startRealStack } from './real-stack.js';
import { openExtensionOptions, showOptionsPane, EXTENSION_FIXTURE_EMAIL, EXTENSION_FIXTURE_PASSWORD } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { grantBookmarks, launchPersistent, login, profileDir } from './kns-08-harness.js';
import type { SubscriptionCommand, SubscriptionResponse } from '../src/bookmark-subscriptions/commands.js';
import type { LocalMapping } from '../src/bookmark-subscriptions/local-types.js';
import type { Mapping, ExitPreview, ExitBatch } from '../src/bookmark-subscriptions/contracts.js';

test('BS real profiles keep an offline exit pending, preserve native identity and acknowledge once', async ({}, testInfo) => {
  test.setTimeout(240_000);
  const stack = await startRealStack({ subscriptions: true });
  const fixture = stack.subscriptionProduct!;
  const profiles = [profileDir('a'), profileDir('b')];
  let a: BrowserContext | undefined, b: BrowserContext | undefined;
  try {
    a = await launchPersistent(profiles[0]!, stack.browserHostResolverRules);
    b = await launchPersistent(profiles[1]!, stack.browserHostResolverRules);
    const pageA = (await openExtensionOptions(a)).page;
    const pageB = (await openExtensionOptions(b)).page;
    await login(pageA, stack.extensionBindings[0]);
    await login(pageB, stack.extensionBindings[1]);
    await grantBookmarks(pageA);
    await grantBookmarks(pageB);
    const mountedA = await mount(pageA, fixture.collectionId);
    const mountedB = await mount(pageB, fixture.collectionId);
    expect(mountedA.mapping.subscriptionId).toBe(mountedB.mapping.subscriptionId);
    expect(mountedA.mapping.mappingId).not.toBe(mountedB.mapping.mappingId);
    const original = await nativeSource(pageA, mountedA.local.rootNativeId!, fixture.sourceUrl);
    expect(original.title).toBe('Source article');
    await send(pageA, { kind: 'pause', mappingId: mountedA.mapping.mappingId, expectedGeneration: mountedA.mapping.generation });
    await fixture.renameBookmark('Updated source article');
    await send(pageA, { kind: 'refresh', mappingId: mountedA.mapping.mappingId, expectedGeneration: mountedA.mapping.generation });
    expect((await nativeSource(pageA, mountedA.local.rootNativeId!, fixture.sourceUrl)).title).toBe('Source article');
    await send(pageA, { kind: 'resume', mappingId: mountedA.mapping.mappingId, expectedGeneration: mountedA.mapping.generation });
    await expect.poll(async () => (await nativeSource(pageA, mountedA.local.rootNativeId!, fixture.sourceUrl)).title).toBe('Updated source article');
    expect((await nativeSource(pageA, mountedA.local.rootNativeId!, fixture.sourceUrl)).id).toBe(original.id);
    const change = await fixture.rearrangeSource();
    await send(pageA, { kind: 'refresh', mappingId: mountedA.mapping.mappingId, expectedGeneration: mountedA.mapping.generation });
    const group = (await pageA.evaluate(async root => chrome.bookmarks.getChildren(root), mountedA.local.rootNativeId!)).find(n => n.title === 'New source group')!;
    expect((await nativeSource(pageA, group.id, fixture.sourceUrl)).id).toBe(original.id);
    const added = await nativeSource(pageA, mountedA.local.rootNativeId!, change.url);
    expect((await pageA.evaluate(async root => chrome.bookmarks.getChildren(root), mountedA.local.rootNativeId!)).map(n => n.title)).toEqual(['Open collection', 'Added source article', 'New source group']);
    await fixture.finishSourceRearrangement(change.folder, change.added);
    await send(pageA, { kind: 'refresh', mappingId: mountedA.mapping.mappingId, expectedGeneration: mountedA.mapping.generation });
    expect((await nativeSource(pageA, mountedA.local.rootNativeId!, fixture.sourceUrl)).id).toBe(original.id);
    expect(await pageA.evaluate(async ids => Promise.all(ids.map(async id => { try { return (await chrome.bookmarks.get(id)).length; } catch { return 0; } })), [group.id, added.id])).toEqual([0, 0]);
    const relocate = await send<{ token: string }>(pageA, { kind: 'relocatePreview', mappingId: mountedA.mapping.mappingId, expectedGeneration: mountedA.mapping.generation, parentNativeId: '2' });
    await send(pageA, { kind: 'relocateConfirm', token: relocate.token });
    expect(await pageA.evaluate(async id => (await chrome.bookmarks.get(id))[0]?.parentId, mountedA.local.rootNativeId!)).toBe('2');
    await b.setOffline(true);
    const preview = await send<ExitPreview>(pageA, { kind: 'exitPreview', mappingId: mountedA.mapping.mappingId, expectedGeneration: mountedA.mapping.generation, scope: 'subscription' });
    const batch = await send<ExitBatch>(pageA, { kind: 'exitConfirm', previewId: preview.previewId });
    expect(batch).toBeTruthy();
    await expect.poll(async () => (await fixture.lifecycle()).subscriptions[0]?.status).toBe('terminated');
    await expect.poll(async () => (await fixture.lifecycle()).mappings.find(m => m.id === mountedA.mapping.mappingId)?.status).toBe('detached');
    expect((await fixture.lifecycle()).mappings.find(m => m.id === mountedB.mapping.mappingId)?.status).toBe('terminating');
    expect((await nativeSource(pageA, mountedA.local.rootNativeId!, fixture.sourceUrl)).id).toBe(original.id);
    await b.setOffline(false);
    await pageB.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.connectivity.online' }));
    await expect.poll(async () => (await fixture.lifecycle()).mappings.every(m => m.status === 'detached'), { timeout: 30_000 }).toBe(true);
    // Permission revocation after a committed keep must not re-clean the ordinary local copy.
    await fixture.revokeSource();
    const cdp = await a.newCDPSession(pageA);
    const targets = await cdp.send('Target.getTargets');
    const worker = targets.targetInfos.find(target => target.type === 'service_worker' && target.url.includes('pplpnpegpnghcddhmpgkbfkdfadjiaen'));
    expect(worker).toBeTruthy();
    await cdp.send('Target.closeTarget', { targetId: worker!.targetId });
    await cdp.detach();
    await send(pageA, { kind: 'list' });
    await pageA.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.connectivity.online' }));
    expect((await nativeSource(pageA, mountedA.local.rootNativeId!, fixture.sourceUrl)).id).toBe(original.id);
    const lifecycle = await fixture.lifecycle();
    expect(lifecycle.actions).toHaveLength(2);
    expect(lifecycle.actions.every(action => action.receipt?.result === 'kept')).toBe(true);
    await testInfo.attach('subscription-lifecycle', { contentType: 'application/json', body: JSON.stringify({
      mappingCount: lifecycle.mappings.length, actionCount: lifecycle.actions.length,
      receipts: lifecycle.actions.map(action => ({ result: action.receipt?.result, status: 'detached' })),
      stableNativeIdentity: true,
    }) });
  } finally {
    await a?.close().catch(() => undefined);
    await b?.close().catch(() => undefined);
    await stack.close();
    await Promise.all(profiles.map(path => rm(path, { recursive: true, force: true })));
  }
});

test('BS paused mapping still clears explicitly revoked source while content gate is disabled', async () => {
  test.setTimeout(180_000);
  const stack = await startRealStack({ subscriptions: true });
  const fixture = stack.subscriptionProduct!;
  const profile = profileDir('a');
  let context: BrowserContext | undefined;
  try {
    context = await launchPersistent(profile, stack.browserHostResolverRules);
    const page = (await openExtensionOptions(context)).page;
    await login(page, stack.extensionBindings[0]);
    await grantBookmarks(page);
    const mounted = await mount(page, fixture.collectionId);
    await send(page, { kind: 'pause', mappingId: mounted.mapping.mappingId, expectedGeneration: mounted.mapping.generation });
    fixture.setContentEnabled(false);
    await fixture.revokeSource();
    await send(page, { kind: 'refresh', mappingId: mounted.mapping.mappingId, expectedGeneration: mounted.mapping.generation });
    await expect.poll(async () => page.evaluate(async id => {
      try { return (await chrome.bookmarks.get(id)).length; } catch { return 0; }
    }, mounted.local.rootNativeId!)).toBe(0);
    const detail = await send<{ local: LocalMapping }>(page, { kind: 'mapping', mappingId: mounted.mapping.mappingId });
    expect(detail.local.state).toBe('access_lost');
  } finally {
    await context?.close().catch(() => undefined);
    await stack.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('BS four-step wizard works before personal sync confirmation and preserves accidental native additions', async () => {
  test.setTimeout(180_000);
  const stack = await startRealStack({ subscriptions: true });
  const fixture = stack.subscriptionProduct!;
  const profile = profileDir('a');
  let context: BrowserContext | undefined;
  try {
    context = await launchPersistent(profile, stack.browserHostResolverRules);
    const page = (await openExtensionOptions(context)).page;
    await page.locator('#login-email').fill(EXTENSION_FIXTURE_EMAIL);
    await page.locator('#login-password').fill(EXTENSION_FIXTURE_PASSWORD);
    await page.locator('#login-submit').click();
    await expect(page.locator('body')).toHaveAttribute('data-state', 'connected', { timeout: 20_000 });
    await expect.poll(() => page.evaluate(async () => (await chrome.storage.local.get('known.sync.collection.v1'))['known.sync.collection.v1'])).toBe(stack.collectionId);
    expect(await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.firstRun.status' }))).toMatchObject({ ok: true, firstRun: 'none' });
    await page.locator('#nav-subscriptions').click();
    await page.getByRole('button', { name: 'Add subscription', exact: true }).click();
    await page.locator('.subscription-source-row').filter({ hasText: 'Shared subscription source' }).getByRole('button', { name: 'Choose', exact: true }).click();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await grantOptionalBookmarks(page, 'Allow bookmark access', 'Subscription wizard permission');
    const before = await page.evaluate(() => chrome.bookmarks.getChildren('1'));
    const parentTitle = await page.evaluate(async () => (await chrome.bookmarks.get('1'))[0]!.title);
    await page.getByRole('button', { name: parentTitle, exact: true }).click();
    await page.getByLabel('Folder name', { exact: true }).fill('Wizard subscription');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByText('private content can appear in your other profiles', { exact: false })).toBeVisible();
    expect(await page.evaluate(() => chrome.bookmarks.getChildren('1'))).toEqual(before);
    await page.getByRole('button', { name: 'Add folder', exact: true }).click();
    await expect.poll(async () => (await fixture.lifecycle()).mappings.length).toBe(1);
    const mapping = (await fixture.lifecycle()).mappings[0]!.document;
    await expect.poll(async () => (await send<{ local: LocalMapping }>(page, { kind: 'mapping', mappingId: mapping.mappingId })).local.state).toBe('current');
    const detail = await send<{ local: LocalMapping }>(page, { kind: 'mapping', mappingId: mapping.mappingId });
    const root = detail.local.rootNativeId!;
    expect((await page.evaluate(id => chrome.bookmarks.get(id), root))[0]!.title).toBe('Wizard subscription');
    const personal = await page.evaluate(id => chrome.bookmarks.create({ parentId: id, title: 'Accidental personal bookmark', url: 'https://personal-fixture.example/keep-me' }), root);
    await expect.poll(async () => (await page.evaluate(id => chrome.bookmarks.get(id), personal.id))[0]?.parentId).not.toBe(root);
    expect((await page.evaluate(id => chrome.bookmarks.get(id), personal.id))[0]).toMatchObject({ title: personal.title, url: personal.url });
    const diagnostics = await send<Array<{ reasonCode: string; resolution: string }>>(page, { kind: 'diagnostics', mappingId: mapping.mappingId });
    expect(diagnostics.some(d => d.reasonCode === 'readonly_native_created' && d.resolution === 'preserved')).toBe(true);
    await expect.poll(() => page.evaluate(async () => (await chrome.storage.local.get('known.sync.collection.v1'))['known.sync.collection.v1'])).toBe(stack.collectionId);
    expect(await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.firstRun.status' }))).toMatchObject({ ok: true, firstRun: 'none' });
  } finally {
    await context?.close().catch(() => undefined);
    await stack.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('BS COLP refuses unsupported Digest mounts without creating native or remote mappings', async () => {
  const stack = await startRealStack({ subscriptions: true });
  const fixture = stack.subscriptionProduct!; const profile = profileDir('a');
  let context: BrowserContext | undefined;
  try {
    context = await launchPersistent(profile, stack.browserHostResolverRules);
    const page = (await openExtensionOptions(context)).page;
    await login(page, stack.extensionBindings[0]); await grantBookmarks(page);
    const before = await page.evaluate(() => chrome.bookmarks.getTree());
    const response = await page.evaluate(command => chrome.runtime.sendMessage({
      type: 'BOOKMARK_SUBSCRIPTIONS', requestId: crypto.randomUUID(), command,
    }), { kind: 'mountPreview', sourceType: 'digest_series', sourceId: 'unsupported-digest-series',
      digestMode: 'recent', editionLimit: 20, checkIntervalMinutes: 15,
      exitPolicy: { onUnfollow: 'keep', onUnsubscribe: 'keep' }, parentNativeId: '1',
      localAlias: 'Unsupported Digest', profileLabel: 'Acceptance browser' });
    expect(response).toEqual({ ok: false, error: 'feature_temporarily_unavailable' });
    expect(await page.evaluate(() => chrome.bookmarks.getTree())).toEqual(before);
    expect((await fixture.lifecycle()).mappings).toEqual([]);
  } finally {
    await context?.close(); await stack.close(); await rm(profile, { recursive: true, force: true });
  }
});

test('BS local edited copy is committed before a remove-policy detach', async () => {
  test.setTimeout(180_000);
  const stack = await startRealStack({ subscriptions: true });
  const fixture = stack.subscriptionProduct!;
  const profile = profileDir('a');
  let context: BrowserContext | undefined;
  try {
    context = await launchPersistent(profile, stack.browserHostResolverRules);
    const page = (await openExtensionOptions(context)).page;
    await login(page, stack.extensionBindings[0]);
    await grantBookmarks(page);
    const mounted = await mount(page, fixture.collectionId);
    const source = await nativeSource(page, mounted.local.rootNativeId!, fixture.sourceUrl);
    await page.evaluate(id => chrome.bookmarks.update(id, { title: 'My edited title' }), source.id);
    await expect.poll(async () => (await send<{ local: LocalMapping }>(page, { kind: 'mapping', mappingId: mounted.mapping.mappingId })).local.state).toBe('local_change');
    const detail = await send<{ etag: string }>(page, { kind: 'mapping', mappingId: mounted.mapping.mappingId });
    await send(page, { kind: 'patch', mappingId: mounted.mapping.mappingId, expectedGeneration: mounted.mapping.generation, ifMatch: detail.etag, patch: { exitPolicy: { onUnfollow: 'remove', onUnsubscribe: 'remove' } } });
    const preview = await send<{ token: string; exitPreview: ExitPreview; copyCount: number }>(page, { kind: 'recoveryPreview', mappingId: mounted.mapping.mappingId, expectedGeneration: mounted.mapping.generation, action: 'copy_detach' });
    expect(preview.exitPreview.targets.every(target => target.effectiveAction === 'remove')).toBe(true);
    expect(preview.copyCount).toBeGreaterThan(0);
    const result = await send<{ copy: { rootNativeId: string; count: number } }>(page, { kind: 'recoveryConfirm', token: preview.token });
    expect(result.copy.count).toBeGreaterThan(0);
    await expect.poll(async () => (await fixture.lifecycle()).mappings[0]?.status, { timeout: 20_000 }).toBe('detached');
    expect((await nativeSource(page, result.copy.rootNativeId, fixture.sourceUrl)).title).toBe('My edited title');
    const same = await send<{ copy: { rootNativeId: string } }>(page, { kind: 'recoveryConfirm', token: preview.token });
    expect(same.copy.rootNativeId).toBe(result.copy.rootNativeId);
    expect((await fixture.lifecycle()).actions).toHaveLength(1);
  } finally {
    await context?.close().catch(() => undefined);
    await stack.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('BS worker termination after native create preserves quarantine and never creates another root', async () => {
  test.setTimeout(180_000);
  const stack = await startRealStack({ subscriptions: true });
  const fixture = stack.subscriptionProduct!;
  const profile = profileDir('a');
  let context: BrowserContext | undefined;
  try {
    context = await launchPersistent(profile, stack.browserHostResolverRules);
    const page = (await openExtensionOptions(context)).page;
    await login(page, stack.extensionBindings[0]);
    await grantBookmarks(page);
    const alias = 'Interrupted subscription creation';
    const preview = await send<{ token: string }>(page, { kind: 'mountPreview', sourceType: 'collection', sourceId: fixture.collectionId, digestMode: null, editionLimit: null, checkIntervalMinutes: 15, exitPolicy: { onUnfollow: 'keep', onUnsubscribe: 'keep' }, parentNativeId: '1', localAlias: alias, profileLabel: 'Crash acceptance browser' });
    const worker = context.serviceWorkers().find(w => w.url().includes('pplpnpegpnghcddhmpgkbfkdfadjiaen'))!;
    expect(worker).toBeTruthy();
    // Fault injection only delays the real API response. The production journal
    // is persisted before this call, and the actual native node is created.
    await worker.evaluate(alias => {
      const create = chrome.bookmarks.create.bind(chrome.bookmarks);
      chrome.bookmarks.create = (async (details: Parameters<typeof chrome.bookmarks.create>[0]) => {
        const value = await create(details);
        if (details.title === alias) await new Promise<void>(() => undefined);
        return value;
      }) as typeof chrome.bookmarks.create;
    }, alias);
    const pending = page.evaluate(async token => {
      try { return await chrome.runtime.sendMessage({ type: 'BOOKMARK_SUBSCRIPTIONS', requestId: crypto.randomUUID(), command: { kind: 'mountConfirm', token } }); } catch { return null; }
    }, preview.token);
    await expect.poll(async () => page.evaluate(async alias => (await chrome.bookmarks.getChildren('1')).filter(n => n.title === alias).length, alias)).toBe(1);
    const journal = await readSubscriptionDb(page, 'operations');
    expect(journal.some(op => op.kind === 'create' && op.phase === 'issued' && op.node?.title === alias)).toBe(true);
    const root = (await page.evaluate(() => chrome.bookmarks.getChildren('1'))).find(n => n.title === alias)!;
    const cdp = await context.newCDPSession(page);
    const targets = await cdp.send('Target.getTargets');
    const target = targets.targetInfos.find(t => t.type === 'service_worker' && t.url === worker.url())!;
    await cdp.send('Target.closeTarget', { targetId: target.targetId });
    await cdp.detach();
    await pending;
    const lifecycle = await fixture.lifecycle();
    expect(lifecycle.mappings).toHaveLength(1);
    const mapping = lifecycle.mappings[0]!;
    const retry = await page.evaluate(async token => chrome.runtime.sendMessage({ type: 'BOOKMARK_SUBSCRIPTIONS', requestId: crypto.randomUUID(), command: { kind: 'mountConfirm', token } }), preview.token) as SubscriptionResponse<{ local: LocalMapping }>;
    // A still-quarantined parent can reject at the target guard before recovery.
    // Both boundaries must refuse another native create, never report success.
    if (retry.ok) expect(retry.data.local.error).toBe('recovery_identity_uncertain');
    else expect(['readonly_write_blocked', 'recovery_identity_uncertain']).toContain(retry.error);
    await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.connectivity.online' }));
    await expect.poll(async () => (await send<{ local: LocalMapping }>(page, { kind: 'mapping', mappingId: mapping.id })).local.error).toBe('recovery_identity_uncertain');
    expect((await page.evaluate(async alias => (await chrome.bookmarks.getChildren('1')).filter(n => n.title === alias), alias)).map(n => n.id)).toEqual([root.id]);
    const exclusions = await readSubscriptionDb(page, 'exclusions');
    expect(exclusions.some(e => e.nativeId === root.id && e.reason === 'quarantine')).toBe(true);
    const exit = await send<ExitPreview>(page, { kind: 'exitPreview', mappingId: mapping.id, expectedGeneration: mapping.document.generation, scope: 'mapping' });
    await send(page, { kind: 'exitConfirm', previewId: exit.previewId });
    await send(page, { kind: 'list' });
    expect((await fixture.lifecycle()).mappings[0]?.status).toBe('terminating');
    expect((await readSubscriptionDb(page, 'acks')).some(a => a.mappingId === mapping.id)).toBe(false);
    expect(await page.evaluate(async id => (await chrome.bookmarks.get(id))[0]?.id, root.id)).toBe(root.id);
  } finally {
    await context?.close().catch(() => undefined);
    await stack.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('BS logout preserves cleanup evidence and relogin requires explicit restoration of the same mapping', async () => {
  test.setTimeout(180_000);
  const stack = await startRealStack({ subscriptions: true });
  const fixture = stack.subscriptionProduct!;
  const profile = profileDir('a');
  let context: BrowserContext | undefined;
  try {
    context = await launchPersistent(profile, stack.browserHostResolverRules);
    const page = (await openExtensionOptions(context)).page;
    const accountLogin = async () => {
      await showOptionsPane(page, 'account');
      await page.locator('#login-email').fill(EXTENSION_FIXTURE_EMAIL);
      await page.locator('#login-password').fill(EXTENSION_FIXTURE_PASSWORD);
      await page.locator('#login-submit').click();
      await expect(page.locator('body')).toHaveAttribute('data-state', 'connected', { timeout: 20_000 });
      await expect.poll(() => page.evaluate(async () => (await chrome.storage.local.get('known.sync.collection.v1'))['known.sync.collection.v1'])).toBe(stack.collectionId);
    expect(await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.firstRun.status' }))).toMatchObject({ ok: true, firstRun: 'none' });
    };
    await accountLogin();
    await page.evaluate(() => {
      const button = document.createElement('button');
      button.id = 'fixture-subscription-permission';
      button.textContent = 'Grant fixture bookmark permission';
      button.addEventListener('click', () => { void chrome.permissions.request({ permissions: ['bookmarks'] }); });
      document.body.append(button);
    });
    await grantOptionalBookmarks(page, 'Grant fixture bookmark permission', 'Standalone subscription permission');
    await page.locator('#fixture-subscription-permission').evaluate(element => element.remove());
    const mounted = await mount(page, fixture.collectionId);
    const logout = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.auth.logout', userGesture: true })) as { ok: boolean };
    expect(logout.ok).toBe(true);
    expect(await page.evaluate(async id => { try { return (await chrome.bookmarks.get(id)).length; } catch { return 0; } }, mounted.local.rootNativeId!)).toBe(0);
    const persisted = (await readSubscriptionDb(page, 'mappings')).find(m => m.id === mounted.mapping.mappingId)!;
    expect(persisted.enabled).toBe(false);
    expect(persisted.cleanup).toBe(false);
    expect(persisted.error).toBe('local_enable_required');
    expect((await fixture.lifecycle()).mappings[0]?.status).toBe('active');
    await send(page, { kind: 'directoryDefaults' });
    // This test invokes the worker directly; reload the shell to observe logout.
    await page.reload();
    await expect(page.locator('body')).not.toHaveAttribute('data-state', 'connected');
    await accountLogin();
    await send(page, { kind: 'list' });
    const before = await send<{ local: LocalMapping }>(page, { kind: 'mapping', mappingId: mounted.mapping.mappingId });
    expect(before.local.enabled).toBe(false);
    expect(before.local.rootNativeId).toBeUndefined();
    expect((await fixture.lifecycle()).mappings).toHaveLength(1);
    const preview = await send<{ token: string; targetRequired: boolean }>(page, { kind: 'recoveryPreview', mappingId: mounted.mapping.mappingId, expectedGeneration: mounted.mapping.generation, action: 'restore', parentNativeId: '2' });
    expect(preview.targetRequired).toBe(true);
    const restored = await send<{ local: LocalMapping }>(page, { kind: 'recoveryConfirm', token: preview.token });
    expect(restored.local.state).toBe('current');
    expect(restored.local.mapping.mappingId).toBe(mounted.mapping.mappingId);
    expect(restored.local.mapping.generation).toBe(mounted.mapping.generation);
    expect(await page.evaluate(async id => (await chrome.bookmarks.get(id))[0]?.parentId, restored.local.rootNativeId!)).toBe('2');
    expect((await fixture.lifecycle()).mappings).toHaveLength(1);
  } finally {
    await context?.close().catch(() => undefined);
    await stack.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('BS measured profile capacity uses real native nodes and independent mappings', async ({}, testInfo) => {
  test.skip(!process.env.BS_CAPACITY_NODES, 'Explicit capacity run; excludes expensive unrelated reruns.');
  test.setTimeout(2_700_000);
  const budget = Number(process.env.BS_CAPACITY_NODES);
  const mappingCount = Number(process.env.BS_CAPACITY_MAPPINGS ?? 1);
  expect(budget).toBeGreaterThanOrEqual(mappingCount * 3);
  expect(budget).toBeLessThanOrEqual(20000);
  expect(mappingCount).toBeLessThanOrEqual(50);
  const stack = await startRealStack({ subscriptions: true });
  const fixture = stack.subscriptionProduct!;
  const profile = profileDir('a');
  let context: BrowserContext | undefined;
  let capacityMonitor: ReturnType<typeof setInterval> | undefined;
  const peak = { fixtureRssBytes: 0, fixtureHeapUsedBytes: 0, browserProcessTreeRssBytes: 0 };
  let sampling = false;
  const sampleMemory = async () => {
    if (sampling) return;
    sampling = true;
    try {
      const memory = process.memoryUsage();
      peak.fixtureRssBytes = Math.max(peak.fixtureRssBytes, memory.rss);
      peak.fixtureHeapUsedBytes = Math.max(peak.fixtureHeapUsedBytes, memory.heapUsed);
      const { stdout } = await promisify(execFile)('ps', ['-eo', 'pid=,ppid=,rss=,args=']);
      const processes = stdout.split('\n').flatMap(line => { const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/); return match ? [{ pid: Number(match[1]), parent: Number(match[2]), rss: Number(match[3]) * 1024, args: match[4]! }] : []; });
      const roots = processes.filter(p => p.args.includes('--user-data-dir=' + profile) && !p.args.includes('--type='));
      const ids = new Set(roots.map(p => p.pid));
      for (let changed = true; changed;) { changed = false; for (const p of processes) if (ids.has(p.parent) && !ids.has(p.pid)) { ids.add(p.pid); changed = true; } }
      peak.browserProcessTreeRssBytes = Math.max(peak.browserProcessTreeRssBytes, processes.filter(p => ids.has(p.pid)).reduce((sum, p) => sum + p.rss, 0));
    } finally { sampling = false; }
  };
  try {
    await fixture.expandProjectedNodes(budget - (mappingCount - 1) * 3);
    const smallSources = await fixture.seedSmallCollections(mappingCount - 1);
    context = await launchPersistent(profile, stack.browserHostResolverRules);
    await sampleMemory();
    capacityMonitor = setInterval(() => { void sampleMemory().catch(() => undefined); }, 2000);
    const page = (await openExtensionOptions(context)).page;
    await login(page, stack.extensionBindings[0]);
    await grantBookmarks(page);
    const start = Date.now();
    const small: { mapping: Mapping; local: LocalMapping }[] = [];
    for (const source of smallSources) {
      small.push(await mount(page, source));
      await fixture.expireCompletedFixtureSnapshots();
    }
    const smallMountMs = Date.now() - start;
    const largeStart = Date.now();
    const largePending = mount(page, fixture.collectionId);
    void largePending.catch(() => undefined);
    let independentRefreshMs: number | null = null;
    if (small.length) {
      // Full preview validates all bounded pages before creating the remote mapping.
      await Promise.race([
        expect.poll(async () => (await fixture.lifecycle()).mappings.length, { timeout: 180_000 }).toBe(mappingCount),
        largePending.then(() => { throw new Error('large_mount_finished_before_independent_probe'); }),
      ]);
      const independentStart = Date.now();
      const independent = small.at(-1)!;
      const refreshed = await send<LocalMapping>(page, { kind: 'refresh', mappingId: independent.mapping.mappingId, expectedGeneration: independent.mapping.generation });
      expect(refreshed.state).toBe('current');
      independentRefreshMs = Date.now() - independentStart;
    }
    const large = await largePending;
    const largeMountMs = Date.now() - largeStart;
    const owned = await readSubscriptionDb(page, 'nodes');
    expect(owned).toHaveLength(budget);
    expect(new Set(owned.map(n => n.nativeId)).size).toBe(budget);
    const physical = await page.evaluate(async () => {
      let count = 0;
      const stack = await chrome.bookmarks.getChildren('1');
      while (stack.length) { const node = stack.pop()!; count++; if (!node.url) stack.push(...await chrome.bookmarks.getChildren(node.id)); }
      return count;
    });
    expect(physical).toBe(budget);
    expect((await fixture.lifecycle()).mappings).toHaveLength(mappingCount);
    const refreshStart = Date.now();
    const result = await send<LocalMapping>(page, { kind: 'refresh', mappingId: large.mapping.mappingId, expectedGeneration: large.mapping.generation });
    expect(result.state).toBe('current');
    const recheckMs = Date.now() - refreshStart;
    expect((await readSubscriptionDb(page, 'nodes')).map(n => n.nativeId).sort()).toEqual(owned.map(n => n.nativeId).sort());
    const cdp = await context.newCDPSession(page);
    const targets = await cdp.send('Target.getTargets');
    const worker = targets.targetInfos.find(target => target.type === 'service_worker' && target.url.includes('pplpnpegpnghcddhmpgkbfkdfadjiaen'));
    expect(worker).toBeTruthy();
    await cdp.send('Target.closeTarget', { targetId: worker!.targetId });
    await cdp.detach();
    const restartStart = Date.now();
    const restarted = await send<LocalMapping>(page, { kind: 'refresh', mappingId: large.mapping.mappingId, expectedGeneration: large.mapping.generation });
    expect(restarted.state).toBe('current');
    const restartRecheckMs = Date.now() - restartStart;
    expect((await readSubscriptionDb(page, 'nodes')).map(n => n.nativeId).sort()).toEqual(owned.map(n => n.nativeId).sort());
    const memory = await page.evaluate(() => { const m = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory; return m ? { usedJSHeapSize: m.usedJSHeapSize, totalJSHeapSize: m.totalJSHeapSize } : null; });
    const operations = await readSubscriptionDb(page, 'operations');
    const retainedJournalOperations = Object.fromEntries(['create', 'update', 'move', 'remove'].map(kind => [kind, operations.filter(op => op.kind === kind).length]));
    await sampleMemory();
    const measurement = { browser: process.env.KNS_08_BROWSER ?? 'chromium', mappingCount, managedNodes: budget, smallMountMs, largeMountMs, independentRefreshMs, recheckMs, restartRecheckMs, optionsHeap: memory, sampledPeak: peak, retainedJournalOperations, stableNativeIdentity: true, setup: 'Completed fixture caches expired between preparatory mounts; steady-state profile capacity. Process RSS is sampled every two seconds and includes test/browser overhead, not isolated pagination heap.' };
    console.log('BOOKMARK_SUBSCRIPTION_CAPACITY ' + JSON.stringify(measurement));
    await testInfo.attach('subscription-capacity', { contentType: 'application/json', body: JSON.stringify(measurement) });
  } finally {
    if (capacityMonitor) clearInterval(capacityMonitor);
    await context?.close().catch(() => undefined);
    await stack.close();
    await rm(profile, { recursive: true, force: true });
  }
});

async function readSubscriptionDb(page: Page, table: string): Promise<any[]> {
  return page.evaluate(table => new Promise<any[]>((resolve, reject) => {
    const request = indexedDB.open('known-bookmark-subscriptions-v1');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const rows = db.transaction(table).objectStore(table).getAll();
      rows.onerror = () => { db.close(); reject(rows.error); };
      rows.onsuccess = () => { db.close(); resolve(rows.result); };
    };
  }), table);
}

async function send<T = unknown>(page: Page, command: SubscriptionCommand): Promise<T> {
  const response = await page.evaluate(async command => chrome.runtime.sendMessage({
    type: 'BOOKMARK_SUBSCRIPTIONS', requestId: crypto.randomUUID(), command,
  }), command) as SubscriptionResponse<T>;
  expect(response.ok, JSON.stringify(response)).toBe(true);
  if (!response.ok) throw new Error(response.error);
  return response.data;
}
async function mount(page: Page, collectionId: string, digestMode: 'latest'|'recent'|null = null, editionLimit: number|null = null) {
  const before = await page.evaluate(() => chrome.bookmarks.getChildren('1'));
  const preview = await send<{ token: string }>(page, {
    kind: 'mountPreview', sourceType: digestMode ? 'digest_series' : 'collection', sourceId: collectionId,
    digestMode, editionLimit, checkIntervalMinutes: 15,
    exitPolicy: { onUnfollow: 'keep', onUnsubscribe: 'keep' },
    parentNativeId: '1', localAlias: 'Subscription fixture', profileLabel: 'Acceptance browser',
  });
  expect(await page.evaluate(() => chrome.bookmarks.getChildren('1'))).toEqual(before);
  const mounted = await send<{ mapping: Mapping; local: LocalMapping }>(page, { kind: 'mountConfirm', token: preview.token });
  if (mounted.local.state !== 'current') console.log('SUBSCRIPTION_MOUNT_DIAGNOSTICS', JSON.stringify(await readSubscriptionDb(page, 'diagnostics')));
  expect(mounted.local.state, JSON.stringify({ state: mounted.local.state, error: mounted.local.error, root: mounted.local.rootNativeId, count: mounted.local.reserved })).toBe('current');
  expect(mounted.local.rootNativeId).toBeTruthy();
  return mounted;
}
async function nativeSource(page: Page, rootId: string, sourceUrl: string) {
  return page.evaluate(async ({ rootId, sourceUrl }) => {
    const tree = await chrome.bookmarks.getSubTree(rootId);
    const pending = [...tree];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.url === sourceUrl) return { id: node.id, title: node.title, url: node.url };
      if (node.children) pending.push(...node.children);
    }
    throw new Error('subscription_source_bookmark_missing');
  }, { rootId, sourceUrl });
}
