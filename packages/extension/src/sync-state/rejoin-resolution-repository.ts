import { requestValue, requireActiveScope, runTransaction, scopeRowsRange, transactionDone } from './idb.js';
import { INDEXES, STORES } from './schema.js';
import { scopeKey, validateScope } from './scope-key.js';
import { readScopeCommandRecord, writeScopeCommandRecord } from './scope-command-evidence.js';
import { rejoinAttemptDigest, rejoinBoundaryDigest } from '../scope-rejoin-authority.js';
import { clone } from './codec.js';
import { validateMountBinding } from './mount-repository.js';
import { validateMappingRecord } from './mapping-repository.js';
import { rejoinResolutionId, rejoinGrantId, unresolvedRejoinQueueRows, type RejoinQueueReference } from './rejoin-queue-resolution.js';
import { SyncStateError, type MountBindingRecord, type QueueOperation, type ReceiptRecord, type ScopeCommandPlanRecord, type SyncScope, type UnknownRecord } from './types.js';
import type { SyncStoreRuntime } from './runtime.js';

export function rejectedRejoinReferences(plan: ScopeCommandPlanRecord): RejoinQueueReference[] {
  const value = plan.rejoinDecision?.rejectedReferences;
  return Array.isArray(value) ? value as unknown as RejoinQueueReference[] : [];
}
/** Local disposition may resolve a refusal only after the server really
 * consumed its exact sequence. A locally blocked upload is not such a receipt. */
export async function assertTerminalRejoinRejections(tx: IDBTransaction, key: string, plan: ScopeCommandPlanRecord): Promise<void> {
  for (const reference of rejectedRejoinReferences(plan)) {
    const row = await exactRejectedRow(tx, key, reference);
    const receipt = await requestValue<ReceiptRecord | undefined>(tx.objectStore(STORES.receipts)
      .index(INDEXES.queueBySequence).get([key, reference.sequence]));
    const results = receipt?.result?.results;
    if (row.status !== 'terminal' || receipt?.kind !== 'terminal' || receipt.opId !== reference.opId
      || receipt.operationDigest !== reference.digest || !Array.isArray(results)
      || !results.some(value => value && typeof value === 'object' && !Array.isArray(value)
        && value.opId === reference.opId && value.status === 'rejected')) throw new SyncStateError('rejoin_dependency_pending');
  }
}
export function writeRejoinResolutions(tx: IDBTransaction, key: string, plan: ScopeCommandPlanRecord): void {
  for (const reference of rejectedRejoinReferences(plan)) tx.objectStore(STORES.diagnostics).put({
    id: rejoinResolutionId(key, reference.opId), scopeKey: key, kind: 'rejoin_queue_resolution', ...reference,
    commandId: plan.commandId, baselineDigest: plan.baselineDigest,
  });
}
export function createRejoinResolutionRepository(ctx: SyncStoreRuntime) {
  async function filterResolvedQueueIssues(scope: SyncScope, rows: readonly QueueOperation[]): Promise<QueueOperation[]> {
    const key = scopeKey(validateScope(scope));
    if (!rows.some(row => row.status === 'terminal' || row.status === 'rejected')) return [...rows];
    const db = await ctx.open();
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
  /** The comparison and mount publish completion in the same transaction. */
  async function completeRejoinMount(scope: SyncScope, expected: MountBindingRecord): Promise<MountBindingRecord> {
    ctx.assertWritable(); const key = scopeKey(validateScope(scope));
    const expectedMount = validateMountBinding(key, expected, ctx.maxRecordBytes);
    let activated!: MountBindingRecord;
    await runTransaction(await ctx.writableDatabase(), [STORES.scopes, STORES.mounts, STORES.mappings,
      STORES.scopeCommandPlans, STORES.metadata], 'readwrite', async tx => {
      const recorded = await requireActiveScope(tx, key);
      const rawMount = await requestValue(tx.objectStore(STORES.mounts).get([key, expected.mountId]));
      if (!rawMount) throw new SyncStateError('rejoin_boundary_changed');
      const mount = validateMountBinding(key, rawMount, ctx.maxRecordBytes);
      if (recorded.lifecycle !== 'active' || recorded.rootStatus === 'permission_required'
        || JSON.stringify(mount) !== JSON.stringify(expectedMount)) throw new SyncStateError('rejoin_boundary_changed');
      const commandId = `rejoin:${mount.mountId}`;
      const rawPlan = await requestValue(tx.objectStore(STORES.scopeCommandPlans).get([key, commandId]));
      if (!rawPlan) throw new SyncStateError('rejoin_boundary_changed');
      const plan = await readScopeCommandRecord(tx, key, rawPlan, ctx.maxRecordBytes);
      const attempt = rejoinAttemptDigest(mount, recorded);
      if (plan.kind !== 'rejoin' || plan.rejoinDecision || plan.phase !== 'applying' || plan.mountId !== mount.mountId
        || plan.confirmationVersion !== mount.boundaryVersion || plan.baselineDigest !== attempt) {
        throw new SyncStateError('rejoin_boundary_changed');
      }
      const rawRoot = await requestValue(tx.objectStore(STORES.mappings).get([key, mount.nativeRootId]));
      if (!rawRoot || validateMappingRecord(key, rawRoot, ctx.maxRecordBytes).colpId !== mount.remoteMountNodeId) {
        throw new SyncStateError('rejoin_boundary_changed');
      }
      const rows = await requestValue<ScopeCommandPlanRecord[]>(tx.objectStore(STORES.scopeCommandPlans).getAll(scopeRowsRange(key)));
      const dependencies: ScopeCommandPlanRecord[] = [];
      for (const row of rows) if (row.kind === 'rejoin' && row.mountId === mount.mountId && row.rejoinDecision) {
        const decision = await readScopeCommandRecord(tx, key, row, ctx.maxRecordBytes);
        if (decision.rejoinDecision?.attemptDigest === attempt && !decision.rejoinDecision.supersededBy) dependencies.push(decision);
      }
      if (dependencies.some(row => row.phase !== 'active') || dependencies.length !== plan.dependencies.length
        || dependencies.some(row => !plan.dependencies.includes(row.commandId))) throw new SyncStateError('rejoin_dependency_pending');
      activated = validateMountBinding(key, { ...mount, status: 'active', pendingRemoteDelete: undefined }, ctx.maxRecordBytes);
      tx.objectStore(STORES.mounts).put(activated);
      await writeScopeCommandRecord(tx, key, { ...plan, phase: 'active', updatedAt: Date.now() }, ctx.maxRecordBytes);
    });
    return clone(activated);
  }
  return { filterResolvedQueueIssues, authorizeRejoinRecovery, restoreRejectedRejoinBaselines, completeRejoinDecision, completeRejoinMount };
}
async function exactRejectedRow(tx: IDBTransaction, key: string, reference: RejoinQueueReference) {
  const row = await requestValue<QueueOperation | undefined>(tx.objectStore(STORES.queue).index(INDEXES.queueByOpId).get([key, reference.opId]));
  if (!row || row.sequence !== reference.sequence || row.digest !== reference.digest
    || !(row.status === 'rejected' || row.status === 'terminal' && row.recovery?.resultStatus === 'rejected')) {
    throw new SyncStateError('preview_stale');
  }
  return row;
}
