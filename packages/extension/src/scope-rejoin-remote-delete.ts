import { digestJson } from './bookmark-event-codec.js';
import { assertRejoinBoundary, assertRejoinCanonicalBoundary } from './scope-rejoin-boundary.js';
import { rejoinAuthority, rejoinAttemptDigest, rejoinBoundaryDigest } from './scope-rejoin-authority.js';
import { rejoinMutationAuthority, rejoinNativeDigest, type RejoinNative } from './scope-rejoin-mutation.js';
import { isNonChromeNativeId } from './pull-mount-apply.js';
import { remoteDescendantIds } from './scope-rejoin-members.js';
import { remoteDeleteEvidence, remoteDeleteMemberIntentId, remoteDeleteReviewPrefix, type RejoinRemoteDeleteEvidence,
  type RejoinRemoteDeleteMember } from './sync-state/rejoin-decision-repository.js';
import type { RejoinQueueReference } from './sync-state/rejoin-queue-resolution.js';
import type { RejoinOrderInput } from './scope-rejoin-order.js';
import type { RejoinDecisionBlockedReason } from './scope-rejoin-decisions.js';
import type { JsonObject, MappingInput, QueueOperation, ScopeCommandPlanRecord } from './sync-state-store.js';

export interface RemoteRejoinDeleteCandidate {
  readonly root: MappingInput; readonly commandId: string; readonly token: string;
  readonly attemptDigest: string; readonly boundaryDigest: string; readonly affectedCount: number;
  readonly blockedReason?: RejoinDecisionBlockedReason; readonly rejectedReferences: readonly RejoinQueueReference[];
  readonly evidence: RejoinRemoteDeleteEvidence;
}

/** Freeze the entire live subtree, including children that never acquired a
 * cloud identity. Missing mapped descendants remain exact cleanup evidence. */
export async function remoteRejoinDeleteCandidate(input: RejoinOrderInput, root: MappingInput): Promise<RemoteRejoinDeleteCandidate> {
  const boundary = await input.store.readRejoinDeletionBoundary(input.scope);
  const authority = await rejoinMutationAuthority(input, root);
  const mappings = await input.store.listMappings(input.scope), byNative = new Map(mappings.map(row => [row.nativeId, row]));
  const members: RejoinRemoteDeleteMember[] = [], ids = [root.nativeId], seen = new Set<string>();
  let blockedReason: RejoinDecisionBlockedReason | undefined;
  for (let index = 0; index < ids.length; index++) {
    const nativeId = ids[index]!;
    if (seen.has(nativeId)) throw new Error('rejoin_boundary_changed');
    seen.add(nativeId);
    const native = await input.getNative(nativeId), mapping = byNative.get(nativeId) ?? null;
    const folder = native && native.url === undefined && native.type !== 'separator';
    const children = folder && input.getChildren ? (await input.getChildren(nativeId)).map(row => row.id) : null;
    if (native?.unmodifiable || native?.folderType || folder && !input.getChildren) blockedReason = 'native_unavailable';
    members.push({ nativeId, native: native ? nativeFact(native) : null, mapping, children });
    if (children) ids.push(...children);
  }
  const descendants = remoteDescendantIds(mappings, root.colpId);
  for (const mapping of mappings) if (descendants.has(mapping.colpId) && !seen.has(mapping.nativeId)
    && !isNonChromeNativeId(mapping.nativeId) && !await input.getNative(mapping.nativeId)) {
    members.push({ nativeId: mapping.nativeId, native: null, mapping, children: null }); seen.add(mapping.nativeId);
  }
  const selected = members.flatMap(row => row.mapping ? [row.mapping] : []);
  try {
    await assertRejoinCanonicalBoundary(input, mappings, selected, authority.boundaryDigest);
    await assertRejoinBoundary(input, root, { expectedBoundary: authority.boundaryDigest, allowMissing: true });
  } catch (error) {
    if (!(error instanceof Error) || !['rejoin_boundary_changed', 'rejoin_parent_missing'].includes(error.message)) throw error;
    blockedReason = 'upload_boundary_changed';
  }
  const excluded = new Set((await input.store.listLocalSyncExclusions(input.scope)).map(row => row.nativeId));
  if (members.some(row => excluded.has(row.nativeId))) blockedReason = 'upload_boundary_changed';
  const snapshot = await rejoinAuthority(input), remote = new Set(snapshot?.remoteFacts.map(row => row.nodeId));
  if (!snapshot || !remote.has(input.mount.remoteMountNodeId!) || selected.some(row => remote.has(row.colpId))) {
    blockedReason ??= 'native_unavailable';
  }
  const work = await deletionWork(input, selected, members);
  blockedReason ??= work.blockedReason;
  const recorded = await input.store.getScope(input.scope), attemptDigest = rejoinAttemptDigest(input.mount, recorded);
  const boundaryDigest = rejoinBoundaryDigest(recorded);
  const evidence: RejoinRemoteDeleteEvidence = { authority: { ...authority, deletion: {
    boundary, members: selected, unmappedNativeIds: members.filter(row => !row.mapping).map(row => row.nativeId),
  } }, members };
  // Queue cursors alone are not authority: unrelated later work must not
  // invalidate this choice. Only this subtree's exact work enters its token.
  const token = digestJson({ attemptDigest, boundaryDigest, members: members as unknown as JsonObject[],
    parents: authority.parents as unknown as JsonObject[],
    exclusionDigest: boundary.exclusionDigest, policyVersion: boundary.policyVersion,
    work: work.fingerprint, blockedReason: blockedReason ?? null });
  const commandId = `${remoteDeleteReviewPrefix(input.mount.mountId, root.colpId, attemptDigest)}${token.slice(7, 23)}`;
  return { root, commandId, token, attemptDigest, boundaryDigest, evidence,
    affectedCount: members.filter(row => row.native).length, rejectedReferences: work.rejectedReferences,
    ...(blockedReason ? { blockedReason } : {}) };
}

