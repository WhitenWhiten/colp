import { createManagedSaves } from './managed-saves.js';
import { createManagedCopyClient, type ManagedBinding, type ManagedNode } from './managed-client.js';
import type { ManagedLibrary } from './copy-identity.js';
import { managedLibraryKey } from './copy-identity.js';
import { siteLedger, SITE_RECOVERY_ALARM } from './source-runtime.js';
import { readSourceConnection } from './content-identity.js';
import { identityDefinition } from './registry.js';
import { rows } from './source-db.js';
import { currentCaptureScope } from '../sw/capture-native.js';
import { assertSourceRoot } from '../sw/planned-capture.js';
import { currentSyncScope, loadConfig } from '../sw/scope.js';
import { store, syncState } from '../sw/runtime.js';
import { captureDeviceId } from '../sw/capture-history.js';
import { colpCredentialHeaders } from '../auth-client.js';
import { credentialGatedFetch } from '../server-origin-permission.js';
import { scheduleSyncEngineWake } from '../sw/engine.js';
import type { SourceFolderReservation } from './contracts.js';
import { sameNativeContentValue } from '../native-event-correlation.js';
export async function managedClientForLibrary(library: ManagedLibrary) {
  await assertOwner(library); const config = await loadConfig(), credential = await store.loadCredential(), authority = await store.fence.read();
  if (!credential || config.serverOrigin !== library.serverOrigin) throw new Error('sourceSyncOwnerChanged');
  return createManagedCopyClient({ origin: library.serverOrigin, fetch: credentialGatedFetch(),
    headers: async () => colpCredentialHeaders(credential.accessToken),
    assertCurrent: async () => { await store.assertWritable(authority.generation); await assertOwner(library); } });
}
export async function projectManagedBinding(library: ManagedLibrary, binding: ManagedBinding, commandId: string) {
  if (binding.state !== 'active') throw new Error(binding.state === 'suppressed' ? 'sourceCopySuppressed' : 'sourceCopyDetached');
  return projectManagedNode(library, binding.node, binding.slot.kind, commandId);
}
async function projectManagedNode(library: ManagedLibrary, written: ManagedNode, kind: 'bookmark' | 'folder', commandId: string) {
  const scope = await assertOwner(library), mapping = await syncState.getMappingByColpId(scope, written.nodeId);
  if (!mapping) return null;
  if (mapping.quarantine || mapping.nodeKind && mapping.nodeKind !== kind) throw new Error('sourceCopyDetached');
  const node = (await chrome.bookmarks.get(mapping.nativeId).catch(() => []))[0];
  if (!node?.dateAdded) return null;
  const parent = node.parentId && await syncState.getMappingByNativeId(scope, node.parentId);
  if (!parent || parent.colpId !== written.parentId || node.title !== written.title || !sameNativeContentValue('url', node.url ?? null, written.url)
    || (node.url ? 'bookmark' : 'folder') !== kind) throw new Error('sourceCopyDetached');
  return { native: { bindingId: commandId, deviceId: await captureDeviceId(), nativeId: node.id, kind, dateAdded: node.dateAdded,
    proof: { kind: 'writeReceipt' as const, id: `managed:${written.nodeId}` } }, parentId: node.parentId! };
}
async function assertOwner(library: ManagedLibrary) {
  const scope = await currentSyncScope();
  if (managedLibraryKey(scope) !== managedLibraryKey(library)) throw new Error('sourceSyncOwnerChanged');
  return scope;
}
export const managedSaves = createManagedSaves(siteLedger.db, {
  async destination(parent) {
    const target = await assertSourceRoot(parent); if (!target.inRange) return null;
    const scope = await currentSyncScope();
    const capture = await currentCaptureScope();
    if (scope.accountId !== capture.accountId || scope.collectionId !== capture.collectionId) throw new Error('sourceSyncOwnerChanged');
    const mapping = await syncState.getMappingByNativeId(scope, parent.nativeId);
    if (!mapping || mapping.quarantine || mapping.nodeKind !== 'folder' || mapping.colpId.startsWith('pending-')) throw new Error('sourceSyncPending');
    return { library: { serverOrigin: scope.serverOrigin, accountId: scope.accountId, collectionId: scope.collectionId }, replicaId: scope.replicaId,
      parentId: mapping.colpId, parentRevision: mapping.projection.resourceRevision ?? mapping.projection.revision };
  },
  async slot(plan, effect) {
    const connection = await readSourceConnection(siteLedger.db, plan.connectionId);
    const source = { site: connection.siteKey, identityVersion: connection.identityVersion, sourceAccount: connection.accountId };
    if (effect.kind === 'ensureSourceFolder') {
      const folders = await siteLedger.db.transaction(['folderReservations'], 'readonly', tx => rows<SourceFolderReservation>(tx, 'folderReservations', plan.mount!.id));
      const folder = folders.find(f => f.id === effect.reservationId); if (!folder) throw new Error('folderChanged');
      return { kind: 'folder', source: { ...source, sourceCollectionId: folder.collectionId } };
    }
    if (effect.kind !== 'createBookmark' || !effect.representation.sourceCollectionId) throw new Error('effectUnavailable');
    const definition = identityDefinition(source.site, source.identityVersion);
    return { kind: 'bookmark', copy: { purpose: 'sourceArchive', content: { site: source.site, identityVersion: source.identityVersion, itemId: effect.item.id,
      accountId: definition.contentIdScope === 'site' ? null : connection.accountId }, sourceAccount: connection.accountId, sourceCollectionId: effect.representation.sourceCollectionId } };
  },
  client: managedClientForLibrary,
  async projection(destination, receipt) {
    return projectManagedNode(destination.library, receipt.node, destination.command.slot.kind, destination.command.commandId);
  },
  wake() {
    chrome.alarms.create(SITE_RECOVERY_ALARM, { when: Date.now() + 30000 });
    void scheduleSyncEngineWake('manual').catch(() => undefined);
  },
});
