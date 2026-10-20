import { requestValue, requireActiveScope, runTransaction, transactionDone } from './idb.js';
import { INDEXES, STORES } from './schema.js';
import { scopeKey, validateScope } from './scope-key.js';
import { readScopeCommandRecord, writeScopeCommandRecord } from './scope-command-evidence.js';
import { rejoinBoundaryDigest } from '../scope-rejoin-authority.js';
import { validateMappingRecord } from './mapping-repository.js';
import { rejoinResolutionId, rejoinGrantId, unresolvedRejoinQueueRows, type RejoinQueueReference } from './rejoin-queue-resolution.js';
import { SyncStateError, type QueueOperation, type ScopeCommandPlanRecord, type SyncScope, type UnknownRecord } from './types.js';
import type { SyncStoreRuntime } from './runtime.js';

export function rejectedRejoinReferences(plan: ScopeCommandPlanRecord): RejoinQueueReference[] {
  const value = plan.rejoinDecision?.rejectedReferences;
  return Array.isArray(value) ? value as unknown as RejoinQueueReference[] : [];
}
export function createRejoinResolutionRepository(ctx: SyncStoreRuntime) {
  async function filterResolvedQueueIssues(scope: SyncScope, rows: readonly QueueOperation[]): Promise<QueueOperation[]> {
    const key = scopeKey(validateScope(scope)); const db = await ctx.open();
    const tx = db.transaction(STORES.diagnostics, 'readonly'); const done = transactionDone(tx);
    const values = await unresolvedRejoinQueueRows(tx, key, rows); await done; return values;
  }
  async function authorizeRejoinRecovery(scope: SyncScope, commandId: string): Promise<void> {
    ctx.assertWritable(); const key = scopeKey(validateScope(scope));
    await runTransaction(await ctx.writableDatabase(), [STORES.scopes, STORES.queue, STORES.scopeCommandPlans,
      STORES.metadata, STORES.diagnostics], 'readwrite', async tx => {
      await requireActiveScope(tx, key);
      const raw = await requestValue(tx.objectStore(STORES.scopeCommandPlans).get([key, commandId]));
      if (!raw) throw new SyncStateError('decision_not_found');
      const plan = await readScopeCommandRecord(tx, key, raw, ctx.maxRecordBytes);
      if (!['confirmed', 'applying'].includes(plan.phase)) throw new SyncStateError('decision_already_made');
      const references = rejectedRejoinReferences(plan);
      for (const reference of references) await exactRejectedRow(tx, key, reference);
      for (const id of plan.dependencies) {
        const grantId = rejoinGrantId(key, id);
        const prior = await requestValue<UnknownRecord | undefined>(tx.objectStore(STORES.diagnostics).get(grantId));
        if (prior) {
          if (prior.commandId !== commandId || prior.baselineDigest !== plan.baselineDigest || prior.dependencyId !== id) {
            throw new SyncStateError('preview_stale');
          }
          continue;
        }
        tx.objectStore(STORES.diagnostics).put({ id: grantId, scopeKey: key, kind: 'rejoin_recovery_grant',
          commandId, baselineDigest: plan.baselineDigest, dependencyId: id });
      }
    });
  }
  /** A refused move did not change content. Recover only its exact optimistic baseline, never a later edit. */
  async function restoreRejectedRejoinBaselines(scope: SyncScope, commandId: string): Promise<void> {
    ctx.assertWritable(); const key = scopeKey(validateScope(scope));
    await runTransaction(await ctx.writableDatabase(), [STORES.scopes, STORES.queue, STORES.mappings,
      STORES.bookmarkEvents, STORES.scopeCommandPlans, STORES.metadata], 'readwrite', async tx => {
      const recorded = await requireActiveScope(tx, key);
      const raw = await requestValue(tx.objectStore(STORES.scopeCommandPlans).get([key, commandId]));
      if (!raw) throw new SyncStateError('decision_not_found');
      const plan = await readScopeCommandRecord(tx, key, raw, ctx.maxRecordBytes);
      if (!['confirmed', 'applying'].includes(plan.phase) || plan.rejoinDecision?.kind !== 'order') {
        throw new SyncStateError('decision_already_made');
      }
      if (plan.rejoinDecision.rejectionBaselinesRestored) return;
      if (plan.rejoinDecision.boundaryDigest !== rejoinBoundaryDigest(recorded)) throw new SyncStateError('preview_stale');
      const mappings = tx.objectStore(STORES.mappings); const changes = [];
      for (const reference of rejectedRejoinReferences(plan)) {
        const row = await exactRejectedRow(tx, key, reference);
        if (row.payload.type !== 'move_node' || typeof row.payload.targetId !== 'string') continue;
        const value = await requestValue(mappings.index(INDEXES.mappingByColpId).get([key, row.payload.targetId]));
        if (!value) throw new SyncStateError('preview_stale');
        const mapping = validateMappingRecord(key, value, ctx.maxRecordBytes);
        // A newer optimistic revision belongs to another edit and must keep its own evidence.
        if (mapping.projection.revision !== row.operationRevision) continue;
        const events = await requestValue<UnknownRecord[]>(tx.objectStore(STORES.bookmarkEvents)
          .index(INDEXES.eventByOperationOrdinal).getAll(IDBKeyRange.bound([key, row.opId], [key, row.opId, []])));
        const captured = events.find(event => (event.details as UnknownRecord)?.mapping);
        const expected = ((captured?.details as UnknownRecord | undefined)?.mapping as UnknownRecord | undefined)?.projection as UnknownRecord | undefined;
        if (!row.baseRevision || row.baseRevision.startsWith('local-') || expected?.digest !== mapping.projection.digest) {
          throw new SyncStateError('preview_stale');
        }
        // Preserve the original content baseline for the subsequent three-way rejoin comparison.
        changes.push({ ...mapping, projection: { ...mapping.projection, revision: row.baseRevision,
          resourceRevision: row.baseRevision } });
      }
      for (const change of changes) mappings.put(change);
      await writeScopeCommandRecord(tx, key, { ...plan,
        rejoinDecision: { ...plan.rejoinDecision, rejectionBaselinesRestored: true }, updatedAt: Date.now() }, ctx.maxRecordBytes);
    });
  }
  /** Commit completion and acknowledgements together; an accepted but unfinished choice closes nothing. */
  async function completeRejoinDecision(scope: SyncScope, commandId: string): Promise<void> {
    ctx.assertWritable(); const key = scopeKey(validateScope(scope));
    await runTransaction(await ctx.writableDatabase(), [STORES.scopes, STORES.queue, STORES.receipts,
      STORES.bookmarkEvents, STORES.scopeCommandPlans, STORES.metadata, STORES.diagnostics], 'readwrite', async tx => {
      await requireActiveScope(tx, key);
      const raw = await requestValue(tx.objectStore(STORES.scopeCommandPlans).get([key, commandId]));
      if (!raw) throw new SyncStateError('decision_not_found');
      const plan = await readScopeCommandRecord(tx, key, raw, ctx.maxRecordBytes);
      if (plan.phase === 'active') return;
      if (!['confirmed', 'applying'].includes(plan.phase)) throw new SyncStateError('decision_already_made');
      if (['delete_remote', 'keep_local_order'].includes(plan.retryReason ?? '')) for (const id of plan.dependencies) {
        const event = await requestValue<UnknownRecord | undefined>(tx.objectStore(STORES.bookmarkEvents).get([key, id]));
        const opId = typeof event?.opId === 'string' ? event.opId : id;
        const row = await requestValue<QueueOperation | undefined>(tx.objectStore(STORES.queue).index(INDEXES.queueByOpId).get([key, opId]));
        if (!row || row.status !== 'terminal' || row.recovery?.resultStatus === 'rejected' || !row.echoApplied) {
          throw new SyncStateError('rejoin_dependency_pending');
        }
      }
      for (const reference of rejectedRejoinReferences(plan)) {
        await exactRejectedRow(tx, key, reference);
        tx.objectStore(STORES.diagnostics).put({ id: rejoinResolutionId(key, reference.opId), scopeKey: key,
          kind: 'rejoin_queue_resolution', ...reference, commandId, baselineDigest: plan.baselineDigest });
      }
      await writeScopeCommandRecord(tx, key, { ...plan, phase: 'active', updatedAt: Date.now() }, ctx.maxRecordBytes);
    });
  }
  return { filterResolvedQueueIssues, authorizeRejoinRecovery, restoreRejectedRejoinBaselines, completeRejoinDecision };
}
async function exactRejectedRow(tx: IDBTransaction, key: string, reference: RejoinQueueReference) {
  const row = await requestValue<QueueOperation | undefined>(tx.objectStore(STORES.queue).index(INDEXES.queueByOpId).get([key, reference.opId]));
  if (!row || row.sequence !== reference.sequence || row.digest !== reference.digest
    || !(row.status === 'rejected' || row.status === 'terminal' && row.recovery?.resultStatus === 'rejected')) {
    throw new SyncStateError('preview_stale');
  }
  return row;
}
