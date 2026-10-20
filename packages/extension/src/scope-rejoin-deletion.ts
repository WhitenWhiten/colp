import { assertRejoinBoundary, assertRejoinCanonicalBoundary } from './scope-rejoin-boundary.js';
import { digestJson } from './bookmark-event-codec.js';
import { COLP_QUEUE_STAMP } from './colp-queue-stamp.js';
import { deletionOperationType } from './bookmark-deletion-scope.js';
import { mappedSubtreeDeleteSource } from './subtree-observation.js';
import { isNonChromeNativeId } from './pull-mount-apply.js';
import { rejoinAuthority, remoteFactsDigest, remoteSubtree, snapshotMapping, rejoinBoundaryDigest, rejoinAttemptDigest } from './scope-rejoin-authority.js';
import type { RemoteNodeFact } from './bootstrap/matcher.js';
import type { RejoinOrderInput } from './scope-rejoin-order.js';
import type { MappingInput, RemoteObservationRecord } from './sync-state-store.js';

export interface MissingRejoinGroup {
  readonly root: MappingInput; readonly members: readonly MappingInput[];
  readonly commandId: string; readonly token: string; readonly remoteChanged: boolean;
  readonly remote: readonly RemoteNodeFact[] | undefined;
  readonly authorityDigest: string | null; readonly blockedByLocalMove: boolean; readonly boundaryDigest: string;
}

export async function missingRejoinGroups(input: RejoinOrderInput, mappings: readonly MappingInput[],
  observations: readonly RemoteObservationRecord[]): Promise<MissingRejoinGroup[]> {
  const missing = new Map<string, MappingInput>();
  for (const mapping of mappings) if (mapping.nativeId !== input.mount.nativeRootId
    && !isNonChromeNativeId(mapping.nativeId) && !mapping.colpId.startsWith('pending-')
    && !await input.getNative(mapping.nativeId)) missing.set(mapping.colpId, mapping);
  if (!missing.size) return [];
  const snapshot = await rejoinAuthority(input);
  const byObservation = new Map(observations.map(row => [row.colpId, row]));
  const recorded = await input.store.getScope(input.scope);
  const groups: MissingRejoinGroup[] = [];
  const children = new Map<string, MappingInput[]>();
  const byColp = new Map(mappings.map(row => [row.colpId, row]));
  for (const row of missing.values()) if (row.parentColpId) {
    const siblings = children.get(row.parentColpId) ?? []; siblings.push(row); children.set(row.parentColpId, siblings);
  }
  for (const root of missing.values()) {
    if (root.parentColpId && missing.has(root.parentColpId) || byObservation.get(root.colpId)?.kind === 'tombstone') continue;
    const members = [root];
    for (let index = 0; index < members.length; index++) members.push(...children.get(members[index]!.colpId) ?? []);
    members.sort((left, right) => left.colpId.localeCompare(right.colpId));
    const remote = snapshot ? remoteSubtree(snapshot, root.colpId) : undefined;
    const authorityDigest = remote ? remoteFactsDigest(remote) : null;
    const remoteById = new Map(remote?.map(row => [row.nodeId, row]));
    const remoteChanged = remote ? remote.length !== members.length || members.some(row => {
      const current = remoteById.get(row.colpId);
      return !current || current.revision !== row.projection.revision || current.parentId !== row.parentColpId;
    }) : members.some(row => {
      const observation = byObservation.get(row.colpId);
      return observation && observation.kind !== 'tombstone' && observation.remoteRevision !== row.projection.revision;
    });
    // A child moved out locally must reach the server before deleting its old ancestor.
    let blockedByLocalMove = false;
    for (const fact of remote ?? []) {
      const mapped = byColp.get(fact.nodeId);
      if (mapped && !missing.has(mapped.colpId) && !isNonChromeNativeId(mapped.nativeId)
        && await input.getNative(mapped.nativeId)) blockedByLocalMove = true;
    }
    groups.push({ root, members, remoteChanged, remote, authorityDigest, blockedByLocalMove,
      boundaryDigest: rejoinBoundaryDigest(recorded),
      commandId: `rejoin-delete:${input.mount.mountId}:${root.colpId}:${rejoinAttemptDigest(input.mount, recorded).slice(7, 23)}`,
      token: digestJson({ pause: input.mount.pauseBaseline ? { ...input.mount.pauseBaseline } : null,
        boundaryVersion: recorded?.boundaryVersion ?? null, privateRoots: recorded?.privateRoots ?? [], authorityDigest,
        members: members.map(row => ({ colpId: row.colpId, nativeId: row.nativeId, revision: row.projection.revision,
          remote: snapshot ? null : byObservation.get(row.colpId) ? { ...byObservation.get(row.colpId)! } : null })) }) });
  }
  return groups;
}

