import { digestJson } from '../bookmark-event-codec.js';
import { deletionOperationType, type DeletionNodeKind } from '../bookmark-deletion-scope.js';
import { COLP_QUEUE_STAMP } from '../colp-queue-stamp.js';
import { mintRemoteDeleteConfirmation } from '../scope-commands.js';
import { remoteSubtreeMappings } from '../subtree-observation.js';
import type { JsonObject, ScopePreviewRecord, SyncScope } from '../sync-state-store.js';
import { syncState } from './runtime.js';

export interface FrozenRangeDeletion {
  readonly nativeId: string; readonly mountId: string; readonly evidenceDigest: string;
  readonly occurredAt: string; readonly baseRevision?: string; readonly kind?: DeletionNodeKind;
}

/** The consumed preview already owns the full frozen subtree evidence. Keep a
 * verified reference in the command, so large role-folder deletes do not copy
 * hundreds of operations into a second size-limited IndexedDB record. */
export async function freezeRangeDeletions(scope: SyncScope, preview: ScopePreviewRecord,
  nativeIds: readonly string[]): Promise<FrozenRangeDeletion[]> {
  if (!nativeIds.length) return [];
  const facts = new Map((await remoteSubtreeMappings(syncState, scope)).map(row => [row.colpId, row]));
  const occurredAt = new Date().toISOString();
  return nativeIds.map(nativeId => {
    const frozen = preview.remoteDeleteEvidence?.find(row => row.nativeRootId === nativeId);
    if (!frozen?.subtreeSource) throw new Error('preview_stale');
    const root = facts.get(frozen.remoteMountNodeId);
    if (!frozen.contentDeletes && !root) throw new Error('preview_stale');
    return { nativeId, mountId: frozen.mountId, evidenceDigest: digestJson(frozen as unknown as JsonObject), occurredAt,
      ...(!frozen.contentDeletes && root ? { baseRevision: root.projection.revision,
        ...(root.nodeKind ? { kind: root.nodeKind } : {}) } : {}) };
  });
}

export async function enqueueRangeDeletion(scope: SyncScope, preview: ScopePreviewRecord,
  deletion: FrozenRangeDeletion, assertCurrent: () => Promise<void>): Promise<void> {
  const frozen = preview.remoteDeleteEvidence?.find(row => row.nativeRootId === deletion.nativeId);
  if (!frozen?.subtreeSource || frozen.mountId !== deletion.mountId
      || digestJson(frozen as unknown as JsonObject) !== deletion.evidenceDigest) throw new Error('preview_stale');
  const targets = frozen.contentDeletes ?? (deletion.baseRevision ? [{ targetId: frozen.remoteMountNodeId,
    baseRevision: deletion.baseRevision, kind: deletion.kind, source: frozen.subtreeSource }] : []);
  if (!targets.length) return;
  const operationId = (targetId: string) => `range.private.${digestJson([preview.previewId, targetId]).slice(7)}`;
  if (!frozen.contentDeletes && !frozen.mountId.startsWith('excluded:')) {
    await assertCurrent();
    await syncState.planRemoteDelete(scope, { mountId: frozen.mountId,
      confirmationToken: mintRemoteDeleteConfirmation(frozen), affectedCount: frozen.affectedCount,
      opId: operationId(targets[0]!.targetId) });
  }
  for (const target of targets) {
    const opId = operationId(target.targetId);
    const payload: JsonObject = { type: deletionOperationType(target.kind), opId, targetId: target.targetId,
      baseRevision: target.baseRevision, occurredAt: deletion.occurredAt, dependencies: [],
      payload: { reason: 'scope_remote_delete' }, source: target.source };
    const digest = digestJson(payload);
    const prior = await syncState.getQueueByOpId(scope, opId);
    if (prior) {
      const expected = digestJson({ ...payload, replicaId: scope.replicaId, sequence: prior.sequence,
        collectionId: scope.collectionId });
      if (prior.digest !== expected) throw new Error('confirmation_conflict');
      continue;
    }
    await assertCurrent();
    await syncState.allocateSequenceAndEnqueue(scope, { opId, batchId: opId,
      idempotencyKey: opId, digest, endpointIdentity: 'syncPush', mediaType: 'application/json',
      baseRevision: target.baseRevision, operationRevision: `local-${opId}`,
      status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload }, COLP_QUEUE_STAMP);
  }
}
