import { digestJson } from '../bookmark-event-codec.js';
import { rejoinAttemptDigest, rejoinBoundaryDigest } from '../scope-rejoin-authority.js';
import { SyncStateError, type JsonObject, type MappingInput, type ScopeCommandPlanRecord,
  type MountBindingRecord, type SyncScope, type UnknownRecord } from './types.js';
import { clone, safeInteger } from './codec.js';
import { requestValue, requireActiveScope, runTransaction, scopeRowsRange, transactionDone } from './idb.js';
import { INDEXES, STORES } from './schema.js';
import { scopeKey, validateScope } from './scope-key.js';
import { validateMapping, validateMappingRecord } from './mapping-repository.js';
import { readScopeCommandRecord, writeScopeCommandRecord } from './scope-command-evidence.js';
import { assertTerminalRejoinRejections, writeRejoinResolutions } from './rejoin-resolution-repository.js';
import type { RejoinNative } from '../scope-rejoin-mutation.js';
import type { SyncStoreRuntime } from './runtime.js';

export interface RejoinRestoreOrder { readonly parentId: string; readonly children: readonly string[]; readonly childrenRevision: string }
export interface RejoinRestoreChange { readonly before: MappingInput | null; readonly after: MappingInput }
export interface RejoinRestoreEvidence {
  readonly changes: readonly RejoinRestoreChange[];
  readonly orders: readonly RejoinRestoreOrder[];
  readonly observationDigest: string;
}
export interface RejoinMaterializationAuthority {
  readonly before: MappingInput; readonly parent: MappingInput; readonly mount: MountBindingRecord;
  readonly boundaryDigest: string; readonly commandId?: string; readonly baselineDigest?: string | null;
}
export interface RejoinMutationAuthority {
  readonly before: MappingInput; readonly mount: MountBindingRecord; readonly parents: readonly MappingInput[];
  readonly boundaryDigest: string; readonly exclusionDigest: string;
  readonly deletion?: { readonly boundary: RejoinDeletionBoundary; readonly members: readonly MappingInput[];
    readonly unmappedNativeIds?: readonly string[] };
  readonly decision?: { readonly commandId: string; readonly token: string; readonly choice: string };
}
export interface RejoinRemoteDeleteMember {
  readonly nativeId: string; readonly native: RejoinNative | null; readonly mapping: MappingInput | null;
  readonly children: readonly string[] | null;
}
export function remoteDeleteReviewPrefix(mountId: string, rootId: string, attemptDigest: string): string {
  return `rejoin-remote-delete:${digestJson({ mountId, rootId, attemptDigest }).slice(7)}:`;
}
export interface RejoinRemoteDeleteEvidence {
  readonly authority: RejoinMutationAuthority; readonly members: readonly RejoinRemoteDeleteMember[];
}
export const remoteDeleteMemberIntentId = (commandId: string, token: string, nativeId: string): string =>
  `rejoin-remote-delete-member:${digestJson({ commandId, token, nativeId }).slice(7)}`;