export function rejoinDeleteOperationId(group: Pick<MissingRejoinGroup, 'commandId' | 'token'>): string {
  const hex = digestJson({ commandId: group.commandId, token: group.token }).slice(7);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Preserve the missing mappings until receipt/Pull. A rejected delete still has a recoverable preimage. */
export async function stageMissingRejoinDelete(input: RejoinOrderInput, group: MissingRejoinGroup,
  opId = rejoinDeleteOperationId(group)): Promise<string> {
  if (await input.store.getQueueByOpId(input.scope, opId)) return opId;
  if (group.blockedByLocalMove) throw new Error('rejoin_waiting_local_move');
  if (!group.remote) throw new Error('rejoin_remote_order_unavailable');
  await assertRejoinCanonicalBoundary(input, await input.store.listMappings(input.scope), group.members, group.boundaryDigest);
  await assertRejoinBoundary(input, group.root, { expectedBoundary: group.boundaryDigest, allowMissing: true });
  const remoteRoot = group.remote?.find(row => row.nodeId === group.root.colpId);
  const revision = remoteRoot?.revision ?? group.root.projection.revision;
  const mappings = group.remote?.map(row => snapshotMapping(row, input.mount)) ?? group.members;
  if (group.remote && !remoteRoot) throw new Error('preview_stale');
  const payload = { type: deletionOperationType(remoteRoot?.kind ?? group.root.nodeKind), opId,
    targetId: group.root.colpId, baseRevision: revision, occurredAt: new Date().toISOString(), dependencies: [],
    payload: { reason: 'rejoin_local_delete', decisionId: group.commandId, decisionToken: group.token }, source: mappedSubtreeDeleteSource(group.root.colpId, mappings) };
  await input.store.allocateSequenceAndEnqueue(input.scope, { opId, batchId: opId, idempotencyKey: opId,
    digest: digestJson(payload), endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: revision,
    operationRevision: `local-${opId}`, status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload }, COLP_QUEUE_STAMP);
  return opId;
}

export async function reconcileMissingRejoinDeletes(input: RejoinOrderInput, mappings: readonly MappingInput[],
  observations: readonly RemoteObservationRecord[]): Promise<{ applied: number; conflicts: number; handled: ReadonlySet<string> }> {
  let applied = 0; let conflicts = 0; const handled = new Set<string>();
  for (const group of await missingRejoinGroups(input, mappings, observations)) {
    for (const member of group.members) handled.add(member.colpId);
    if (group.members.some(row => row.projection.revision.startsWith('local-'))) { conflicts++; continue; }
    const prior = await input.store.getScopeCommandPlan(input.scope, group.commandId);
    if (prior && prior.phase !== 'pending') { if (prior.phase !== 'active') conflicts++; continue; }
    if (group.remote?.length === 0) {
      for (const member of group.members) await input.store.deleteMapping(input.scope, member.nativeId);
      applied++; continue;
    }
    const needsChoice = !group.remote || group.remoteChanged || group.blockedByLocalMove;
    const dependencies = needsChoice ? [] : [rejoinDeleteOperationId(group)];
    await input.store.putScopeCommandPlan(input.scope, { commandId: group.commandId, kind: 'rejoin',
      confirmationVersion: input.mount.boundaryVersion, baselineDigest: group.token,
      phase: needsChoice ? 'pending' : 'confirmed', dependencies, mountId: input.mount.mountId,
      retryReason: needsChoice ? 'rejoin_local_delete_conflict' : 'delete_remote', updatedAt: Date.now(),
      rejoinDecision: { kind: 'local_delete', rootId: group.root.colpId, title: String(group.root.projection.content?.title ?? ''),
        affectedCount: group.remote?.length ?? group.members.length, authorityDigest: group.authorityDigest, attemptDigest: rejoinAttemptDigest(input.mount, await input.store.getScope(input.scope)),
        boundaryDigest: group.boundaryDigest, missingIds: group.members.map(row => row.colpId),
        unavailable: !group.authorityDigest && needsChoice, blockedByLocalMove: group.blockedByLocalMove } });
    if (!needsChoice) {
      await stageMissingRejoinDelete(input, group);
      const plan = (await input.store.getScopeCommandPlan(input.scope, group.commandId))!;
      const { scopeKey: _key, ...rest } = plan;
      await input.store.putScopeCommandPlan(input.scope, { ...rest, phase: 'applying', updatedAt: Date.now() });
      applied++;
    }
    conflicts++;
  }
  return { applied, conflicts, handled };
}
