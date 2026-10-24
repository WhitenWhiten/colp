import { sourceLayout } from './layout-runtime.js';
import { browserRuleStore } from '../sw/automation-browser.js';
import { object, literal, str } from './schema.js';
import { siteLedger, sourceContext } from './source-runtime.js';
import { SITE_STATE_KEY, type TransportState } from './transport.js';
import { createSourceReservations } from './reservations.js';
import { effectDigest, persistSavePlan, planDigest } from './planned-executor.js';
import { executePlannedSave, installSourcePlanAuthorization } from './planned-runtime.js';
import { installPlannedNativeFault } from '../capture/planned.js';
import { captureDeviceId } from '../sw/capture-history.js';
import { assertPlannedNative } from '../sw/planned-capture.js';
import type { NativeBinding, SaveEffect, SavePlan } from './contracts.js';
const kind = literal('known.siteAdapters.evidence');
const schema = object({ kind, operation: literal('prepare'), rootNativeId: str(128) });
const executeSchema = object({ kind, operation: literal('execute'), planId: str(128), effectId: str(128) });
const faultSchema = object({ kind, operation: literal('fault'), commandId: str(128), point: literal('beforeNativeSubmit', 'afterNativeReceipt', 'afterFolderCreate', 'afterBookmarkCreate') });
const statusSchema = object({ kind, operation: literal('status'), planId: str(128) });
const layoutSchema = object({ kind, operation: literal('layout'), rootNativeId: str(128), scenario: literal('initial', 'later') });
/** This module is removed from production by the build evidence flag. */
export function installSiteAdapterEvidence() {
  if (!__KNOWN_EXTENSION_EVIDENCE__) return;
  installSourcePlanAuthorization(async (plan, effect) => {
    const approved = await siteLedger.db.read<{ digest: string; root: NativeBinding<'folder'> }>('meta', `evidence-plan:${plan.id}`);
    if (!approved) return sourceLayout.authorize(plan, effect);
    if (approved.digest !== planDigest(plan)) throw new Error('sourcePolicyUnavailable');
    await assertPlannedNative(approved.root);
  });
  installPlannedNativeFault(async (point, commandId) => {
    const fault = await siteLedger.db.read<{ point: string; commandId: string }>('meta', 'evidence-fault');
    if (fault?.point !== point || fault.commandId !== commandId) return;
    await siteLedger.db.transaction(['meta'], 'readwrite', async tx => {
      tx.objectStore('meta').put({ point, commandId }, 'evidence-reached'); tx.objectStore('meta').delete('evidence-fault');
    });
    await new Promise<void>(() => { /* controlled E2E terminates this worker at the boundary */ });
  });
  chrome.runtime.onMessage.addListener((raw, sender, respond) => {
    if (!__KNOWN_EXTENSION_EVIDENCE__ || sender.id !== chrome.runtime.id || !sender.url) return false;
    const u = new URL(sender.url); if (u.protocol !== 'chrome-extension:' || u.hostname !== chrome.runtime.id || !['/site-adapters.html', '/options.html'].includes(u.pathname)) return false;
    if (![schema, executeSchema, faultSchema, statusSchema, layoutSchema].some(s => s(raw))) return false;
    const request = raw as { operation: string; rootNativeId?: string; planId?: string; effectId?: string; commandId?: string; point?: string; scenario?: string };
    void (async () => {
      if (request.operation === 'prepare') return prepare(request.rootNativeId!);
      if (request.operation === 'layout') return prepareLayout(request.rootNativeId!, request.scenario === 'later');
      if (request.operation === 'execute') return executePlannedSave(request.planId!, request.effectId!);
      if (request.operation === 'fault') {
        await siteLedger.db.transaction(['meta'], 'readwrite', async tx => { tx.objectStore('meta').put({ commandId: request.commandId, point: request.point }, 'evidence-fault'); tx.objectStore('meta').delete('evidence-reached'); }); return { status: 'armed' };
      }
      return { plan: await siteLedger.db.read('savePlans', request.planId!), reached: await siteLedger.db.read('meta', 'evidence-reached') };
    })().then(respond, e => respond({ status: 'error', reason: e instanceof Error ? e.message : 'unavailable' })); return true;
  });
}
async function prepareLayout(rootNativeId: string, later: boolean) {
  const state = (await chrome.storage.local.get(SITE_STATE_KEY))[SITE_STATE_KEY] as TransportState;
  const lease = state.leases.find(l => l.expiresAt > Date.now()); if (!lease) throw new Error('sourceUnresolved');
  const context = await sourceContext(lease), ruleKey = `evidence-layout-rule:${rootNativeId}`;
  if (!await siteLedger.db.read('meta', ruleKey)) {
    const result = await browserRuleStore().saveRule({ draft: { name: 'Controlled source rule', combinator: 'all',
      conditions: [{ kind: 'siteIs', value: 'www.bilibili.com' }], action: { kind: 'file', folderNativeId: rootNativeId },
      site: { version: 1, admission: { entries: ['reconcile'], purpose: 'sourceArchive', connectionId: context.connectionId, collectionIds: ['101'] },
        layout: { kind: 'sourceCollections', root: 'actionDestination' } } } }, Date.now());
    if (!result.ok) throw new Error('ruleRejected');
    await siteLedger.db.transaction(['meta'], 'readwrite', async tx => { tx.objectStore('meta').put(result.rule.id, ruleKey); });
    await sourceLayout.configure({ connectionId: context.connectionId, enabled: true, liveArchive: true,
      policy: { revision: 1, copies: 'sourceAndSemantic', backgroundClassification: 'disabled', sourceRemoval: 'retainArchive' } });
    const catalog = await siteLedger.acceptObservation(context, crypto.randomUUID(), { type: 'catalog.upsert', collections: [
      { id: '101', identity: 'siteId', title: 'Controlled source folder', parentId: null } ] });
    if (catalog.status === 'rejected') throw new Error(catalog.reason);
  }
  const aid = later ? '900002' : '900001', item = { id: `video:av:${aid}`, kind: 'video' as const, identity: 'siteId' as const,
    url: `https://www.bilibili.com/video/av${aid}`, title: 'Controlled layout archive' };
  const observation = await siteLedger.acceptObservation(context, crypto.randomUUID(), { type: 'membership.observed', item,
    memberships: { mode: 'delta', added: ['101'], removed: [] } });
  if (observation.status === 'rejected') throw new Error(observation.reason);
  const result = await sourceLayout.plan({ context, itemId: item.id, collectionId: '101', entry: 'reconcile',
    trigger: { kind: 'observation', observationId: observation.receiptId } });
  if (result.status !== 'planned') throw new Error(result.status);
  return { planId: result.plan.id };
}
async function prepare(rootId: string) {
  const state = (await chrome.storage.local.get(SITE_STATE_KEY))[SITE_STATE_KEY] as TransportState;
  const lease = state.leases.find(l => l.expiresAt > Date.now()); if (!lease) throw new Error('sourceUnresolved');
  const context = await sourceContext(lease), deviceId = await captureDeviceId(), node = (await chrome.bookmarks.get(rootId))[0];
  if (!node || node.url || !node.dateAdded) throw new Error('rootUnproven');
  const root: NativeBinding<'folder'> = { kind: 'folder', nativeId: node.id, dateAdded: node.dateAdded, deviceId, bindingId: crypto.randomUUID(), proof: { kind: 'explicitAdoption', id: crypto.randomUUID() } };
  await assertPlannedNative(root);
  const id = crypto.randomUUID(), mountId = crypto.randomUUID(), reservations = createSourceReservations(siteLedger.db);
  const folder = await reservations.reserveFolder({ mountId, collectionId: '101', mountRevision: 1, parent: { kind: 'native', binding: root }, title: 'Controlled collection' }, { planId: id, effectId: 'folder' });
  const ensure: SaveEffect = { effectId: 'folder', commandId: crypto.randomUUID(), payloadDigest: '', dependsOn: [], folderReservationDigest: folder.payloadDigest, kind: 'ensureSourceFolder', reservationId: folder.id };
  const bookmark: SaveEffect = { effectId: 'bookmark', commandId: crypto.randomUUID(), payloadDigest: '', dependsOn: ['folder'], folderReservationDigest: folder.payloadDigest, kind: 'createBookmark',
    representation: { connectionId: context.connectionId, itemId: 'video:av:1', purpose: 'sourceArchive', sourceCollectionId: '101', mountId },
    item: { id: 'video:av:1', kind: 'video', identity: 'siteId', url: 'https://www.bilibili.com/video/av1', title: 'Controlled source archive' }, parent: { kind: 'sourceFolder', reservationId: folder.id } };
  ensure.payloadDigest = effectDigest(ensure); bookmark.payloadDigest = effectDigest(bookmark);
  const { payloadDigest: _digest, ...payload } = bookmark;
  await reservations.reserveItem(bookmark.representation, payload, 'sourceAndSemantic', bookmark.commandId);
  const plan: SavePlan = { id, trigger: { kind: 'observation', observationId: crypto.randomUUID() }, purpose: 'sourceArchive', connectionId: context.connectionId,
    installationGeneration: context.installationGeneration, collectorGeneration: context.installationGeneration, sourceSessionGeneration: context.sourceSessionGeneration,
    importApprovalId: null, browserRules: { storageVersion: 3, listRevision: 1, contentVersions: {} }, rule: null, mount: { id: mountId, revision: 1 }, policyRevision: 1,
    classificationPolicyDigest: 'disabled', classification: 'disabled', effects: [ensure, bookmark] };
  await persistSavePlan(siteLedger.db, plan, 'approved');
  await siteLedger.db.transaction(['meta'], 'readwrite', async tx => { tx.objectStore('meta').put({ digest: planDigest(plan), root }, `evidence-plan:${id}`); });
  return { planId: id, folderCommandId: folder.commandId, bookmarkCommandId: bookmark.commandId };
}