export function remoteDeleteEvidence(plan: ScopeCommandPlanRecord): RejoinRemoteDeleteEvidence {
  const value = plan.rejoinDecision?.remoteDeletion;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.authority
    || !Array.isArray(value.members) || !value.members.length) throw new SyncStateError('command_decision_invalid');
  const evidence = value as unknown as RejoinRemoteDeleteEvidence;
  if (!evidence.authority.before || !evidence.authority.deletion
    || evidence.members[0]?.nativeId !== evidence.authority.before.nativeId
    || evidence.members.some(row => !row || typeof row !== 'object' || typeof row.nativeId !== 'string' || !row.nativeId
      || row.native !== null && (!row.native || typeof row.native !== 'object' || Array.isArray(row.native))
      || row.mapping && row.mapping.nativeId !== row.nativeId
      || row.children !== null && (!Array.isArray(row.children) || row.children.some(id => typeof id !== 'string')))
    || new Set(evidence.members.map(row => row.nativeId)).size !== evidence.members.length) throw new SyncStateError('command_decision_invalid');
  return evidence;
}
export interface RejoinDeletionBoundary {
  readonly nextSequence: number; readonly nextEventOrdinal: number;
  readonly exclusionDigest: string; readonly policyVersion: number;
}
export function exclusionEvidenceDigest(rows: readonly unknown[]): string {
  return digestJson(rows.map(raw => {
    const { scopeKey: _key, ...value } = raw as UnknownRecord; return value;
  }).sort((left, right) => String(left.nativeId).localeCompare(String(right.nativeId))) as JsonObject[]);
}
export function restoreEvidence(record: ScopeCommandPlanRecord): RejoinRestoreEvidence {
  const value = record.rejoinDecision?.restore;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Array.isArray(value.changes) || !Array.isArray(value.orders)
    || typeof value.observationDigest !== 'string') throw new SyncStateError('command_decision_invalid');
  return value as unknown as RejoinRestoreEvidence;
}
export function mappingEvidenceDigest(mapping: MappingInput): string {
  const { scopeKey: _key, ...value } = mapping as MappingInput & { scopeKey?: string };
  return digestJson(value as unknown as JsonObject);
}
export function observationEvidenceDigest(values: readonly unknown[]): string {
  return digestJson([...values].sort((a, b) => String((a as UnknownRecord).colpId).localeCompare(String((b as UnknownRecord).colpId))) as never);
}

