import { bookmarkKind, digestJson, isDescendant, nodeContent } from './bookmark-event-codec.js';
import { identityFromCreateReceipt, inFlightCreateEvidence, plannedCreateOpIdForNative } from './bookmark-create-receipt-identity.js';
import {
  authoritativeColpId, classifyObservedNative, identityFromMapping, type FirstRunPhase, type NodeIdentity,
} from './bookmark-node-identity.js';
import { virtualNativeId } from './projection-native-occupancy.js';
import { freezeScopeRecovery } from './pull-recovery-freeze.js';
import { resolveIngressBoundary } from './bookmark-event-ingress.js';
import { nativeIsLocallyExcluded } from './remote-delete-exclusion.js';
import { lookupBookmark } from './bookmark-api-error.js';
import type { BookmarkEventNode } from './bookmark-event-codec.js';
import type { BookmarkEventRecord, MappingInput, SyncScope, createSyncStateStore } from './sync-state-store.js';

type Store = ReturnType<typeof createSyncStateStore>;

export type ReconcileHost = {
  readonly store: Store; readonly scope: SyncScope;
  identityFor(nativeId: string): Promise<NodeIdentity | null>;
  created(nativeId: string, node: BookmarkEventNode): Promise<unknown>;
  changed(nativeId: string, changes: { readonly title?: string; readonly url?: string }): Promise<unknown>;
  moved(nativeId: string, move: { readonly parentId: string; readonly index: number;
    readonly oldParentId: string; readonly oldIndex: number }): Promise<unknown>;
  stageDelete(nativeId: string, identity: NodeIdentity, subtree: boolean,
    deleteNativeIds: readonly string[]): Promise<unknown>;
  readChildren(parentNativeId: string): Promise<readonly BookmarkEventNode[]>;
  readNode(nativeId: string): Promise<readonly BookmarkEventNode[]>;
  listPendingEvents(): Promise<readonly BookmarkEventRecord[]>;
};

export async function reconcileBookmarkTree(host: ReconcileHost): Promise<void> {
  const scope = await host.store.getScope(host.scope); if (!scope
    || (scope.rootStatus !== 'ready' && scope.rootStatus !== 'nested_normalized')) return;
  const engine = await host.store.getEngineState(host.scope);
  const mutateMapped = engine?.recoveryFrozen !== true
    && engine?.phase !== 'pulling' && engine?.phase !== 'applying'
    && engine?.phase !== 'bootstrap' && engine?.phase !== 'recovery';
  const boundary = await resolveIngressBoundary(host.store, host.scope);
  const mappings = await host.store.listMappings(host.scope);
  const selectedNative = [...boundary.selectedNative];
  const privateNative = boundary.privateNative;
  const pendingEvents = await host.listPendingEvents();
  const seen = new Set<string>(selectedNative);
  const visit = async (parentNativeId: string, ancestors: readonly string[] = []) => {
    const children = await host.readChildren(parentNativeId);
    const chain = parentNativeId ? [...ancestors, parentNativeId] : [...ancestors];
    for (const node of children) {
      if (privateNative.has(node.id)) continue;
      seen.add(node.id);
      if (!await nativeIsLocallyExcluded(host.store, host.scope, node.id, chain)) {
        const identity = await recoverObservedNative(host, {
          node, parentNativeId, generation: scope.generation, firstRun: scope.firstRun, pendingEvents, ancestors: chain,
        });
        if (identity && mutateMapped) await reconcileMapped(host, node, parentNativeId, identity);
      }
      if (bookmarkKind(node) === 'folder') await visit(node.id, chain);
    }
  };
  for (const root of selectedNative) await visit(root);
  if (!mutateMapped) return;
  const missing = mappings.filter((mapping) => selectedNative.includes(mapping.rootNativeId)
    && !selectedNative.includes(mapping.nativeId) && !privateNative.has(mapping.nativeId)
    && !seen.has(mapping.nativeId) && !virtualNativeId(mapping.nativeId));
  const missingIds = new Set(missing.map((mapping) => mapping.nativeId));
  for (const mapping of missing) {
    if (mapping.parentNativeId && missingIds.has(mapping.parentNativeId)) continue;
    const mappingParentChain = mappingParentNativeChain(mapping, mappings);
    if (await nativeIsLocallyExcluded(host.store, host.scope, mapping.nativeId, mappingParentChain)) continue;
    // A sequence of getChildren calls is not a tree snapshot. Only a direct
    // negative lookup proves this native identity was deleted. Present nodes
    // may have moved behind the scan, including across privacy boundaries;
    // leave their move callback / next scan to reconcile placement safely.
    const looked = await lookupBookmark(id => host.readNode(id), mapping.nativeId);
    if (looked.class === 'present') continue;
    if (looked.class !== 'not_found') throw new Error(looked.message);
    const descendants = missing.filter((candidate) => isDescendant(candidate, mapping.nativeId, missing))
      .map((item) => item.nativeId);
    const identity = await host.identityFor(mapping.nativeId); if (!identity) continue;
    await host.stageDelete(mapping.nativeId, identity, mapping.nodeKind === 'folder',
      [mapping.nativeId, ...descendants]);
  }
}

