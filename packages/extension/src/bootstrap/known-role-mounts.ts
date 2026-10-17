import { digestJson } from '../bookmark-event-codec.js';
import type { JsonObject, SyncScope, createSyncStateStore } from '../sync-state-store.js';
import type { RemoteNodeFact } from './matcher.js';

/** Canonical role identity comes from remote facts, never a configureBrowserRoots UUID. */
export async function bindKnownRoleMounts(store: ReturnType<typeof createSyncStateStore>, scope: SyncScope,
  remote: readonly RemoteNodeFact[], rootNodeId: string | null): Promise<void> {
  if (!rootNodeId) return;
  for (const mount of await store.listMountBindings(scope)) {
    if (!mount.rootRole || mount.status === 'detached') continue;
    const existing = await store.getMappingByNativeId(scope, mount.nativeRootId);
    if (existing && existing.projection.revision !== 'local-root') continue;
    const candidates = remote.filter(row => row.kind === 'folder' && row.folderRole === mount.rootRole && row.parentId === rootNodeId);
    if (candidates.length !== 1) continue;
    const fact = candidates[0]!;
    const content: JsonObject = { title: fact.title, folderRole: mount.rootRole,
      ...(fact.description !== undefined ? { description: fact.description } : {}), ...(fact.tags ? { tags: [...fact.tags] } : {}) };
    await store.bindResolvedMountMapping(scope, { nativeId: mount.nativeRootId, colpId: fact.nodeId,
      rootNativeId: mount.nativeRootId, nodeKind: 'folder', mountId: mount.mountId, rootRole: mount.rootRole,
      parentColpId: rootNodeId,
      projection: { revision: fact.revision, digest: digestJson({ title: fact.title }), contentDigest: digestJson(content),
        content, ...(fact.childrenRevision ? { childrenRevision: fact.childrenRevision } : {}) } });
  }
}
