import { digestJson } from './bookmark-event-codec.js';
import { rejoinAttemptDigest } from './scope-rejoin-authority.js';
import { missingRejoinGroups, rejoinDeleteTitle, type MissingRejoinGroup } from './scope-rejoin-deletion.js';
import { planRejoinOrders, type RejoinOrderInput, type RejoinOrderPlan } from './scope-rejoin-order.js';
import { rejectedRejoinReferences } from './sync-state/rejoin-resolution-repository.js';
import type { JsonObject, QueueOperation, ScopeCommandPlanRecord } from './sync-state-store.js';

export function retryRejoinCandidate<T extends MissingRejoinGroup | RejoinOrderPlan>(candidate: T,
  record: ScopeCommandPlanRecord): T {
  const references = rejectedRejoinReferences(record);
  return references.length ? { ...candidate, commandId: record.commandId,
    token: digestJson({ preview: candidate.token, rejected: references.map(row => ({ ...row })) }) }
    : { ...candidate, commandId: record.commandId };
}

/** A new browser/cloud order after confirmation requires a fresh visible choice, preserving the prior attempt. */
export async function renewChangedRejoinOrder(input: RejoinOrderInput, record: ScopeCommandPlanRecord): Promise<boolean> {
  const mappings = await input.store.listMappings(input.scope);
  const observations = await input.store.listRemoteObservations(input.scope);
  const candidate = (await planRejoinOrders(input, mappings, observations, String(record.rejoinDecision?.parentId)))
    .find(row => row.parent.colpId === record.rejoinDecision?.parentId);
  if (!candidate) return false;
  const token = retryRejoinCandidate(candidate, record).token;
  const attempt = rejoinAttemptDigest(input.mount, await input.store.getScope(input.scope));
  const commandId = `rejoin-order:${input.mount.mountId}:${candidate.parent.colpId}:${attempt.slice(7, 23)}:compare:${digestJson({ prior: record.commandId, preview: token }).slice(7, 23)}`;
  if (!await input.store.getScopeCommandPlan(input.scope, commandId)) await input.store.putScopeCommandPlan(input.scope, {
    commandId, kind: 'rejoin', phase: 'pending', confirmationVersion: input.mount.boundaryVersion,
    baselineDigest: token, dependencies: [], mountId: input.mount.mountId, retryReason: 'rejoin_order_changed', updatedAt: Date.now(),
    rejoinDecision: { ...rejoinCandidateFields(candidate), authorityDigest: candidate.authorityDigest,
      boundaryDigest: candidate.boundaryDigest, attemptDigest: attempt, retryOf: record.commandId,
      rejectedReferences: rejectedRejoinReferences(record).map(row => ({ ...row })) },
  });
  const { scopeKey: _key, ...old } = record;
  await input.store.putScopeCommandPlan(input.scope, { ...old, phase: 'failed', retryReason: 'rejoin_order_changed',
    rejoinDecision: { ...old.rejoinDecision, supersededBy: commandId }, updatedAt: Date.now() });
  return true;
}

/** Wait for every original operation, then expose one new choice over the current complete authority. */
export async function renewRejectedRejoin(input: RejoinOrderInput, record: ScopeCommandPlanRecord,
  rows: readonly (QueueOperation | null)[]): Promise<boolean> {
  if (rows.some(row => !row || !['terminal', 'rejected'].includes(row.status))) return false;
  const rejected = rows.filter((row): row is QueueOperation => !!row
    && (row.status === 'rejected' || row.recovery?.resultStatus === 'rejected'));
  if (!rejected.length) return false;
  const references = [...new Map([...rejectedRejoinReferences(record), ...rejected.map(row =>
    ({ opId: row.opId, sequence: row.sequence, digest: row.digest }))].map(row => [row.opId, row])).values()];
  const mappings = await input.store.listMappings(input.scope);
  const observations = await input.store.listRemoteObservations(input.scope);
  const localDelete = record.rejoinDecision?.kind === 'local_delete';
  const candidate = localDelete ? (await missingRejoinGroups(input, mappings, observations))
    .find(row => row.root.colpId === record.rejoinDecision?.rootId)
    : (await planRejoinOrders(input, mappings, observations, String(record.rejoinDecision?.parentId)))
      .find(row => row.parent.colpId === record.rejoinDecision?.parentId);
  if (!candidate) return false;
  const attempt = rejoinAttemptDigest(input.mount, await input.store.getScope(input.scope));
  const subject = localDelete ? record.rejoinDecision?.rootId : record.rejoinDecision?.parentId;
  const commandId = `rejoin-${localDelete ? 'delete' : 'order'}:${input.mount.mountId}:${subject}:${attempt.slice(7, 23)}:retry:${digestJson(references.map(row => ({ ...row }))).slice(7, 23)}`;
  const token = digestJson({ preview: candidate.token, rejected: references.map(row => ({ ...row })) });
  const kindFields = rejoinCandidateFields(candidate);
  const prior = await input.store.getScopeCommandPlan(input.scope, commandId);
  if (!prior) await input.store.putScopeCommandPlan(input.scope, { commandId, kind: 'rejoin', phase: 'pending',
    confirmationVersion: input.mount.boundaryVersion, baselineDigest: token, dependencies: [], mountId: input.mount.mountId,
    retryReason: 'rejoin_upload_rejected', updatedAt: Date.now(), rejoinDecision: { ...kindFields,
      authorityDigest: candidate.authorityDigest, boundaryDigest: candidate.boundaryDigest, attemptDigest: attempt,
      rejectedReferences: references.map(row => ({ ...row })), retryOf: record.commandId } });
  const { scopeKey: _key, ...old } = record;
  await input.store.putScopeCommandPlan(input.scope, { ...old, phase: 'failed', retryReason: 'rejoin_upload_rejected',
    rejoinDecision: { ...old.rejoinDecision, supersededBy: commandId }, updatedAt: Date.now() });
  return true;
}
export function rejoinCandidateFields(candidate: MissingRejoinGroup | RejoinOrderPlan): JsonObject {
  return 'root' in candidate ? {
    kind: 'local_delete', rootId: candidate.root.colpId, title: rejoinDeleteTitle(candidate),
    affectedCount: candidate.remote?.length ?? candidate.members.length, missingIds: candidate.members.map(row => row.colpId),
    blockedByLocalMove: candidate.blockedByLocalMove, unavailable: !candidate.remote,
  } : { kind: 'order', parentId: candidate.parent.colpId, title: String(candidate.parent.projection.content?.title ?? ''),
    affectedCount: candidate.local.length, localOrder: [...candidate.local], remoteOrder: [...candidate.remote],
    baseline: [...candidate.baseline], childrenRevision: candidate.childrenRevision ?? null };
}
