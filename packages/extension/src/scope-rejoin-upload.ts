import { classifyBookmarkApiFailure } from './bookmark-api-error.js';
import { rejoinBoundaryDigest } from './scope-rejoin-authority.js';
import { assertRejoinCanonicalBoundary } from './scope-rejoin-boundary.js';
import { rejoinDeleteOperationId } from './scope-rejoin-deletion.js';
import type { QueueOperation, SyncScope, createSyncStateStore } from './sync-state-store.js';

/** The missing source is authorized by its durable rejoin decision, never by a cloud-delete bypass. */
export async function assertRejoinDeleteUpload(input: {
  store: ReturnType<typeof createSyncStateStore>; scope: SyncScope; queue: QueueOperation;
  parentOf: (id: string) => Promise<string | undefined>;
}): Promise<void> {
  const decision = (await input.store.listScopeCommandPlans(input.scope)).find(plan =>
    plan.kind === 'rejoin' && plan.rejoinDecision?.kind === 'local_delete' && plan.dependencies.includes(input.queue.opId));
  const recorded = await input.store.getScope(input.scope);
  if (!decision || decision.kind !== 'rejoin' || decision.retryReason !== 'delete_remote'
    || !['confirmed', 'applying'].includes(decision.phase) || !decision.baselineDigest
    || rejoinDeleteOperationId({ commandId: decision.commandId, token: decision.baselineDigest }) !== input.queue.opId
    || !decision.dependencies.includes(input.queue.opId) || decision.rejoinDecision?.rootId !== input.queue.payload.targetId
    || decision.rejoinDecision?.boundaryDigest !== rejoinBoundaryDigest(recorded)) throw new Error('queued_upload_excluded');
  const mappings = await input.store.listMappings(input.scope);
  const members = Array.isArray(decision.rejoinDecision.missingIds) ? decision.rejoinDecision.missingIds : [];
  const selected = mappings.filter(row => members.includes(row.colpId));
  if (!selected.length || selected.length !== members.length) throw new Error('upload_boundary_unavailable');
  await assertRejoinCanonicalBoundary({ ...input, getNative: async () => undefined }, mappings, selected,
    String(decision.rejoinDecision.boundaryDigest));
  const byNative = new Map(mappings.map(row => [row.nativeId, row]));
  for (const mapping of selected) {
    let id: string | undefined = mapping.nativeId; const seen = new Set<string>(); let admitted = false;
    while (id && id !== '0') {
      if (seen.has(id)) throw new Error('upload_boundary_unavailable');
      seen.add(id);
      const current = byNative.get(id);
      if (current && recorded?.selectedRoots.includes(current.colpId)) admitted = true;
      if (current && recorded?.privateRoots?.includes(current.colpId)
        || await input.store.getLocalSyncExclusion(input.scope, id)) throw new Error('queued_upload_excluded');
      try { id = await input.parentOf(id); }
      catch (error) {
        if (classifyBookmarkApiFailure(error) !== 'not_found' || !current || !members.includes(current.colpId)) throw error;
        id = current.parentNativeId;
      }
    }
    if (!admitted) throw new Error('queued_upload_excluded');
  }
}
