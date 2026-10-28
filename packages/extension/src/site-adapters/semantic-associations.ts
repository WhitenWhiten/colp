import type { CaptureScope } from '../capture/contracts.js';
import type { ContentIdentity, NativeBinding, Representation } from './contracts.js';
import type { ContentBindingRow } from './content-bindings.js';
import { contentBindingKey, sameContentIdentity } from './content-identity.js';
import { managedContent, semanticScopeId } from './semantic-scope.js';
import { siteLedger } from './source-runtime.js';
import { captureDeviceId } from '../sw/capture-history.js';
import { captureStore } from '../sw/capture.js';
import { currentCaptureScope, assertCaptureScope } from '../sw/capture-native.js';
import { currentSyncScope } from '../sw/scope.js';
import { syncState } from '../sw/runtime.js';
import { assertContentNative } from './content-runtime.js';
import { get, put, rows, sourceDigest } from './source-db.js';
import { representationKey } from './reservations.js';
import { managedSaves, managedClientForLibrary, projectManagedBinding } from './managed-runtime.js';
import type { ManagedBinding, ManagedDestination, ManagedReference } from './managed-client.js';
import { managedReference } from './managed-changes.js';
import type { ManagedLibrary } from './copy-identity.js';
import { assertSourceRoot } from '../sw/planned-capture.js';
export async function semanticContext(folderId?: string) {
  const scope = await currentCaptureScope(), deviceId = await captureDeviceId();
  let inRange = true;
  if (folderId) {
    const node = (await chrome.bookmarks.get(folderId))[0];
    inRange = (await assertSourceRoot({ nativeId: folderId, kind: 'folder', dateAdded: node?.dateAdded ?? null, deviceId,
      bindingId: 'semantic-scope', proof: { kind: 'explicitAdoption', id: 'semantic-scope' } })).inRange;
  }
  return { scope, scopeId: semanticScopeId(inRange ? scope : { ...scope, accountId: null, collectionId: null }, deviceId), deviceId,
    library: inRange && scope.accountId && scope.collectionId ? { serverOrigin: scope.serverOrigin, accountId: scope.accountId, collectionId: scope.collectionId } : null };
}
/** Upgrade only exact receipts already bound to this owner or to a current canonical mapping. */
export async function scopedSemanticBindings(identity: ContentIdentity, scope: CaptureScope, scopeId: string) {
  const candidates = await siteLedger.db.transaction(['contentBindings'], 'readonly', async tx =>
    (await rows<ContentBindingRow>(tx, 'contentBindings', identity.siteKey, identity.identityVersion, identity.itemId))
      .filter(b => !b.supersededBy && sameContentIdentity(b.content, identity)));
  const deviceId = await captureDeviceId();
  for (const b of candidates.filter(b => !b.scopeId || b.scopeId !== scopeId && scopeId === JSON.stringify(['local', deviceId]) && b.native?.deviceId === deviceId)) {
    const task = await captureStore.getForOwner(scope, b.captureIntentId);
    let proven = task ? semanticScopeId(task.scope, await captureDeviceId()) : null;
    if (b.native?.deviceId === deviceId && scopeId === JSON.stringify(['local', deviceId])) {
      await assertContentNative(b.native, { title: b.title, parentId: b.parentId, url: b.url }); proven = scopeId;
    }
    if (b.native && scope.accountId && scope.collectionId) {
      await assertContentNative(b.native, { title: b.title, parentId: b.parentId, url: b.url });
      const sync = await currentSyncScope().catch(() => null), mapping = sync && await syncState.getMappingByNativeId(sync, b.native.nativeId);
      if (mapping && !mapping.quarantine && sync?.accountId === scope.accountId && sync.collectionId === scope.collectionId) proven = scopeId;
    }
    if (!proven) throw new Error('semanticBindingNeedsReview');
    await siteLedger.db.transaction(['contentBindings', 'representations'], 'readwrite', async tx => {
      const key = contentBindingKey(b.content, b.id), current = await get<ContentBindingRow>(tx, 'contentBindings', key);
      if (!current || sourceDigest(current) !== sourceDigest(b)) throw new Error('content_binding_changed');
      put(tx, 'contentBindings', key, { ...current, scopeId: proven });
      if (current.connectionId && current.native) for (const r of await rows<Representation>(tx, 'representations', current.connectionId, current.content.itemId)) {
        if (r.purpose !== 'semantic' || r.scopeId === proven || r.native.nativeId !== current.native.nativeId || r.native.dateAdded !== current.native.dateAdded) continue;
        const scoped = { ...r, scopeId: proven! }; put(tx, 'representations', representationKey(scoped), scoped);
      }
    }); b.scopeId = proven;
  }
  return candidates.filter(b => b.scopeId === scopeId);
}
export async function sharedSemanticBinding(identity: ContentIdentity, library: ManagedLibrary): Promise<ManagedBinding | null> {
  const client = await managedClientForLibrary(library); await client.semanticProfile();
  return (await client.call<{ binding: ManagedBinding | null }>('managed.lookup', { collectionId: library.collectionId,
    copy: { purpose: 'semantic', content: managedContent(identity) } })).binding;
}
/** Register an exact native/canonical association; legacy bookmarks are never discovered by URL or title. */
export async function adoptSemanticAssociation(binding: ContentBindingRow, scope: CaptureScope) {
  if (!binding.native || !scope.accountId || !scope.collectionId) return;
  if (binding.shared?.slot.kind === 'bookmark' && binding.shared.slot.copy.purpose === 'semantic') return;
  await assertContentNative(binding.native, { title: binding.title, parentId: binding.parentId, url: binding.url });
  const sync = await currentSyncScope(), mapping = await syncState.getMappingByNativeId(sync, binding.native.nativeId);
  if (!mapping || mapping.quarantine || mapping.colpId.startsWith('pending-')) throw new Error('sourceSyncPending');
  const node = (await chrome.bookmarks.get(binding.parentId))[0];
  const parent: NativeBinding<'folder'> = { nativeId: binding.parentId, kind: 'folder', dateAdded: node?.dateAdded ?? null, deviceId: binding.native.deviceId,
    bindingId: binding.id, proof: { kind: 'explicitAdoption', id: binding.id } };
  // Adoption changes metadata only. A new proven canonical revision gets its own immutable attempt.
  const commandId = `semantic-adopt:${binding.id}:${sourceDigest({ projection: mapping.projection, parent: binding.parentId }).slice(7, 23)}`;
  const command = await managedSaves.prepareForSlot({ commandId, ownerId: binding.id, connectionId: binding.connectionId ?? '', kind: 'bookmark', parent,
    title: binding.title, logicalDigest: sourceDigest({ native: binding.native, scopeId: binding.scopeId }), deviceId: binding.native.deviceId,
    bookmark: { planId: binding.id, effectId: 'semantic', representation: { connectionId: binding.connectionId ?? '', itemId: binding.content.itemId, purpose: 'semantic', sourceCollectionId: null, mountId: null }, url: binding.url, scope, source: 'site-import' } },
  { kind: 'bookmark', copy: { purpose: 'semantic', content: managedContent(binding.content) } });
  if (!command.managed) return;
  command.managed.command.adopt = { nodeId: mapping.colpId, revision: mapping.projection.resourceRevision ?? mapping.projection.revision };
  const key = `semanticAdoption:${commandId}`, frozen = await siteLedger.db.read<typeof command>('meta', key);
  const durable = frozen ?? command;
  if (!frozen) await siteLedger.db.transaction(['meta'], 'readwrite', async tx => put(tx, 'meta', key, command));
  const result = await managedSaves.execute(durable, async () => { await assertCaptureScope(scope); await assertContentNative(binding.native!, binding); });
  if (result.status !== 'confirmed') throw new Error(result.reason);
  await attachSemanticAssociation({ identity: binding.content, scopeId: binding.scopeId!, id: binding.captureIntentId, connections: binding.sourceConnections ?? [],
    native: result.native as NativeBinding<'bookmark'>, written: { title: binding.title, parentId: result.written!.parentId, url: result.written!.url! }, managed: durable.managed });
}
export async function attachSemanticAssociation(input: { identity: ContentIdentity; scopeId: string; id: string; connections: readonly string[];
  native: NativeBinding<'bookmark'>; written: { title: string; parentId: string; url: string }; managed?: ManagedDestination; shared?: ManagedReference }) {
  await assertContentNative(input.native, input.written);
  await siteLedger.db.transaction(['contentBindings', 'representations', 'itemReservations', 'meta'], 'readwrite', async tx => {
    const shared = input.shared ?? await managedReference(tx, input.managed);
    const candidates = (await rows<ContentBindingRow>(tx, 'contentBindings', input.identity.siteKey, input.identity.identityVersion, input.identity.itemId))
      .filter(b => !b.supersededBy && sameContentIdentity(b.content, input.identity) && b.scopeId === input.scopeId);
    if (candidates.length > 1 || candidates.some(b => !b.native && b.captureIntentId !== input.id && !b.managed
      || b.native && (b.native.nativeId !== input.native.nativeId || b.native.dateAdded !== input.native.dateAdded)
      || b.state === 'suppressed' || b.state === 'detached')) throw new Error('semanticBindingNeedsReview');
    const old = candidates[0], id = old?.id ?? input.id;
    const binding: ContentBindingRow = { ...old, id, content: input.identity, scopeId: input.scopeId, captureIntentId: old?.captureIntentId ?? input.id,
      purpose: 'semantic', native: input.native, connectionId: old?.connectionId ?? input.connections[0] ?? null,
      sourceConnections: [...new Set([...old?.sourceConnections ?? [], ...input.connections])],
      commandId: old?.commandId ?? input.id, requestDigest: old?.requestDigest ?? sourceDigest({ identity: input.identity, scopeId: input.scopeId }),
      state: 'active', mode: old?.mode ?? 'reuse', policyRevision: old?.policyRevision ?? null, intentPending: false,
      ...input.written, ...(input.managed ? { managed: input.managed } : {}), ...(shared ? { shared } : {}) };
    put(tx, 'contentBindings', contentBindingKey(input.identity, id), binding);
    for (const connectionId of input.connections) {
      const key = { connectionId, itemId: input.identity.itemId, purpose: 'semantic' as const, sourceCollectionId: null, mountId: null, scopeId: input.scopeId };
      const existing = await get<Representation>(tx, 'representations', representationKey(key));
      if (existing && existing.state !== 'active') throw new Error('semanticBindingNeedsReview');
      put(tx, 'representations', representationKey(key), { ...key, native: input.native, state: 'active', manualRevision: existing?.manualRevision ?? 0,
        lastWritten: input.written, ...(shared ? { shared } : {}) } satisfies Representation);
    }
  });
}
export async function importSharedSemantic(identity: ContentIdentity, scope: CaptureScope, scopeId: string, connectionIds: readonly string[], id: string) {
  if (!scope.accountId || !scope.collectionId) return null;
  const library = { serverOrigin: scope.serverOrigin, accountId: scope.accountId, collectionId: scope.collectionId };
  const binding = await sharedSemanticBinding(identity, library); if (!binding) return null;
  const projected = await projectManagedBinding(library, binding, id); if (!projected) throw new Error('sourceSyncPending');
  if (projected.native.kind !== 'bookmark' || binding.node.url === null) throw new Error('sourceSyncInvalid');
  await assertCaptureScope(scope);
  await attachSemanticAssociation({ identity, scopeId, id, connections: connectionIds, native: projected.native as NativeBinding<'bookmark'>,
    shared: { library, slot: binding.slot, nodeId: binding.node.nodeId, controlRevision: binding.controlRevision ?? 0 },
    written: { title: binding.node.title, parentId: projected.parentId, url: binding.node.url } });
  return binding;
}