async function recoverObservedNative(host: ReconcileHost, input: {
  readonly node: BookmarkEventNode; readonly parentNativeId: string; readonly generation: number;
  readonly firstRun?: FirstRunPhase; readonly pendingEvents: readonly BookmarkEventRecord[];
  readonly ancestors: readonly string[];
}): Promise<NodeIdentity | null> {
  const nativeId = input.node.id;
  if (await nativeIsLocallyExcluded(host.store, host.scope, nativeId, input.ancestors)) return null;
  const live = await host.identityFor(nativeId);
  const mapping = live && authoritativeColpId(live.colpId) ? live : null;
  const pendingCreate = pendingCreateEvidence(nativeId, input.pendingEvents, live)
    ?? (mapping ? null : await inFlightCreateEvidence(host.store, host.scope, nativeId));
  const receiptIdentity = mapping || pendingCreate ? null
    : await identityFromCreateReceipt(host.store, host.scope, nativeId);
  const bootstrapCreateOpId = mapping || pendingCreate || receiptIdentity ? null
    : await plannedCreateOpIdForNative(host.store, host.scope, nativeId);
  const classified = classifyObservedNative({
    generation: input.generation, firstRun: input.firstRun, mapping, pendingCreate, receiptIdentity,
    bootstrapCreateOpId, underSelectedMount: true,
  });
  if (classified.kind === 'mapped') return classified.identity;
  if (classified.kind === 'pending_create') return classified.identity;
  if (classified.kind === 'receipt_unbound') {
    await bindReceiptMapping(host.store, host.scope, classified.identity); return classified.identity;
  }
  if (classified.kind === 'new_local') {
    if ((await host.store.getEngineState(host.scope))?.recoveryFrozen) return null;
    await host.created(nativeId, input.node); return host.identityFor(nativeId);
  }
  if (classified.kind === 'needs_attention') {
    await freezeScopeRecovery(host.store, host.scope, 'recovery_identity_unproven');
  }
  return null;
}

async function reconcileMapped(host: ReconcileHost, node: BookmarkEventNode, parentNativeId: string,
  identity: NodeIdentity): Promise<void> {
  if (identity.parentNativeId && identity.parentNativeId !== parentNativeId) {
    await host.moved(node.id, { parentId: parentNativeId, index: node.index ?? 0,
      oldParentId: identity.parentNativeId, oldIndex: 0 });
  }
  const content = nodeContent(node);
  if (identity.content && digestJson(content) !== digestJson(identity.content)) {
    const changes: { title?: string; url?: string } = {};
    if (typeof content.title === 'string' && content.title !== identity.content.title) changes.title = content.title;
    if (typeof content.url === 'string' && content.url !== identity.content.url) changes.url = content.url;
    if (Object.keys(changes).length) await host.changed(node.id, changes);
  }
}

function mappingParentNativeChain(mapping: MappingInput, live: readonly MappingInput[]): string[] {
  const byNative = new Map(live.map((row) => [row.nativeId, row]));
  const chain: string[] = []; const walked = new Set<string>();
  let parent = mapping.parentNativeId;
  while (parent) {
    if (walked.has(parent)) break;
    walked.add(parent); chain.push(parent);
    parent = byNative.get(parent)?.parentNativeId;
  }
  return chain;
}

function pendingCreateEvidence(nativeId: string, events: readonly BookmarkEventRecord[],
  live: NodeIdentity | null): { readonly eventId: string; readonly identity: NodeIdentity } | null {
  const event = events.find((row) => row.nativeId === nativeId && row.kind === 'create' && row.status === 'pending'
    && row.details.mapping !== undefined);
  if (event?.details.mapping) {
    return { eventId: event.eventId, identity: identityFromMapping(event.details.mapping as unknown as MappingInput) };
  }
  if (live && live.colpId.startsWith('pending-')) {
    return { eventId: live.colpId.slice('pending-'.length), identity: live };
  }
  return null;
}

export async function bindReceiptMapping(store: Store, scope: SyncScope, identity: NodeIdentity): Promise<boolean> {
  const existingNative = await store.getMappingByNativeId(scope, identity.nativeId);
  const existingColp = await store.getMappingByColpId(scope, identity.colpId);
  if (existingNative && existingNative.colpId !== identity.colpId) return false;
  if (existingColp && existingColp.nativeId !== identity.nativeId) return false;
  if (existingNative && existingNative.colpId === identity.colpId) return true;
  await store.putMapping(scope, {
    nativeId: identity.nativeId, colpId: identity.colpId, rootNativeId: identity.rootNativeId,
    ...(identity.nodeKind ? { nodeKind: identity.nodeKind } : {}),
    ...(identity.parentNativeId ? { parentNativeId: identity.parentNativeId } : {}),
    projection: { revision: identity.revision,
      ...(identity.childrenRevision ? { childrenRevision: identity.childrenRevision } : {}),
      digest: identity.content ? digestJson(identity.content) : digestJson({ nativeId: identity.nativeId }),
      ...(identity.content ? { content: identity.content } : {}) },
  });
  return true;
}