export function createRejoinDecisionRepository(ctx: SyncStoreRuntime) {
  const keyFor = (scope: SyncScope) => scopeKey(validateScope(scope));
  const names = [STORES.scopes, STORES.scopeCommandPlans, STORES.metadata, STORES.mounts];

  /** Publish the replacement and revoke the superseded permission in one
   * transaction, including every evidence page. A crash leaves one authority. */
  async function stageRejoinRemoteDelete(scope: SyncScope, input: Omit<ScopeCommandPlanRecord, 'scopeKey'>): Promise<void> {
    ctx.assertWritable(); const key = keyFor(scope);
    await runTransaction(await ctx.writableDatabase(), names, 'readwrite', async tx => {
      const recorded = await requireActiveScope(tx, key);
      const mount = await requestValue<MountBindingRecord | undefined>(tx.objectStore(STORES.mounts).get([key, input.mountId!]));
      if (!mount || mount.status !== 'detached' || mount.boundaryVersion !== input.confirmationVersion
        || rejoinBoundaryDigest(recorded) !== input.rejoinDecision?.boundaryDigest
        || rejoinAttemptDigest(mount, recorded) !== input.rejoinDecision?.attemptDigest) throw new SyncStateError('preview_stale');
      const candidate = { ...input, scopeKey: key }, evidence = remoteDeleteEvidence(candidate);
      const raw = await requestValue(tx.objectStore(STORES.scopeCommandPlans).getAll(scopeRowsRange(key)));
      const plans = await Promise.all(raw.map(row => readScopeCommandRecord(tx, key, row, ctx.maxRecordBytes)));
      // A user undo can return to an earlier token. It needs a new pending
      // record; a failed accepted record must never regain its permission.
      const same = plans.find(row => row.rejoinDecision?.kind === 'remote_delete'
        && row.rejoinDecision.attemptDigest === input.rejoinDecision?.attemptDigest
        && row.rejoinDecision.rootId === input.rejoinDecision?.rootId && row.baselineDigest === input.baselineDigest
        && row.phase !== 'failed' && !row.rejoinDecision.supersededBy);
      if (same && same.phase !== 'pending') return;
      let commandId = same?.commandId ?? input.commandId;
      for (let suffix = 1; plans.some(row => row.commandId === commandId && row.commandId !== same?.commandId); suffix++) {
        commandId = `${input.commandId}:review-${suffix}`;
      }
      const mappedIds = new Set(evidence.members.flatMap(row => row.mapping ? [row.mapping.colpId] : []));
      for (const prior of plans) if (prior.commandId !== commandId
        && prior.rejoinDecision?.attemptDigest === input.rejoinDecision?.attemptDigest
        && prior.phase !== 'active' && !prior.rejoinDecision?.supersededBy
        && (prior.rejoinDecision?.kind === 'remote_delete' && prior.rejoinDecision.rootId === input.rejoinDecision?.rootId
          || prior.rejoinDecision?.kind === 'order' && mappedIds.has(String(prior.rejoinDecision.parentId)))) {
        await writeScopeCommandRecord(tx, key, { ...prior, phase: 'failed',
          rejoinDecision: { ...prior.rejoinDecision, supersededBy: commandId }, updatedAt: Date.now() }, ctx.maxRecordBytes);
      }
      await writeScopeCommandRecord(tx, key, { ...candidate, commandId }, ctx.maxRecordBytes);
    });
  }

  /** Accept one immutable choice and its complete preimages before doing any browser work. */
  async function confirmRejoinDecision(scope: SyncScope, input: {
    commandId: string; token: string; choice: string; dependencies: readonly string[]; evidence?: JsonObject;
  }): Promise<ScopeCommandPlanRecord> {
    ctx.assertWritable(); const key = keyFor(scope); const db = await ctx.writableDatabase();
    let result!: ScopeCommandPlanRecord;
    await runTransaction(db, [...mutationStores, STORES.receipts, STORES.diagnostics], 'readwrite', async tx => {
      const recorded = await requireActiveScope(tx, key);
      const raw = await requestValue(tx.objectStore(STORES.scopeCommandPlans).get([key, input.commandId]));
      if (!raw) throw new SyncStateError('decision_not_found');
      const current = await readScopeCommandRecord(tx, key, raw, ctx.maxRecordBytes);
      const allowed = current.rejoinDecision?.kind === 'local_delete' ? ['keep_remote', 'delete_remote']
        : current.rejoinDecision?.kind === 'order' ? ['keep_local_order', 'keep_remote_order']
          : current.rejoinDecision?.kind === 'remote_delete' ? ['keep_local', 'apply_remote_delete'] : [];
      if (current.baselineDigest !== input.token || current.kind !== 'rejoin' || !allowed.includes(input.choice)) {
        throw new SyncStateError('preview_stale');
      }
      if (current.phase !== 'pending') {
        if (current.retryReason !== input.choice || current.phase === 'failed') throw new SyncStateError('decision_already_made');
        result = current; return;
      }
      const mount = await requestValue(tx.objectStore(STORES.mounts).get([key, current.mountId!])) as UnknownRecord | undefined;
      if (recorded.lifecycle !== 'active' || !mount || mount.status !== 'detached'
        || mount.boundaryVersion !== current.confirmationVersion
        || current.rejoinDecision?.boundaryDigest !== rejoinBoundaryDigest(recorded)) throw new SyncStateError('preview_stale');
      if (current.rejoinDecision?.kind === 'remote_delete' && input.evidence) throw new SyncStateError('command_decision_invalid');
      result = { ...current, phase: 'confirmed', retryReason: input.choice, dependencies: [...input.dependencies],
        rejoinDecision: { ...current.rejoinDecision, ...JSON.parse(JSON.stringify(input.evidence ?? {})) }, updatedAt: Date.now() };
      if (current.rejoinDecision?.kind === 'remote_delete') {
        if (current.rejoinDecision.blockedReason) throw new SyncStateError('rejoin_dependency_pending');
        await requireMutation(tx, key, remoteDeleteEvidence(result).authority);
        await assertTerminalRejoinRejections(tx, key, result);
      }
      await writeScopeCommandRecord(tx, key, result, ctx.maxRecordBytes);
    });
    return clone(result);
  }

  /** Validate the entire CAS set before atomically publishing virtual identities and full order evidence. */
  async function prepareRejoinRestore(scope: SyncScope, commandId: string): Promise<void> {
    ctx.assertWritable(); const key = keyFor(scope); const db = await ctx.writableDatabase();
    await runTransaction(db, [...names, STORES.mappings, STORES.remoteObservations], 'readwrite', async tx => {
      const recorded = await requireActiveScope(tx, key);
      const raw = await requestValue(tx.objectStore(STORES.scopeCommandPlans).get([key, commandId]));
      if (!raw) throw new SyncStateError('decision_not_found');
      const plan = await readScopeCommandRecord(tx, key, raw, ctx.maxRecordBytes);
      if (plan.retryReason !== 'keep_remote' || !['confirmed', 'applying'].includes(plan.phase)) {
        throw new SyncStateError('decision_already_made');
      }
      if (plan.phase === 'applying') return;
      if (recorded.lifecycle !== 'active' || plan.rejoinDecision?.boundaryDigest !== rejoinBoundaryDigest(recorded)) {
        throw new SyncStateError('preview_stale');
      }
      const evidence = restoreEvidence(plan);
      const mappings = tx.objectStore(STORES.mappings);
      const rows = (await requestValue(mappings.getAll(scopeRowsRange(key))))
        .map(value => validateMappingRecord(key, value, ctx.maxRecordBytes));
      const byColp = new Map(rows.map(row => [row.colpId, row]));
      const byNative = new Map(rows.map(row => [row.nativeId, row]));
      const observations = await requestValue(tx.objectStore(STORES.remoteObservations).getAll(scopeRowsRange(key)));
      if (observationEvidenceDigest(observations) !== evidence.observationDigest) throw new SyncStateError('preview_stale');
      const dependencies = new Set(plan.dependencies);
      const prepared = [];
      for (const change of evidence.changes) {
        const current = byColp.get(change.after.colpId);
        if (change.before ? !current || mappingEvidenceDigest(current) !== mappingEvidenceDigest(change.before)
          : current !== undefined) throw new SyncStateError('preview_stale');
        if (!dependencies.has(change.after.colpId) && !evidence.orders.some(order => order.parentId === change.after.colpId)) throw new SyncStateError('command_decision_invalid');
        const occupant = byNative.get(change.after.nativeId);
        if (occupant && occupant.colpId !== change.after.colpId) throw new SyncStateError('mapping_identity_collision');
        // A wide parent's order remains complete in the paged plan when it cannot fit one mapping row.
        let candidate = change.after;
        try { prepared.push(validateMapping(key, candidate, ctx.maxRecordBytes)); }
        catch (error) {
          if (!(error instanceof SyncStateError) || error.code !== 'record_too_large'
            || !candidate.projection.childrenOrder) throw error;
          const { childrenOrder: _order, ...projection } = candidate.projection;
          candidate = { ...candidate, projection };
          prepared.push(validateMapping(key, candidate, ctx.maxRecordBytes));
        }
      }
      for (const change of evidence.changes) if (change.before) mappings.delete([key, change.before.nativeId]);
      for (const mapping of prepared) mappings.put(mapping);
      await writeScopeCommandRecord(tx, key, { ...plan, phase: 'applying', updatedAt: Date.now() }, ctx.maxRecordBytes);
    });
  }
  const materializationStores = [...names, STORES.mappings];
  async function requireMaterialization(tx: IDBTransaction, key: string, input: RejoinMaterializationAuthority) {
    const scope = await requireActiveScope(tx, key);
    const mount = await requestValue<MountBindingRecord | undefined>(tx.objectStore(STORES.mounts).get([key, input.mount.mountId]));
    if (rejoinBoundaryDigest(scope) !== input.boundaryDigest || !mount || mount.status !== input.mount.status
      || mount.boundaryVersion !== input.mount.boundaryVersion
      || rejoinAttemptDigest(mount, scope) !== rejoinAttemptDigest(input.mount, scope)
      || digestJson(mount.pendingRemoteDelete ? { ...mount.pendingRemoteDelete } : null)
        !== digestJson(input.mount.pendingRemoteDelete ? { ...input.mount.pendingRemoteDelete } : null)) failMaterialization();
    const mappings = tx.objectStore(STORES.mappings);
    const raw = await requestValue(mappings.index(INDEXES.mappingByColpId).get([key, input.before.colpId]));
    const parent = await requestValue(mappings.get([key, input.parent.nativeId]));
    if (!raw || mappingEvidenceDigest(validateMappingRecord(key, raw, ctx.maxRecordBytes)) !== mappingEvidenceDigest(input.before)
      || !parent || mappingIdentityDigest(validateMappingRecord(key, parent, ctx.maxRecordBytes)) !== mappingIdentityDigest(input.parent)
      || input.before.parentColpId && input.before.parentColpId !== input.parent.colpId) failMaterialization();
    if (input.commandId) {
      const rawPlan = await requestValue(tx.objectStore(STORES.scopeCommandPlans).get([key, input.commandId]));
      if (!rawPlan) failMaterialization();
      const plan = await readScopeCommandRecord(tx, key, rawPlan, ctx.maxRecordBytes);
      if (plan.phase !== 'applying' || plan.retryReason !== 'keep_remote' || plan.baselineDigest !== input.baselineDigest
        || !plan.dependencies.includes(input.before.colpId)) failMaterialization();
    }
  }
  async function assertRejoinMaterialization(scope: SyncScope, input: RejoinMaterializationAuthority) {
    const key = keyFor(scope); const tx = (await ctx.open()).transaction(materializationStores, 'readonly');
    const done = transactionDone(tx);
    try { await requireMaterialization(tx, key, input); } finally { await done; }
  }
  /** Native awaits cannot turn a missing or advanced mapping into permission to recreate its identity. */
  async function commitRejoinMaterialization(scope: SyncScope, input: RejoinMaterializationAuthority, after: MappingInput) {
    ctx.assertWritable(); const key = keyFor(scope);
    const mapping = validateMapping(key, after, ctx.maxRecordBytes);
    if (mapping.colpId !== input.before.colpId || mapping.parentNativeId !== input.parent.nativeId
      || mapping.rootNativeId !== input.mount.nativeRootId || mapping.mountId !== input.mount.mountId) failMaterialization();
    await runTransaction(await ctx.writableDatabase(), materializationStores, 'readwrite', async tx => {
      await requireMaterialization(tx, key, input);
      const mappings = tx.objectStore(STORES.mappings);
      const occupant = await requestValue<MappingInput | undefined>(mappings.get([key, mapping.nativeId]));
      if (occupant && occupant.colpId !== mapping.colpId) failMaterialization();
      mappings.delete([key, input.before.nativeId]); mappings.put(mapping);
    });
  }
  const mutationStores = [STORES.scopes, STORES.mounts, STORES.mappings, STORES.localSyncExclusions,
    STORES.sequences, STORES.metadata, STORES.queue, STORES.bookmarkEvents, STORES.remoteDeletePolicies,
    STORES.scopeCommandPlans, STORES.remoteObservations, STORES.intents];
  /** Lookup hints select keys, never authorize them. Re-read the entire hinted
   * ancestry in one current transaction before each native member mutation. */
  async function readRejoinBoundaryMappings(scope: SyncScope, nativeIds: readonly string[], colpIds: readonly string[]): Promise<MappingInput[]> {
    const key = keyFor(scope); const tx = (await ctx.open()).transaction([STORES.scopes, STORES.mappings], 'readonly');
    const done = transactionDone(tx);
    try {
      await requireActiveScope(tx, key);
      const mappings = tx.objectStore(STORES.mappings);
      const rows = await Promise.all([
        ...[...new Set(nativeIds)].map(id => requestValue(mappings.get([key, id]))),
        ...[...new Set(colpIds)].map(id => requestValue(mappings.index(INDEXES.mappingByColpId).get([key, id]))),
      ]);
      return rows.filter(row => row !== undefined).map(row => validateMappingRecord(key, row, ctx.maxRecordBytes));
    } finally { await done; }
  }
  /** Capture these before reading the deletion comparison, never from the
   * already-changing tree immediately before removeTree. */
  async function readRejoinDeletionBoundary(scope: SyncScope): Promise<RejoinDeletionBoundary> {
    const key = keyFor(scope); const tx = (await ctx.open()).transaction(mutationStores, 'readonly');
    const done = transactionDone(tx);
    try {
      await requireActiveScope(tx, key);
      const sequence = await requestValue<{ next: number } | undefined>(tx.objectStore(STORES.sequences).get(key));
      const ordinal = await requestValue<{ next: number } | undefined>(tx.objectStore(STORES.metadata).get(`bookmark-event-ordinal:${key}`));
      const policy = await requestValue<{ casVersion: number } | undefined>(tx.objectStore(STORES.remoteDeletePolicies).get(key));
      const exclusions = await requestValue(tx.objectStore(STORES.localSyncExclusions).getAll(scopeRowsRange(key)));
      return { nextSequence: safeInteger(sequence?.next ?? 1, 'nextSequence', 1),
        nextEventOrdinal: safeInteger(ordinal?.next ?? 1, 'nextEventOrdinal', 1),
        exclusionDigest: exclusionEvidenceDigest(exclusions), policyVersion: policy?.casVersion ?? 0 };
    } finally { await done; }
  }
  async function requireMutation(tx: IDBTransaction, key: string, input: RejoinMutationAuthority) {
    const scope = await requireActiveScope(tx, key);
    const mount = await requestValue<MountBindingRecord | undefined>(tx.objectStore(STORES.mounts).get([key, input.mount.mountId]));
    if (!['ready', 'nested_normalized'].includes(scope.rootStatus ?? '') || rejoinBoundaryDigest(scope) !== input.boundaryDigest
      || !mount || mount.status !== input.mount.status || mount.boundaryVersion !== input.mount.boundaryVersion
      || rejoinAttemptDigest(mount, scope) !== rejoinAttemptDigest(input.mount, scope)
      || digestJson(mount.pendingRemoteDelete ? { ...mount.pendingRemoteDelete } : null)
        !== digestJson(input.mount.pendingRemoteDelete ? { ...input.mount.pendingRemoteDelete } : null)) failMaterialization();
    if (input.decision) {
      // Only the immutable header is needed per member; reading all evidence
      // pages here would turn a wide explicit deletion into a quadratic scan.
      const plan = await requestValue<ScopeCommandPlanRecord | undefined>(tx.objectStore(STORES.scopeCommandPlans)
        .get([key, input.decision.commandId]));
      if (!plan || !['confirmed', 'applying'].includes(plan.phase) || plan.baselineDigest !== input.decision.token
        || plan.retryReason !== input.decision.choice) failMaterialization();
    }
    const mappings = tx.objectStore(STORES.mappings);
    const raw = await requestValue(mappings.get([key, input.before.nativeId]));
    if (!raw || mappingEvidenceDigest(validateMappingRecord(key, raw, ctx.maxRecordBytes)) !== mappingEvidenceDigest(input.before)) failMaterialization();
    for (const expected of input.parents) {
      const parent = await requestValue(mappings.get([key, expected.nativeId]));
      if (!parent || mappingIdentityDigest(validateMappingRecord(key, parent, ctx.maxRecordBytes)) !== mappingIdentityDigest(expected)) failMaterialization();
    }
    const exclusions = await requestValue(tx.objectStore(STORES.localSyncExclusions).getAll(scopeRowsRange(key)));
    if (exclusionEvidenceDigest(exclusions) !== input.exclusionDigest) failMaterialization();
    if (input.deletion) {
      const { boundary, members } = input.deletion;
      const nativeIds = new Set([input.before.nativeId, ...members.map(row => row.nativeId), ...(input.deletion.unmappedNativeIds ?? [])]);
      const colpIds = new Set([input.before.colpId, ...members.map(row => row.colpId)]);
      for (const expected of members) {
        const raw = await requestValue(mappings.get([key, expected.nativeId]));
        if (!raw || mappingEvidenceDigest(validateMappingRecord(key, raw, ctx.maxRecordBytes)) !== mappingEvidenceDigest(expected)) failMaterialization();
      }
      for (const nativeId of input.deletion.unmappedNativeIds ?? []) {
        if (await requestValue(mappings.get([key, nativeId]))) failMaterialization();
      }
      const policy = await requestValue<{ casVersion: number } | undefined>(tx.objectStore(STORES.remoteDeletePolicies).get(key));
      if ((policy?.casVersion ?? 0) !== boundary.policyVersion) failMaterialization();
      // Only work authored after this comparison matters here. Existing live
      // work was already part of the deletion protection calculation; unrelated
      // new work must neither be erased nor hold this subtree forever.
      const queues = await requestValue<UnknownRecord[]>(tx.objectStore(STORES.queue)
        .getAll(IDBKeyRange.bound([key, boundary.nextSequence], [key, Number.MAX_SAFE_INTEGER])));
      for (const row of queues) {
        const payload = row.payload as JsonObject, inner = payload.payload as JsonObject | undefined;
        if ([payload.targetId, inner?.parentId, inner?.newParentId].some(id => typeof id === 'string' && colpIds.has(id))) failMaterialization();
      }
      const events = await requestValue<UnknownRecord[]>(tx.objectStore(STORES.bookmarkEvents).index(INDEXES.eventByOrdinal)
        .getAll(IDBKeyRange.bound([key, boundary.nextEventOrdinal], [key, Number.MAX_SAFE_INTEGER])));
      for (const row of events) {
        const details = row.details as JsonObject;
        if ([row.nativeId, details.parentId, details.oldParentId].some(id => typeof id === 'string' && nativeIds.has(id))) failMaterialization();
      }
    }
    return scope;
  }
  async function assertRejoinMutation(scope: SyncScope, input: RejoinMutationAuthority): Promise<void> {
    const key = keyFor(scope); const tx = (await ctx.open()).transaction(mutationStores, 'readonly');
    const done = transactionDone(tx);
    try { await requireMutation(tx, key, input); } finally { await done; }
  }
  /** A browser result cannot overwrite an intervening capture or resurrect a removed identity. */
  async function commitRejoinProjection(scope: SyncScope, input: RejoinMutationAuthority, after: MappingInput | null): Promise<void> {
    ctx.assertWritable(); const key = keyFor(scope);
    const mapping = after && validateMapping(key, after, ctx.maxRecordBytes);
    if (mapping && (mapping.nativeId !== input.before.nativeId || mapping.colpId !== input.before.colpId)) failMaterialization();
    await runTransaction(await ctx.writableDatabase(), mutationStores, 'readwrite', async tx => {
      const recorded = await requireMutation(tx, key, input);
      const mappings = tx.objectStore(STORES.mappings);
      if (mapping) mappings.put(mapping);
      else for (const removed of input.deletion?.members ?? [input.before]) {
        mappings.delete([key, removed.nativeId]);
        if (!input.deletion || input.decision) continue;
        // A later comparison can prove the conflict disappeared (for example,
        // the user removed an unknown child). Retire only an unaccepted review
        // for this exact identity/attempt, atomically with its actual removal.
        // Accepted choices and every upload/receipt remain independent facts.
        const attempt = rejoinAttemptDigest(input.mount, recorded);
        const prefix = remoteDeleteReviewPrefix(input.mount.mountId, removed.colpId, attempt);
        const rows = await requestValue<ScopeCommandPlanRecord[]>(tx.objectStore(STORES.scopeCommandPlans)
          .getAll(IDBKeyRange.bound([key, prefix], [key, `${prefix}\uffff`])));
        for (const raw of rows) {
          const plan = await readScopeCommandRecord(tx, key, raw, ctx.maxRecordBytes);
          if (plan.phase !== 'pending' || plan.rejoinDecision?.kind !== 'remote_delete'
            || plan.rejoinDecision.attemptDigest !== attempt || plan.rejoinDecision.rootId !== removed.colpId
            || plan.rejoinDecision.supersededBy) continue;
          await writeScopeCommandRecord(tx, key, { ...plan, phase: 'failed', updatedAt: Date.now(),
            rejoinDecision: { ...plan.rejoinDecision, supersededBy: `rejoin:${input.mount.mountId}` } }, ctx.maxRecordBytes);
        }
      }
    });
  }
  /** Unbind exactly the confirmed identities and publish the actual local
   * outcome together. This never changes an upload, sequence or receipt. */
  async function completeRejoinRemoteDelete(scope: SyncScope, commandId: string, token: string): Promise<void> {
    ctx.assertWritable(); const key = keyFor(scope);
    await runTransaction(await ctx.writableDatabase(), [...mutationStores, STORES.receipts, STORES.diagnostics], 'readwrite', async tx => {
      const raw = await requestValue(tx.objectStore(STORES.scopeCommandPlans).get([key, commandId]));
      if (!raw) throw new SyncStateError('decision_not_found');
      const plan = await readScopeCommandRecord(tx, key, raw, ctx.maxRecordBytes);
      if (plan.baselineDigest !== token || plan.rejoinDecision?.kind !== 'remote_delete'
        || !['keep_local', 'apply_remote_delete'].includes(plan.retryReason ?? '')) throw new SyncStateError('preview_stale');
      if (plan.phase === 'active') return;
      const evidence = remoteDeleteEvidence(plan);
      await requireMutation(tx, key, { ...evidence.authority,
        decision: { commandId, token, choice: plan.retryReason! } });
      await assertTerminalRejoinRejections(tx, key, plan);
      for (const member of evidence.members) {
        if (plan.retryReason === 'apply_remote_delete') {
          const intent = await requestValue<UnknownRecord | undefined>(tx.objectStore(STORES.intents)
            .get([key, remoteDeleteMemberIntentId(commandId, token, member.nativeId)]));
          const expected = intent?.expected as UnknownRecord | undefined;
          const confirmation = intent?.nativeResultConfirmation as UnknownRecord | undefined;
          if (!intent || intent.commandId !== commandId || intent.nativeTargetId !== member.nativeId
            || intent.generation !== scope.generation || intent.state !== 'page_complete'
            || intent.liveWorkKind !== 'rejoin' || expected?.kind !== 'remove' || expected.nativeId !== member.nativeId
            || confirmation?.nativeId !== member.nativeId
            || !['api_return', 'absent'].includes(String(confirmation.kind))
            || !['absent', 'applied_with_evidence'].includes(String(intent.nativeResult))) throw new SyncStateError('rejoin_dependency_pending');
        }
        if (member.mapping) {
          tx.objectStore(STORES.mappings).delete([key, member.nativeId]);
          tx.objectStore(STORES.remoteObservations).delete([key, member.mapping.colpId]);
        }
        if (plan.retryReason === 'keep_local' && member.native) tx.objectStore(STORES.localSyncExclusions).put({
          scopeKey: key, nativeId: member.nativeId, decisionId: commandId,
          rootNativeId: evidence.authority.mount.nativeRootId, generation: scope.generation,
          sourceKind: 'remote_delete', ...(member.mapping ? { priorColpId: member.mapping.colpId } : {}),
        });
      }
      writeRejoinResolutions(tx, key, plan);
      await writeScopeCommandRecord(tx, key, { ...plan, phase: 'active', updatedAt: Date.now() }, ctx.maxRecordBytes);
    });
  }
  return { confirmRejoinDecision, prepareRejoinRestore, assertRejoinMaterialization, commitRejoinMaterialization,
    readRejoinBoundaryMappings, readRejoinDeletionBoundary, assertRejoinMutation, commitRejoinProjection,
    stageRejoinRemoteDelete, completeRejoinRemoteDelete };
}

function mappingIdentityDigest(value: MappingInput): string {
  const { projection: _projection, scopeKey: _key, ...identity } = value as MappingInput & { scopeKey?: string };
  return digestJson(identity as unknown as JsonObject);
}
function failMaterialization(): never { throw new SyncStateError('rejoin_boundary_changed'); }
