import { materializeNativeMutation } from './bookmark-native-mutation.js';
import { identityFromMapping } from './bookmark-node-identity.js';
import { deletionNodeKind } from './bookmark-deletion-scope.js';
import { subtreeDeleteSource } from '@know-n/colp/sync/canonical';
import { sha256 } from '@noble/hashes/sha2.js';
import type { BookmarkEventRecord, JsonObject, MappingInput, SyncScope, createSyncStateStore } from './sync-state-store.js';

/** Capture once, before dropping native mappings; never recompute at upload. */
export function mappedSubtreeDeleteSource(rootId: string, mappings: readonly MappingInput[]) {
  const members = capturedSubtreeMembers(rootId, mappings);
  if (members.some(row => /^(pending-|local-)/u.test(row.colpId) || row.revision.startsWith('local-'))) {
    throw new Error('subtree_observation_unavailable');
  }
  return subtreeDeleteSource(rootId, members.map(row => ({ id: row.colpId, revision: row.revision })));
}

export function captureSubtreeDeletion(rootId: string, mappings: readonly MappingInput[]) {
  const members = capturedSubtreeMembers(rootId, mappings);
  const memberIds = members.map(row => row.colpId);
  return members.some(row => /^(pending-|local-)/u.test(row.colpId) || row.revision.startsWith('local-'))
    ? { observation: members as JsonObject[], source: undefined, memberIdsDigest: undefined, memberIds }
    : { observation: undefined, source: subtreeDeleteSource(rootId, members.map(row => ({ id: row.colpId, revision: row.revision }))),
      memberIdsDigest: subtreeMemberIdsDigest(rootId, memberIds), memberIds };
}

/**
 * The subtree observation's canonical digest over the member IDs alone
 * (`{rootId, members: [[id], ...]}`, IDs sorted by code point), as
 * `subtreeMemberIdsDigest()` in `@know-n/colp` 0.2.2 and a `revision_conflict`
 * Problem's `currentSubtree.memberIdsDigest` compute it. Equal digests mean the
 * server still holds exactly the nodes the user deleted; only revisions moved.
 */
export function subtreeMemberIdsDigest(rootId: string, memberIds: readonly string[]): string {
  const ordered = [...memberIds].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const hash = sha256.create(); const encoder = new TextEncoder();
  hash.update(encoder.encode('{"members":['));
  ordered.forEach((id, index) => hash.update(encoder.encode(`${index ? ',' : ''}${JSON.stringify([id])}`)));
  hash.update(encoder.encode(`],"rootId":${JSON.stringify(rootId)}}`));
  let binary = ''; for (const byte of hash.digest()) binary += String.fromCharCode(byte);
  return `sha-256=:${btoa(binary)}:`;
}

function capturedSubtreeMembers(rootId: string, mappings: readonly MappingInput[]) {
  const byNative = new Map(mappings.map(row => [row.nativeId, row.colpId]));
  const children = new Map<string, MappingInput[]>();
  for (const row of mappings) {
    const parent = row.parentColpId ?? (row.parentNativeId ? byNative.get(row.parentNativeId) : undefined);
    if (parent) {
      const siblings = children.get(parent) ?? []; siblings.push(row); children.set(parent, siblings);
    }
  }
  const root = mappings.find(row => row.colpId === rootId);
  if (!root) throw new Error('subtree_observation_unavailable');
  const members: { nativeId: string; colpId: string; revision: string }[] = [];
  const pending = [root]; const seen = new Set<string>();
  while (pending.length) {
    const row = pending.pop()!;
    if (seen.has(row.colpId)) throw new Error('subtree_observation_unavailable');
    seen.add(row.colpId);
    members.push({ nativeId: row.nativeId, colpId: row.colpId, revision: row.projection.revision });
    for (const child of children.get(row.colpId) ?? []) pending.push(child);
  }
  return members;
}

export async function scopeSubtreeDeleteSource(store: ReturnType<typeof createSyncStateStore>, scope: SyncScope,
  rootId: string) {
  return mappedSubtreeDeleteSource(rootId, await remoteSubtreeMappings(store, scope));
}

export async function remoteSubtreeMappings(store: ReturnType<typeof createSyncStateStore>, scope: SyncScope): Promise<MappingInput[]> {
  const header = await store.getRecoveryHeader(scope);
  const rows: MappingInput[] = header?.complete ? (await store.listRecoveryNodes(scope))
    .filter(row => row.snapshotId === header.snapshotId).map(row => ({ ...row.mapping, nodeKind: deletionNodeKind({ snapshotKind: row.kind, mappedKind: row.mapping.nodeKind }),
      ...(row.parentId ? { parentColpId: row.parentId } : {}) })) : await store.listMappings(scope);
  if (!header?.complete) {
    const byId = new Map(rows.map(row => [row.colpId, row]));
    for (const observation of await store.listRemoteObservations(scope)) {
      if (observation.kind === 'tombstone') { byId.delete(observation.colpId); continue; }
      const prior = byId.get(observation.colpId);
      const payload = observation.payload;
      const placement = payload.placement;
      const parentId = typeof payload.parentId === 'string' ? payload.parentId
        : placement && typeof placement === 'object' && !Array.isArray(placement)
          && typeof placement.parentId === 'string' ? placement.parentId : prior?.parentColpId;
      if (prior && !parentId) continue;
      byId.set(observation.colpId, { ...(prior ?? { nativeId: `sidecar:${observation.colpId}`,
        colpId: observation.colpId, rootNativeId: 'remote-observation' }),
      ...(parentId ? { parentColpId: parentId } : {}),
      nodeKind: deletionNodeKind({ mappedKind: prior?.nodeKind, mappedContent: payload }), projection: { ...(prior?.projection ?? { digest: observation.sourceDigest }),
        revision: observation.remoteRevision } });
    }
    return [...byId.values()];
  }
  return rows;
}

/** Include pending local predecessors in the exact subtree the user removed. */
export function capturePendingSubtreeDeletion(rootId: string, mappings: readonly MappingInput[],
  events: readonly BookmarkEventRecord[]) {
  const projected = new Map(mappings.map(row => [row.nativeId, row]));
  for (const event of events) {
    const prior = projected.get(event.nativeId);
    const details = event.details.nativeMutation === true && prior
      ? materializeNativeMutation(event, identityFromMapping(prior)) : event.details;
    if (details.mapping) projected.set(event.nativeId, details.mapping as unknown as MappingInput);
  }
  return captureSubtreeDeletion(rootId, [...projected.values()]);
}