async function deletionWork(input: RejoinOrderInput, mappings: readonly MappingInput[], members: readonly RejoinRemoteDeleteMember[]) {
  const colpIds = new Set(mappings.map(row => row.colpId)), nativeIds = new Set(members.map(row => row.nativeId));
  const rejectedReferences: RejoinQueueReference[] = [], fingerprint: JsonObject[] = [];
  let blockedReason: RejoinDecisionBlockedReason | undefined;
  for (let after = 0;;) {
    const page = await input.store.listQueue(input.scope, undefined, after, 1_000);
    const relevant = page.filter(row => {
      const inner = row.payload.payload as JsonObject | undefined;
      return [row.payload.targetId, inner?.parentId, inner?.newParentId].some(id => typeof id === 'string' && colpIds.has(id));
    });
    for (const row of await input.store.filterResolvedQueueIssues(input.scope, relevant)) {
      if (row.echoApplied) continue;
      const reference = { opId: row.opId, sequence: row.sequence, digest: row.digest };
      const receipt = row.status === 'terminal' ? await input.store.getQueueReceipt(input.scope, row.sequence) : null;
      const results = receipt?.result?.results;
      const terminal = receipt?.kind === 'terminal' && receipt.opId === row.opId && receipt.operationDigest === row.digest;
      const rejected = terminal && Array.isArray(results) && results.some(value => value && typeof value === 'object'
        && !Array.isArray(value) && value.opId === row.opId && value.status === 'rejected');
      fingerprint.push({ ...reference, status: row.status, code: row.recovery?.code ?? null });
      if (rejected) rejectedReferences.push(reference);
      else {
        const reason = queueBlock(row);
        if (!blockedReason || blockPriority(reason) > blockPriority(blockedReason)) blockedReason = reason;
      }
    }
    if (page.length < 1_000) break;
    after = page.at(-1)!.sequence;
  }
  for (let after = 0;;) {
    const page = await input.store.listBookmarkEventsByStatus(input.scope, 'pending', after, 1_000);
    for (const event of page) if ([event.nativeId, event.details.parentId, event.details.oldParentId]
      .some(id => typeof id === 'string' && nativeIds.has(id))) {
      blockedReason ??= 'pending_upload'; fingerprint.push({ eventId: event.eventId, ordinal: event.ordinal, digest: digestJson(event.details) });
    }
    if (page.length < 1_000) break;
    after = page.at(-1)!.ordinal;
  }
  return { blockedReason, rejectedReferences, fingerprint };
}
const blockPriority = (reason: RejoinDecisionBlockedReason) =>
  ['native_unavailable', 'pending_upload', 'unknown_upload', 'upload_boundary_changed'].indexOf(reason);
