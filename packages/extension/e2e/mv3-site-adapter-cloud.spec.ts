import { test, expect, chromium, type Page, type BrowserContext } from '@playwright/test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startRealStack, type RealStack } from './real-stack.js';
import { openExtensionOptions, installFixtureReplicaBinding, signInExtension, showOptionsPane } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { sourceHash, SOURCE_ARCHIVE_PROFILE, type SourceScope, type SourceLease, type SourceFinalReceipt } from '../../server/src/modules/source-archives/index.js';
const extensionId = 'pplpnpegpnghcddhmpgkbfkdfadjiaen', extensionOrigin = `chrome-extension://${extensionId}`;
// Fixture-only private data. No external site/session or provider is contacted.
test.use({ trace: 'off' });
async function cloud<T = Record<string, unknown>>(page: Page, action: string, input: Record<string, unknown> = {}): Promise<T> {
  return page.evaluate(r => chrome.runtime.sendMessage(r), { kind: `known.siteAdapters.cloud.${action}`, ...input }) as Promise<T>;
}
async function siteStatus(page: Page): Promise<{ documents: number; candidateAccount?: string; confirmations?: { pending: number } }> {
  return page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.siteAdapters.status' })) as Promise<{ documents: number; candidateAccount?: string; confirmations?: { pending: number } }>;
}
test('COLP source archives commit actual final parents, recover lost results and fence two real browser devices', async ({}, info) => {
  test.setTimeout(420000);
  const directory = await mkdtemp(resolve(tmpdir(), 'colp-source-cloud-')), extension = resolve(directory, 'extension');
  await cp(resolve(import.meta.dirname, '../dist/development'), extension, { recursive: true });
  await cp(resolve(import.meta.dirname, '../config/e2e-fixture.json'), resolve(extension, 'generated-config.json'));
  const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8')) as { host_permissions: string[] };
  manifest.host_permissions.push('https://known.example/*', 'https://identity.known.example/*'); await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
  let stack: RealStack | undefined; const contexts: BrowserContext[] = []; let modelCalls = 0;
  try {
    stack = await startRealStack();
    const backendCases = await backendAcceptance(stack);
    async function open(index: 0 | 1) {
      const context = await chromium.launchPersistentContext(resolve(directory, `profile-${index}`), { headless: false, channel: 'chromium', ignoreHTTPSErrors: true,
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, `--host-resolver-rules=${stack!.browserHostResolverRules}`, '--no-proxy-server', '--ignore-certificate-errors'] });
      contexts.push(context); context.setDefaultTimeout(20000);
      const cors = { 'access-control-allow-origin': 'https://www.bilibili.com', 'access-control-allow-credentials': 'true' };
      await context.route('https://provider.test/**', r => { modelCalls++; return r.fulfill({ status: 500, body: '{}' }); });
      await context.route('https://www.bilibili.com/**', r => r.fulfill({ contentType: 'text/html', body: '<title>Controlled COLP source</title>' }));
      await context.route('https://api.bilibili.com/x/web-interface/nav', r => r.fulfill({ headers: cors, contentType: 'application/json', body: '{"code":0,"data":{"isLogin":true,"mid":42}}' }));
      await context.route('https://api.bilibili.com/x/v3/fav/folder/created/list-all*', r => r.fulfill({ headers: cors, contentType: 'application/json', body: '{"code":0,"data":{"list":[{"id":101,"title":"Browser B"},{"id":102,"title":"Browser C"}]}}' }));
      await context.route('https://api.bilibili.com/x/v3/fav/resource/ids*', r => r.fulfill({ headers: cors, contentType: 'application/json', body: '{"code":0,"data":[{"id":1,"type":2}]}' }));
      await context.route('https://api.bilibili.com/x/v3/fav/resource/infos*', r => r.fulfill({ headers: cors, contentType: 'application/json', body: '{"code":0,"data":[{"id":1,"type":2,"title":"Browser cloud video","attr":0}]}' }));
      await context.route('https://api.bilibili.com/x/v3/fav/resource/deal', r => r.fulfill({ headers: cors, contentType: 'application/json', body: '{"code":0}' }));
      const { page } = await openExtensionOptions(context);
      const grants = { permissions: ['bookmarks', 'scripting', 'webNavigation'], origins: ['https://www.bilibili.com/*', 'https://provider.test/*'] };
      await page.evaluate(g => { const b = document.createElement('button'); b.id = 'grant-cloud'; b.textContent = 'Grant controlled source cloud access'; b.onclick = () => { void chrome.permissions.request(g); }; document.body.prepend(b); }, grants);
      await grantOptionalBookmarks(page, page.locator('#grant-cloud'), 'COLP source cloud fixture', grants);
      await installFixtureReplicaBinding(page, stack!.extensionBindings[index]); await signInExtension(page, stack!.collectionId);
      await showOptionsPane(page, 'folders'); await page.locator('#first-run-start').click();
      await expect.poll(() => page.evaluate(async () => (await chrome.runtime.sendMessage({ kind: 'known.firstRun.status' }) as { firstRun?: string }).firstRun), { timeout: 90000 }).toBe('completed');
      await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.bookmark.preferences.update', captureMode: 'automatic', aiTagMode: 'add', userGesture: true }));
      await page.evaluate(() => chrome.storage.local.set({ 'known.classification.local-enabled.v1': true,
        'known.classification.local-key.v1': { version: 3, generation: 'controlled', presetId: 'custom', endpoint: 'https://provider.test/v1/chat/completions', model: 'controlled', secret: 'fixture', disclosed: true } }));
      await page.goto(`${extensionOrigin}/site-adapters.html`);
      return { context, page };
    }
    async function connectSource(page: Page, context: BrowserContext) {
      const site = await context.newPage(); await site.goto('https://www.bilibili.com/video/av1');
      await page.locator('#enable').click(); await expect.poll(async () => !!(await siteStatus(page)).candidateAccount).toBe(true);
      await page.locator('#refresh').click(); await page.locator('#confirm').click(); await expect.poll(async () => (await siteStatus(page)).documents).toBe(1);
      await expect(page.locator('#archive-collections input')).toHaveCount(2, { timeout: 30000 });
      expect(await cloud(page, 'configureRule', { rootNativeId: '1', collectionIds: ['101'] })).toMatchObject({ configured: true });
      await site.evaluate(() => fetch('https://api.bilibili.com/x/v3/fav/resource/deal', { method: 'POST', credentials: 'include', body: new URLSearchParams({ rid: '1', type: '2', add_media_ids: '101,102' }) }));
      await expect.poll(async () => page.evaluate(async () => {
        const d = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('known-site-adapters'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
        try { return await new Promise<number>((resolve, reject) => { const r = d.transaction('memberships').objectStore('memberships').count(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); } finally { d.close(); }
      }), { timeout: 30000 }).toBe(2);
      await expect.poll(async () => (await siteStatus(page)).confirmations?.pending, { timeout: 15000 }).toBe(0);
      return site;
    }
    const a = await open(0); await connectSource(a.page, a.context);
    expect(await cloud(a.page, 'configureRule', { rootNativeId: '0', collectionIds: ['101'] })).toMatchObject({ error: 'sourceCloudMappingNeedsReview' });
    const review = await cloud<{ digest: string }>(a.page, 'review'); expect(review.digest).toMatch(/^sha256:/);
    expect(await cloud(a.page, 'approve', { digest: review.digest })).toMatchObject({ approved: true });
    const cancelled = await cloud<{ digest: string }>(a.page, 'preview');
    await a.page.locator('#tab-cloud').click(); await a.page.locator('#cloud-cancel').click(); await expect(a.page.locator('pre#cloud-status')).toContainText('"state": "cancelled"');
    await expect(a.page.locator('#cloud-commit')).toBeDisabled();
    expect(await cloud(a.page, 'commit', { digest: cancelled.digest })).toMatchObject({ error: 'sourceCloudPlanMissing' });
    const preview = await cloud<{ digest: string; edges: { collectionId: string }[] }>(a.page, 'preview'); expect(preview.edges.map(e => e.collectionId)).toEqual(['101']);
    expect(preview.digest).not.toBe(cancelled.digest);
    expect(await cloud(a.page, 'commit', { digest: cancelled.digest })).toMatchObject({ error: 'sourceCloudRecoverFirst' });
    expect(((await stack.observations()).canonicalNodes as { title: string }[]).some(n => n.title === 'Browser B')).toBe(false);
    stack.setSourceArchiveFault!('rollback-after-create'); expect(await cloud(a.page, 'commit', { digest: preview.digest })).toMatchObject({ error: 'source_outcome_unknown' });
    expect(((await stack.observations()).canonicalNodes as { title: string }[]).some(n => n.title === 'Browser B')).toBe(false);
    expect(await cloud(a.page, 'recover')).toMatchObject({ state: 'prepared', digest: preview.digest });
    stack.setSourceArchiveFault!('lost-response'); const lost = await cloud(a.page, 'commit', { digest: preview.digest }); expect(lost).toHaveProperty('error'); stack.setSourceArchiveFault!('none');
    const cdp = await a.context.newCDPSession(a.page), targets = await cdp.send('Target.getTargets');
    const worker = targets.targetInfos.find(t => t.type === 'service_worker' && t.url.includes(extensionId)); await cdp.send('Target.closeTarget', { targetId: worker!.targetId }); await cdp.detach();
    await a.page.locator('#tab-sync').click(); await a.page.locator('#disable').click();
    const recovered = await cloud<{ state: string; receipt: SourceFinalReceipt }>(a.page, 'recover'); expect(recovered.state).toBe('committed');
    const effect = recovered.receipt.effects[0]!; expect(effect.finalParentId).not.toBe('p3-27-bookmarks-bar');
    const nodes = (await stack.observations()).canonicalNodes as { id: string; parent_id: string | null; title: string; url: string | null }[];
    expect(nodes.filter(n => n.title === 'Browser B')).toHaveLength(1); expect(nodes.filter(n => n.title === 'Browser C')).toHaveLength(0);
    expect(nodes.find(n => n.id === effect.nodeId)?.parent_id).toBe(effect.finalParentId);
    expect(nodes.filter(n => n.title === 'Browser cloud video')).toHaveLength(1);
    expect(await cloud(a.page, 'recover')).toMatchObject({ receipt: recovered.receipt });
    const b = await open(1);
    await expect.poll(() => b.page.evaluate(() => chrome.bookmarks.search({ title: 'Browser cloud video' }).then(n => n.length)), { timeout: 90000 }).toBe(1);
    expect(await cloud(b.page, 'preview')).toMatchObject({ error: 'sourceAuthorizationChanged' });
    await connectSource(b.page, b.context);
    const bReview = await cloud<{ digest: string }>(b.page, 'review');
    expect(await cloud(b.page, 'approve', { digest: bReview.digest })).toMatchObject({ error: 'source_authority_busy' });
    // Revocation is available even after the source inspector was disabled on A.
    expect(await cloud(a.page, 'revoke')).toMatchObject({ revoked: true });
    const transfer = await cloud<{ digest: string }>(b.page, 'review'); expect(await cloud(b.page, 'approve', { digest: transfer.digest })).toMatchObject({ approved: true });
    const secondPreview = await cloud<{ digest: string }>(b.page, 'preview'); const second = await cloud<{ receipt: SourceFinalReceipt }>(b.page, 'commit', { digest: secondPreview.digest });
    expect(second.receipt.effects[0]).toMatchObject({ nodeId: effect.nodeId, finalParentId: effect.finalParentId, disposition: 'reused' });
    expect(((await stack.observations()).canonicalNodes as { title: string }[]).filter(n => n.title === 'Browser cloud video')).toHaveLength(1);
    expect(await cloud(a.page, 'recover')).toMatchObject({ receipt: recovered.receipt }); expect(modelCalls).toBe(0);
    await info.attach('source-cloud-acceptance.json', { body: JSON.stringify({ fixture: true, realSite: false, browserVersion: a.context.browser()?.version(), backend: 'real COLP Server Fastify + PostgreSQL 16.4', backendCases,
      sourceAccount: 'controlled', bOnly: true, cWrites: 0, rollbackAtomic: true, lostResponse: true, workerCutRecoveryAfterDisable: true, twoBrowsers: true, ordinarySyncDoesNotGrantSourceAuthority: true, exclusiveLeaseTransfer: true,
      sameCanonicalCopyAfterTransfer: true, modelCalls, classification: false, receiptUsesActualFinalParent: true, cancelledPreviewCannotApproveNewCommand: true }), contentType: 'application/json' });
  } finally { for (const c of contexts) await c.close(); await stack?.close(); await rm(directory, { recursive: true, force: true }); }
});
async function backendAcceptance(stack: RealStack) {
  const probe = async <T = Record<string, unknown>>(action: string, input: unknown, status = 200): Promise<T> => {
    const r = await stack.sourceArchiveProbe!({ version: 1, action, input }); expect(r.status, JSON.stringify(r.body)).toBe(status); return r.body as T;
  };
  expect((await stack.sourceArchiveProbe!()).body).toEqual(SOURCE_ARCHIVE_PROFILE);
  const nodes = (await stack.observations()).canonicalNodes as { id: string; resource_revision: string }[];
  const root = nodes.find(n => n.id === 'p3-27-bookmarks-bar')!;
  const scope: SourceScope = { site: 'bilibili', identityVersion: 1, sourceAccount: '99', collectionId: stack.collectionId,
    roots: [{ ruleId: 'B', nodeId: root.id, resourceRevision: root.resource_revision, collectionIds: ['201', '202'] }],
    policy: { revision: 1, copies: 'sourceAndSemantic', backgroundClassification: 'disabled', sourceRemoval: 'retainArchive' }, rulesDigest: sourceHash('rules'), bindingDigest: sourceHash('bindings') };
  const raceScope = { ...scope, sourceAccount: '98' };
  const race = await Promise.all(stack.extensionBindings.map(b => stack.sourceArchiveProbe!({ version: 1, action: 'configure', input: { scope: raceScope, replicaId: b.replicaId, expectedEpoch: 0,
    approvalDigest: sourceHash({ scope: raceScope, replicaId: b.replicaId, expectedEpoch: 0 }) } })));
  expect(race.map(r => r.status).sort()).toEqual([200, 409]); await probe('revoke', { sourceAccount: '98', expectedEpoch: 1 });
  const invalid = { ...scope, sourceAccount: '97', roots: [{ ...scope.roots[0]!, nodeId: 'foreign-native-id' }] };
  await probe('configure', { scope: invalid, replicaId: stack.extensionBindings[0].replicaId, expectedEpoch: 0,
    approvalDigest: sourceHash({ scope: invalid, replicaId: stack.extensionBindings[0].replicaId, expectedEpoch: 0 }) }, 409);
  const grant = (replicaId: string, expectedEpoch: number) => ({ scope, replicaId, expectedEpoch, approvalDigest: sourceHash({ scope, replicaId, expectedEpoch }) });
  const leaseA = (await probe<{ lease: SourceLease }>('configure', grant(stack.extensionBindings[0].replicaId, 0))).lease;
  await probe('configure', grant(stack.extensionBindings[1].replicaId, 0), 409);
  await probe('configure', grant(stack.extensionBindings[1].replicaId, 1), 409);
  const edges = ['201', '202'].map(collectionId => ({ itemId: 'video:av:77', collectionId, collectionTitle: 'Same title', title: 'Backend video', url: 'https://www.bilibili.com/video/av77', ruleId: 'B', entry: 'siteImport', observationDigest: sourceHash(collectionId) }));
  const planId = randomUUID(), prepared = await probe<{ digest: string }>('preview', { sourceAccount: '99', lease: leaseA, planId, edges, scopeDigest: sourceHash(scope) });
  await probe('preview', { sourceAccount: '99', lease: leaseA, planId, edges: [{ ...edges[0], title: 'Changed immutable input' }], scopeDigest: sourceHash(scope) }, 409);
  const command = { sourceAccount: '99', lease: leaseA, planId, digest: prepared.digest };
  const receipt = await probe<SourceFinalReceipt>('commit', command); expect(receipt.effects).toHaveLength(2); expect(receipt.mutations).toHaveLength(4); expect(receipt.mutations.every(m => /^[1-9]\d*$/.test(m.commitOrdinal))).toBe(true);
  expect(new Set(receipt.effects.map(e => e.finalParentId)).size).toBe(2); expect(new Set(receipt.effects.map(e => e.nodeId)).size).toBe(2);
  expect(await probe('commit', command)).toEqual(receipt);
  const raced = await Promise.all([probe('revoke', { sourceAccount: '99', expectedEpoch: 1 }), stack.sourceArchiveProbe!({ version: 1, action: 'commit', input: command })]);
  expect([200, 409]).toContain((raced[1] as { status: number }).status);
  await probe('commit', command, 409);
  const leaseB = (await probe<{ lease: SourceLease }>('configure', grant(stack.extensionBindings[1].replicaId, 2))).lease;
  await probe('renew', { sourceAccount: '99', lease: leaseA }, 409);
  expect(await probe('recover', { planId, digest: prepared.digest })).toMatchObject({ state: 'committed', receipt });
  const next = randomUUID(), p = await probe<{ digest: string }>('preview', { sourceAccount: '99', lease: leaseB, planId: next, edges, scopeDigest: sourceHash(scope) });
  const reuse = await probe<SourceFinalReceipt>('commit', { sourceAccount: '99', lease: leaseB, planId: next, digest: p.digest });
  expect(reuse.effects.every(e => e.disposition === 'reused')).toBe(true);
  const cancelledId = randomUUID(), cancelledPlan = await probe<{ digest: string }>('preview', { sourceAccount: '99', lease: leaseB, planId: cancelledId, edges, scopeDigest: sourceHash(scope) });
  expect(await probe('cancel', { planId: cancelledId, digest: cancelledPlan.digest })).toMatchObject({ state: 'cancelled' });
  await probe('commit', { sourceAccount: '99', lease: leaseB, planId: cancelledId, digest: cancelledPlan.digest }, 409);
  const latePrepare = randomUUID(), lateDigest = sourceHash({ planId: latePrepare, sourceAccount: '99', scope, epoch: leaseB.epoch, edges });
  expect(await probe('cancel', { planId: latePrepare, digest: lateDigest })).toMatchObject({ state: 'cancelled' });
  await probe('preview', { sourceAccount: '99', lease: leaseB, planId: latePrepare, edges, scopeDigest: sourceHash(scope) }, 409);
  await probe('classify', {}, 422); await probe('revoke', { sourceAccount: '99', expectedEpoch: 3 });
  return { sameNameCollectionsDistinct: true, twoSourceCopies: true, immutableReplay: true, digestConflict: true, twoReplicaEpochRace: true, staleEpochRejected: true, receiptRetainedAfterRevocation: true, globalReservationsReused: true, backendClassificationUnavailable: true, canonicalMutationReceipts: true, simultaneousAcquisition: true, unmappedRootRejected: true, preparedCancellation: true, cancellationFencesLatePrepare: true };
}
