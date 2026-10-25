import type { ManagedLibrary } from './copy-identity.js';
import type { ManagedNode } from './managed-client.js';
import { syncState, workCoordinator } from '../sw/runtime.js';
import { currentSyncScope } from '../sw/scope.js';
import { managedLibraryKey } from './copy-identity.js';
import { executeNativeCreate } from '../native-create-executor.js';
import { nativeEventCorrelation, sameNativeContentValue } from '../native-event-correlation.js';
import { scopeKey } from '../sync-state/scope-key.js';
import { digest } from '../pull-codec.js';
import type { PullBookmarkApi } from '../pull-applier-types.js';
/** Explicit restoration reuses the canonical identity and the existing native-create receipt protocol. */
export function restoreReconcileProjection(library: ManagedLibrary, node: ManagedNode, commandId: string, authorize: () => Promise<void>) {
  return workCoordinator.run('engine', () => restoreProjection(library, node, commandId, authorize));
}
async function restoreProjection(library: ManagedLibrary, node: ManagedNode, commandId: string, authorize: () => Promise<void>) {
  const scope = await currentSyncScope(); if (managedLibraryKey(scope) !== managedLibraryKey(library)) throw new Error('sourceSyncOwnerChanged');
  const parent = await syncState.getMappingByColpId(scope, node.parentId); if (!parent || parent.quarantine || node.url === null) throw new Error('sourceSyncPending');
  const mapping = await syncState.getMappingByColpId(scope, node.nodeId), native = mapping && (await chrome.bookmarks.get(mapping.nativeId).catch(() => []))[0];
  if (native) {
    if (native.parentId !== parent.nativeId || native.title !== node.title || !sameNativeContentValue('url', native.url, node.url)) throw new Error('source_reconcile_conflict');
    return native;
  }
  const others = await syncState.listApplyIntents(scope);
  const intentId = `reconcile-native:${commandId}`;
  if (others.some(i => i.colpId === node.nodeId && i.intentId !== intentId && !['authority_committed', 'page_complete'].includes(i.state ?? '') && i.replayState !== 'committed')) throw new Error('sourceSyncPending');
  const echo = `reconcile-echo:${commandId}`, children = await chrome.bookmarks.getChildren(parent.nativeId);
  if (!await syncState.getApplyIntent(scope, echo)) await syncState.createApplyIntent(scope, { intentId: echo,
    correlationId: nativeEventCorrelation('create', '', { parentId: parent.nativeId, node: { title: node.title, url: node.url } }),
    expected: { kind: 'create', nativeId: `pending:${node.nodeId}` }, anchors: { beforeNativeIds: children.map(n => n.id) },
    nativeParentId: parent.nativeId, preStateDigest: digest(children), expiresAt: Date.now() + 300000, state: 'intent_prepared',
    generation: scope.generation, nativeResult: 'not_started', replayState: 'not_started' });
  const result = await executeNativeCreate({ scope, store: syncState, api: chrome.bookmarks as PullBookmarkApi, intentId,
    owner: { scopeKey: scopeKey(scope), generation: scope.generation, commandId, eventId: commandId, colpId: node.nodeId, substep: 'restore' },
    parentNativeId: parent.nativeId, expected: { title: node.title, url: node.url }, liveWorkKind: 'create',
    create: async () => { await authorize(); return chrome.bookmarks.create({ parentId: parent.nativeId, title: node.title, url: node.url! }); } });
  if (result.result !== 'applied_with_evidence') throw new Error('sourceNativeResultUnknown');
  const created = (await chrome.bookmarks.get(result.nativeId))[0]; if (!created?.dateAdded || created.parentId !== parent.nativeId) throw new Error('source_reconcile_conflict');
  if (mapping && mapping.nativeId !== created.id) await syncState.deleteMapping(scope, mapping.nativeId);
  await syncState.putMapping(scope, { nativeId: created.id, colpId: node.nodeId, parentNativeId: parent.nativeId, parentColpId: parent.colpId,
    rootNativeId: parent.rootNativeId, nodeKind: 'bookmark', projection: { revision: node.revision, resourceRevision: node.revision,
      digest: digest({ title: node.title, url: node.url }), content: { title: node.title, url: node.url } } });
  await syncState.persistApplyIntentFacts(scope, intentId, { state: 'authority_committed', replayState: 'committed' });
  return created;
}
