import { digestJson } from './bookmark-event-codec.js';
import type { CompleteRemoteSnapshot } from './bootstrap/remote-snapshot.js';
import type { RemoteNodeFact } from './bootstrap/matcher.js';
import type { RejoinChrome } from './scope-rejoin-mutation.js';
import type { JsonObject, MappingInput, MountBindingRecord } from './sync-state-store.js';
import type { ScopeRecord } from './sync-state/types.js';

export function rejoinBoundaryDigest(scope: ScopeRecord | null): string {
  return digestJson({ version: scope?.boundaryVersion ?? null,
    selectedRoots: scope?.selectedRoots ?? [], privateRoots: scope?.privateRoots ?? [] });
}
export function rejoinAttemptDigest(mount: MountBindingRecord, scope: ScopeRecord | null): string {
  return digestJson({ pause: mount.pauseBaseline ? { ...mount.pauseBaseline } : null,
    boundary: rejoinBoundaryDigest(scope), nativeRootId: mount.nativeRootId, remoteRootId: mount.remoteMountNodeId });
}
export async function rejoinAuthority(input: RejoinChrome): Promise<CompleteRemoteSnapshot | undefined> {
  return input.readRemoteSnapshot?.();
}
/** One comparison uses one complete cloud view. Confirmation obtains a fresh view. */
export function cachedRejoinAuthority<T extends RejoinChrome>(input: T): T {
  if (!input.readRemoteSnapshot) return input;
  let cached: ReturnType<NonNullable<RejoinChrome['readRemoteSnapshot']>> | undefined;
  return { ...input, readRemoteSnapshot: () => cached ??= input.readRemoteSnapshot!() };
}
export function remoteIndex(snapshot: CompleteRemoteSnapshot) {
  const byId = new Map(snapshot.remoteFacts.map(row => [row.nodeId, row]));
  const children = new Map<string, RemoteNodeFact[]>();
  for (const row of snapshot.remoteFacts) if (row.parentId) {
    const siblings = children.get(row.parentId) ?? [];
    siblings.push(row); children.set(row.parentId, siblings);
  }
  return { byId, children };
}
export function remoteChildren(snapshot: CompleteRemoteSnapshot, parentId: string): RemoteNodeFact[] {
  const index = remoteIndex(snapshot);
  if (!index.byId.get(parentId)?.childrenRevision) throw new Error('rejoin_remote_order_unavailable');
  const children = index.children.get(parentId) ?? [];
  if (children.some(row => typeof row.position !== 'string')
    || new Set(children.map(row => row.position)).size !== children.length) throw new Error('rejoin_remote_order_unavailable');
  return children.sort((left, right) => left.position! < right.position! ? -1 : left.position! > right.position! ? 1 : 0);
}
export function remoteSubtree(snapshot: CompleteRemoteSnapshot, rootId: string): RemoteNodeFact[] {
  const { byId, children } = remoteIndex(snapshot);
  const root = byId.get(rootId);
  if (!root) return [];
  const members = [root]; const seen = new Set([rootId]);
  for (let index = 0; index < members.length; index++) for (const child of children.get(members[index]!.nodeId) ?? []) {
    if (seen.has(child.nodeId)) throw new Error('rejoin_remote_tree_invalid');
    seen.add(child.nodeId); members.push(child);
  }
  return members;
}
export function remoteFactsDigest(facts: readonly RemoteNodeFact[]): string {
  return digestJson(facts.map(row => ({ ...row }) as unknown as JsonObject)
    .sort((left, right) => String(left.nodeId).localeCompare(String(right.nodeId))));
}
export function snapshotMapping(fact: RemoteNodeFact, mount: MountBindingRecord): MappingInput {
  const content: JsonObject = { title: fact.title, ...(fact.url === undefined ? {} : { url: fact.url }),
    ...(fact.description === undefined ? {} : { description: fact.description }),
    ...(fact.tags ? { tags: [...fact.tags] } : {}), ...(fact.extensions ? { extensions: fact.extensions as JsonObject } : {}),
    ...(fact.folderRole ? { folderRole: fact.folderRole } : {}) };
  return { nativeId: `unmounted:${fact.nodeId}`, colpId: fact.nodeId, nodeKind: fact.kind,
    rootNativeId: mount.nativeRootId, mountId: mount.mountId,
    ...(fact.parentId ? { parentColpId: fact.parentId, parentNativeId: `unmounted:${fact.parentId}` } : {}),
    projection: { revision: fact.revision, resourceRevision: fact.revision, digest: digestJson(content), content,
      ...(fact.childrenRevision ? { childrenRevision: fact.childrenRevision } : {}) } };
}