function queueBlock(row: QueueOperation): RejoinDecisionBlockedReason {
  if (['queued_upload_excluded', 'upload_boundary_unavailable', 'metadata_sync_disabled'].includes(row.recovery?.code ?? '')
    || row.status === 'rejected' || row.status === 'set_aside') return 'upload_boundary_changed';
  return row.attempt && row.status !== 'terminal' ? 'unknown_upload' : 'pending_upload';
}

/** Preserve superseded accepted evidence; the next preview needs a fresh
 * explicit choice and can never silently inherit permission to delete. */
export async function stageRemoteRejoinDelete(input: RejoinOrderInput, candidate: RemoteRejoinDeleteCandidate): Promise<void> {
  await input.store.stageRejoinRemoteDelete(input.scope, { commandId: candidate.commandId, kind: 'rejoin',
    confirmationVersion: input.mount.boundaryVersion, baselineDigest: candidate.token, phase: 'pending', dependencies: [],
    mountId: input.mount.mountId, retryReason: 'remote_delete_confirmation_required', updatedAt: Date.now(),
    rejoinDecision: { kind: 'remote_delete', rootId: candidate.root.colpId,
      title: candidate.evidence.members[0]!.native?.title ?? String(candidate.root.projection.content?.title ?? ''),
      affectedCount: candidate.affectedCount, attemptDigest: candidate.attemptDigest, boundaryDigest: candidate.boundaryDigest,
      rejectedReferences: candidate.rejectedReferences as unknown as JsonObject[],
      remoteDeletion: JSON.parse(JSON.stringify(candidate.evidence)) as JsonObject,
      ...(candidate.blockedReason ? { blockedReason: candidate.blockedReason } : {}) } });
}

