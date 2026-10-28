import { queueLocalSemanticAssociation } from './local-semantic-transfer.js';
import { scheduleSourceAlarm } from './wake-scheduler.js';
import { contentBindingKey, listContentBindings } from './content-identity.js';
import { legacySite, identityDefinition, type SiteDefinition } from './registry.js';
import { readConnectionAuthority } from './ledger.js';
import { installCaptureContentBindings, assertCaptureContent } from '../capture/content-binding.js';
import { createContentBindings, contentIdentityFromUrl } from './content-bindings.js';
import { siteLedger, SITE_RECOVERY_ALARM } from './source-runtime.js';
import { captureDeviceId } from '../sw/capture-history.js';
import type { NativeBinding } from './contracts.js';
import { get, put, rows, sourceKey } from './source-db.js';
import type { Representation } from './contracts.js';
import type { ContentBindingRow } from './content-bindings.js';
import { representationKey } from './reservations.js';
import { object, literal, str } from './schema.js';
import { captureStore } from '../sw/capture.js';
import { currentCaptureScope, nativeCaptureLocation } from '../sw/capture-native.js';
import { assertSourceRebound, assertRestoredItemAvailable } from './portable.js';
import { semanticContext, scopedSemanticBindings, importSharedSemantic, adoptSemanticAssociation } from './semantic-associations.js';
import { prepareSemanticCapture, releaseSemanticCaptureClaim } from './semantic-capture.js';
import { currentSyncScope } from '../sw/scope.js';
import { syncState } from '../sw/runtime.js';
import { managedLibraryKey } from './copy-identity.js';
import { retryUnsubmittedContent } from './content-retry.js';
interface ManagedMove { nativeId: string; dateAdded: number; title: string; from: string; to: string; at: number; state: 'submitted' | 'confirmed' }
export async function isManagedContentMove(id: string, to: string, from: string) {
  const move = await siteLedger.db.read<ManagedMove>('meta', `contentMove:${id}`);
  if (!move || move.to !== to || move.from !== from || Date.now() - move.at > 60000) return false;
  const n = (await chrome.bookmarks.get(id).catch(() => []))[0]; return n?.dateAdded === move.dateAdded && n.title === move.title && n.parentId === to;
}
export async function assertContentNative(binding: NativeBinding<'bookmark'>, expected?: { title: string; parentId: string; url?: string }) {
  const node = (await chrome.bookmarks.get(binding.nativeId).catch(() => []))[0];
  if (!node?.url || binding.deviceId !== await captureDeviceId() || !binding.dateAdded || node.dateAdded !== binding.dateAdded
    || expected && (node.title !== expected.title || node.parentId !== expected.parentId || expected.url && node.url !== expected.url)) throw new Error('content_binding_needs_review');
}
export const contentBindings = createContentBindings(siteLedger.db, assertContentNative);
let resolveIdentity: (url: string, tabId?: number) => Promise<import('./contracts.js').ContentIdentity | null> = async () => null;
export function installContentResolver(resolve: typeof resolveIdentity) { resolveIdentity = resolve; }
const adoptSchema = object({ kind: literal('known.siteAdapters.content.adopt'), captureId: str(128), nativeId: str(128) });
const listSchema = object({ kind: literal('known.siteAdapters.content.list') });
const retryPendingSchema = object({ kind: literal('known.siteAdapters.content.retryUnsubmitted'), itemId: str(128), bindingId: str(128) });
const accountAdoptSchema = object({ kind: literal('known.siteAdapters.content.adoptAccount'), itemId: str(128), bindingId: str(128), allowAccountChange: literal(true) });
export const validContentRequest = (v: unknown) => adoptSchema(v) || listSchema(v) || accountAdoptSchema(v) || retryPendingSchema(v);
export async function handleContentRequest(raw: unknown, definition: SiteDefinition = legacySite) {
  if (retryPendingSchema(raw)) {
    const input = raw as { itemId: string; bindingId: string };
    const binding = (await listContentBindings(siteLedger.db, definition)).find(b => b.id === input.bindingId && b.content.itemId === input.itemId);
    if (!binding) throw new Error('content_retry_unavailable');
    const context = await semanticContext(binding.parentId);
    if (binding.scopeId !== context.scopeId) throw new Error('content_retry_unavailable');
    await retryUnsubmittedContent(siteLedger.db, binding, {
      async cancelUnsubmitted() {
        const task = await captureStore.getForOwner(context.scope, binding.captureIntentId);
        if (!task) return;
        if (task.nativeIntentId || task.nativeId || !['unsubmitted', 'failed'].includes(task.save)) throw new Error('content_result_unknown');
        await captureStore.update({ ...task, save: 'failed', classification: 'none', automaticIntent: false, reason: 'superseded_unsubmitted',
          revision: task.revision + 1, updatedAt: Date.now() }, task.revision);
      }, release: () => releaseSemanticCaptureClaim(binding.managed),
    }); return { ok: true };
  }
  if (listSchema(raw)) {
    const rows = await listContentBindings(siteLedger.db, definition);
    const authority = await siteLedger.db.read<import('./ledger-types.js').SourceAuthority>('authorities', definition.adapterId);
    return { ok: true, connectionId: authority?.enabled ? authority.connectionId : null, truncated: rows.length > 1000 || rows.filter(b => !b.supersededBy).length > 50,
      bindings: await Promise.all(rows.filter(b => !b.supersededBy && b.content.siteKey === definition.siteKey && b.content.identityVersion === definition.identityVersion).slice(0, 50).map(async b => ({ id: b.id, itemId: b.content.itemId, title: b.title, state: b.state, connectionId: b.connectionId, native: !!b.native,
        retryable: !b.native && !await siteLedger.db.read('semanticJobs', b.captureIntentId)
          && (b.state === 'pending' || (await siteLedger.db.read<{ state: string }>('meta', `contentRetry:${b.id}`))?.state === 'checking') }))) };
  }
  if (accountAdoptSchema(raw)) {
    const r = raw as { itemId: string; bindingId: string }, b = await siteLedger.db.read<ContentBindingRow>('contentBindings', contentBindingKey({ siteKey: definition.siteKey, identityVersion: definition.identityVersion, itemId: r.itemId }, r.bindingId));
    const authority = await siteLedger.db.read<import('./ledger-types.js').SourceAuthority>('authorities', definition.adapterId);
    if (!b?.native || b.state !== 'active' || b.supersededBy || !authority?.enabled || !authority.connectionId) throw new Error('content_adoption_unavailable');
    if (b.content.accountId && b.content.accountId !== authority.accountId) throw new Error('content_identity_unresolved');
    if (b.scopeId && b.scopeId !== (await semanticContext(b.parentId)).scopeId) throw new Error('content_adoption_unavailable');
    await assertContentNative(b.native, { title: b.title, parentId: b.parentId, url: b.url });
    await contentBindings.adopt(b, { ...b.native, proof: { kind: 'explicitAdoption', id: crypto.randomUUID() } },
      { title: b.title, parentId: b.parentId, url: b.url }, authority.connectionId, true);
    return { ok: true };
  }
  if (!adoptSchema(raw)) throw new Error('invalid');
  const r = raw as { captureId: string; nativeId: string }, scope = await currentCaptureScope();
  const task = await captureStore.get(scope, r.captureId), b = await contentBindings.forIntent(r.captureId);
  if (!task?.contentIntent || task.disposition !== 'existing' || task.save === 'unknown' || b?.native || !b
    || !task.existence?.exact.some(e => e.nativeId === r.nativeId && e.writable)) throw new Error('content_adoption_unavailable');
  const node = (await chrome.bookmarks.get(r.nativeId))[0];
  if (!node?.url || node.url !== task.url || !node.dateAdded || !node.parentId) throw new Error('content_binding_needs_review');
  if (b.scopeId && b.scopeId !== (await semanticContext(node.parentId)).scopeId) throw new Error('content_binding_needs_review');
  const native: NativeBinding<'bookmark'> = { nativeId: node.id, bindingId: crypto.randomUUID(), dateAdded: node.dateAdded, deviceId: await captureDeviceId(), kind: 'bookmark',
    proof: { kind: 'explicitAdoption', id: crypto.randomUUID() } };
  const adopted = await contentBindings.adopt(b, native, { title: node.title, parentId: node.parentId, url: node.url }, b.connectionId);
  const next = { ...task, title: node.title, nativeId: node.id, nativeDateAdded: node.dateAdded, targetNativeId: node.parentId, save: 'local-saved' as const,
    contentIntent: { ...task.contentIntent, mode: adopted.mode, nativeId: node.id, dateAdded: node.dateAdded }, localLocation: await nativeCaptureLocation(node.id, scope), revision: task.revision + 1, updatedAt: Date.now() };
  await captureStore.update(next, task.revision); return { ok: true, task: next };
}
export function installContentBindings() {
  installCaptureContentBindings({
    async prepare(input) {
      if (!['manual-popup', 'action-popup'].includes(input.source)) return null;
      let identity = contentIdentityFromUrl(input.url) ?? await resolveIdentity(input.url, input.tabId);
      if (!identity) return null; // Ordinary unresolved saves retain the existing explicit adoption path.
      const definition = identityDefinition(identity.siteKey, identity.identityVersion), authority = await siteLedger.db.read<import('./ledger-types.js').SourceAuthority>('authorities', definition.adapterId);
      if (definition.contentIdScope !== 'site') {
        if (!authority?.enabled || !authority.accountId) throw new Error('content_identity_unresolved');
        identity = { ...identity, accountId: authority.accountId };
      }
      const context = await semanticContext(input.parentId);
      await scopedSemanticBindings(identity, context.scope, context.scopeId);
      const prepared = await prepareSemanticCapture(input, identity, context.scope);
      const itemId = identity.itemId;
      let b;
      try { b = await contentBindings.prepare({ ...input, itemId, content: identity, scopeId: context.scopeId, ...prepared }); }
      catch (e) { await releaseSemanticCaptureClaim(prepared.managed).catch(() => undefined); throw e; }
      if (b.mode !== 'create') await releaseSemanticCaptureClaim(prepared.managed);
      return { bindingId: b.id, itemId, connectionId: b.connectionId, mode: b.mode, captureIntentId: b.captureIntentId, forceAnother: b.forceAnother,
        ...(b.managed ? { managed: b.managed, managedParent: b.managedParent } : {}),
        ...(b.native ? { nativeId: b.native.nativeId, dateAdded: b.native.dateAdded! } : {}), title: b.title, url: b.url, parentId: b.parentId };
    },
    async assert(task) {
      if (!task.contentIntent) return;
      const b = await contentBindings.forIntent(task.captureId);
      if (!b || b.id !== task.contentIntent.bindingId || b.commandId !== task.commandId || b.supersededBy
        || ['detached', 'suppressed'].includes(b.state)) throw new Error('content_binding_changed');
      if (b.scopeId && b.connectionId && b.mode === 'create' && b.policyRevision !== null) {
        const policy = await siteLedger.db.read<import('./layout.js').SourcePolicyRecord>('meta', `policy:${b.connectionId}`);
        if (!policy?.enabled || policy.policy.revision !== b.policyRevision) throw new Error('source_policy_changed');
      }
      if (b.connectionId && (!b.scopeId || b.mode === 'reclassify' || b.mode === 'suggest')) {
        await assertSourceRebound(siteLedger.db, b.connectionId);
        await assertRestoredItemAvailable(siteLedger.db, b.connectionId, b.content.itemId);
        const a = await readConnectionAuthority(siteLedger.db, b.connectionId);
        const p = await siteLedger.db.read<import('./layout.js').SourcePolicyRecord>('meta', `policy:${b.connectionId}`);
        if (!a?.enabled || a.connectionId !== b.connectionId || !p?.enabled || p.policy.revision !== b.policyRevision
          || b.sourceGeneration && (b.sourceGeneration[0] !== a.installationGeneration || b.sourceGeneration[1] !== a.sourceSessionGeneration)) throw new Error('source_policy_changed');
      }
      if (b.native) await assertContentNative(b.native, { title: b.title, parentId: b.parentId, url: b.url });
    },
    async acknowledge(task) {
      if (!task.contentIntent || task.save !== 'local-saved' || !task.nativeId || !task.nativeDateAdded) return;
      const b = await contentBindings.forIntent(task.captureId); if (!b || b.supersededBy) return;
      const node = (await chrome.bookmarks.get(task.nativeId))[0]; if (!node?.parentId) throw new Error('content_binding_needs_review');
      await contentBindings.acknowledge(b, b.native ?? { nativeId: node.id, dateAdded: task.nativeDateAdded, deviceId: await captureDeviceId(), kind: 'bookmark',
        bindingId: crypto.randomUUID(), proof: { kind: 'writeReceipt', id: task.nativeIntentId ?? task.commandId } }, { title: node.title, parentId: node.parentId }, task.contentIntent.mode);
      if (!b.managed) {
        const saved = await contentBindings.forIntent(task.captureId);
        if (saved?.native) await queueLocalSemanticAssociation(saved, task.scope);
      }
    },
    async move(task, target, move) {
      if (!task.contentIntent) { await move(); return; }
      await assertCaptureContent(task);
      const b = await contentBindings.forIntent(task.captureId);
      if (!b?.native || b.supersededBy || b.state !== 'active') throw new Error('content_binding_needs_review');
      await assertContentNative(b.native, { title: b.title, parentId: b.parentId });
      let relocate: { from: string; to: string } | undefined;
      if (b.shared) {
        const scope = await currentSyncScope();
        if (managedLibraryKey(scope) !== managedLibraryKey(b.shared.library)) throw new Error('sourceSyncOwnerChanged');
        const from = await syncState.getMappingByNativeId(scope, b.parentId), to = await syncState.getMappingByNativeId(scope, target);
        if (!from || !to || from.quarantine || to.quarantine) throw new Error('semanticDestinationOutsideLibrary');
        relocate = { from: from.colpId, to: to.colpId };
      }
      const intent: ManagedMove = { nativeId: b.native.nativeId, dateAdded: b.native.dateAdded!, title: b.title, from: b.parentId, to: target, at: Date.now(), state: 'submitted' };
      await siteLedger.db.transaction(['meta'], 'readwrite', async tx => { put(tx, 'meta', `contentMove:${intent.nativeId}`, intent); });
      await assertCaptureContent(task);
      await move(); // Stable native identity + explicit target; an unknown result never authorizes a create.
      await assertContentNative(b.native, { title: b.title, parentId: target });
      await siteLedger.db.transaction(['meta', 'contentBindings', 'representations'], 'readwrite', async tx => {
        const key = contentBindingKey(b.content, b.id), current = await get<ContentBindingRow>(tx, 'contentBindings', key);
        if (!current || current.state !== 'active' || current.supersededBy) throw new Error('content_binding_changed');
        put(tx, 'contentBindings', key, { ...current, parentId: target });
        if (b.connectionId) for (const r of await rows<Representation>(tx, 'representations', b.connectionId, b.content.itemId)) {
          if (r.native.nativeId === b.native!.nativeId && r.state === 'active') put(tx, 'representations', representationKey(r), { ...r, lastWritten: { title: b.title, parentId: target, url: b.url } });
        }
        put(tx, 'meta', `contentMove:${intent.nativeId}`, { ...intent, state: 'confirmed' });
        if (b.shared && relocate) put(tx, 'meta', `managedRelocate:${managedLibraryKey(b.shared.library)}:${b.shared.nodeId}`, {
          reference: b.shared, native: b.native, nativeParent: target, expected: { nodeId: b.shared.nodeId, ...relocate, title: b.title, url: b.url } });
      });
      await contentBindings.acknowledge({ ...b, parentId: target }, b.native, { title: b.title, parentId: target });
      if (relocate) scheduleSourceAlarm(Date.now() + 1000, SITE_RECOVERY_ALARM);
    },
  });
}