export async function resumeRemoteRejoinDelete(input: RejoinOrderInput, plan: ScopeCommandPlanRecord): Promise<void> {
  const evidence = remoteDeleteEvidence(plan), root = evidence.authority.before;
  const snapshot = await rejoinAuthority(input);
  const remote = new Set(snapshot?.remoteFacts.map(row => row.nodeId));
  if (!snapshot || !remote.has(input.mount.remoteMountNodeId!) || evidence.members.some(row => row.mapping && remote.has(row.mapping.colpId))) {
    throw new Error('preview_stale');
  }
  const decision = { commandId: plan.commandId, token: plan.baselineDigest!, choice: plan.retryReason! };
  const authority = { ...evidence.authority, decision };
  if (plan.phase === 'confirmed') {
    const { scopeKey: _key, ...value } = plan;
    await input.store.putScopeCommandPlan(input.scope, { ...value, phase: 'applying', updatedAt: Date.now() });
  }
  if (plan.retryReason === 'keep_local') {
    await assertRemoteDeleteTree(input, evidence, new Set());
    await assertRejoinBoundary(input, root, { expectedBoundary: authority.boundaryDigest, allowMissing: true });
    await input.store.assertRejoinMutation(input.scope, authority);
    await assertRemoteDeleteTree(input, evidence, new Set());
  } else {
    if (!input.removeNative) throw new Error('rejoin_parent_missing');
    const removed = new Set<string>();
    for (const member of evidence.members) {
      const intent = await input.store.getApplyIntent(input.scope, remoteDeleteMemberIntentId(plan.commandId, plan.baselineDigest!, member.nativeId));
      if (intent && !await input.getNative(member.nativeId)) removed.add(member.nativeId);
    }
    await assertRemoteDeleteTree(input, evidence, removed);
    for (const member of [...evidence.members].reverse()) {
      const intentId = remoteDeleteMemberIntentId(plan.commandId, plan.baselineDigest!, member.nativeId);
      if (!await input.store.getApplyIntent(input.scope, intentId)) await input.store.createApplyIntent(input.scope, {
        intentId, correlationId: intentId, operationId: intentId, expected: { kind: 'remove', nativeId: member.nativeId },
        commandId: plan.commandId, liveWorkKind: 'rejoin', nativeTargetId: member.nativeId,
        ...(member.mapping ? { colpId: member.mapping.colpId } : {}), generation: input.scope.generation,
        state: 'browser_call_started', expiresAt: Date.now() + 300_000,
        preStateDigest: digestJson(member.native as unknown as JsonObject | null),
      });
      input.crash?.('after_rejoin_remote_delete_intent');
      const current = await input.getNative(member.nativeId);
      const single = { ...authority, deletion: { boundary: authority.deletion!.boundary,
        members: member.mapping ? [member.mapping] : [], unmappedNativeIds: member.mapping ? [] : [member.nativeId] } };
      if (current) {
        await assertRejoinBoundary(input, root, { expectedBoundary: authority.boundaryDigest, parentNativeId: member.nativeId });
        await input.store.assertRejoinMutation(input.scope, single);
        await assertRemoteDeleteTree(input, { ...evidence, members: [member] }, removed);
        await input.store.assertRejoinMutation(input.scope, single);
        // The durable CAS above can itself yield to a browser edit. Re-read
        // the authorized member immediately before the nonrecursive call.
        await assertRemoteDeleteTree(input, { ...evidence, members: [member] }, removed);
        try { await input.removeNative(member.nativeId, false); }
        catch (error) {
          let hasChildren = false;
          if (member.children && input.getChildren) {
            try { hasChildren = (await input.getChildren(member.nativeId)).length > 0; } catch { throw error; }
          }
          if (hasChildren) throw new Error('rejoin_boundary_changed');
          throw error;
        }
        input.crash?.('after_rejoin_remote_delete_native');
      }
      if (await input.getNative(member.nativeId)) throw new Error('rejoin_boundary_changed');
      await input.store.persistApplyIntentFacts(input.scope, intentId, { state: 'page_complete',
        nativeResult: current ? 'applied_with_evidence' : 'absent',
        nativeResultConfirmation: { kind: current ? 'api_return' : 'absent', nativeId: member.nativeId } });
      removed.add(member.nativeId);
    }
    await assertRemoteDeleteTree(input, evidence, removed);
    await assertRejoinBoundary(input, root, { expectedBoundary: authority.boundaryDigest, allowMissing: true });
  }
  await input.store.completeRejoinRemoteDelete(input.scope, plan.commandId, plan.baselineDigest!);
}

async function assertRemoteDeleteTree(input: RejoinOrderInput, evidence: RejoinRemoteDeleteEvidence, removed: ReadonlySet<string>) {
  for (const member of evidence.members) {
    const native = await input.getNative(member.nativeId);
    if (removed.has(member.nativeId) || !member.native) {
      if (native) throw new Error('rejoin_boundary_changed');
      continue;
    }
    if (!native || rejoinNativeDigest(native) !== rejoinNativeDigest(member.native)) throw new Error('rejoin_boundary_changed');
    if (member.children) {
      if (!input.getChildren) throw new Error('rejoin_boundary_changed');
      const children = (await input.getChildren(member.nativeId)).map(row => row.id), expected = member.children.filter(id => !removed.has(id));
      if (children.length !== expected.length || children.some((id, index) => id !== expected[index])) throw new Error('rejoin_boundary_changed');
    }
  }
}
function nativeFact(native: RejoinNative): RejoinNative {
  return Object.fromEntries(['title', 'url', 'parentId', 'index', 'type', 'unmodifiable', 'folderType']
    .flatMap(key => native[key as keyof RejoinNative] === undefined ? [] : [[key, native[key as keyof RejoinNative]]]));
}
