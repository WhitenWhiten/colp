import { isRemoteDeletePolicy, remoteDeleteRestoreOpId } from '../remote-delete-policy.js';
import { boundedString, clone, safeInteger, strictObject, validateJson, validateRecord } from './codec.js';
import { cursorPage, requestValue, requireActiveScope, runTransaction, scopeRowsRange, transactionDone } from './idb.js';
import type { SyncStoreRuntime } from './runtime.js';
import { STORES } from './schema.js';
import { validateMapping } from './mapping-repository.js';
import { scopeKey, validateScope } from './scope-key.js';
import {
  SyncStateError, type JsonObject, type LocalExclusionSourceKind, type MappingInput, type RemoteDeleteAction,
  type RemoteDeleteDecisionState, type RemoteDeletePolicy, type SyncScope, type UnknownRecord,
} from './types.js';

export interface RemoteDeletePolicyRecord {
  readonly scopeKey: string; readonly policy: RemoteDeletePolicy; readonly casVersion: number;
  readonly generation: number; readonly updatedAt: number;
}
export interface RemoteDeleteDecisionRecord {
  readonly scopeKey: string; readonly decisionId: string; readonly eventId: string; readonly pageId: string;
  readonly operationId: string; readonly effectId: string; readonly effectDigest: string;
  readonly targetId: string; readonly deleteRevision: string; readonly generation: number;
  readonly nativeIds: readonly string[]; readonly nodeKind: 'folder' | 'bookmark' | 'separator';
  readonly title: string; readonly policy: RemoteDeletePolicy; readonly action: RemoteDeleteAction | 'pending';
  readonly state: RemoteDeleteDecisionState; readonly casVersion: number; readonly updatedAt: number;
  readonly restoreOpId?: string; readonly error?: string;
}
export interface LocalSyncExclusionRecord {
  readonly scopeKey: string; readonly nativeId: string; readonly decisionId: string;
  readonly rootNativeId: string; readonly generation: number;
  readonly sourceKind?: LocalExclusionSourceKind; readonly priorColpId?: string;
}

const DECISION_STATES: readonly RemoteDeleteDecisionState[] = [
  'pending', 'applying', 'applied', 'keep_local', 'restoring', 'restored', 'rejected',
];
const NODE_KINDS = ['folder', 'bookmark', 'separator'] as const;

export function createRemoteDeleteRepository(ctx: SyncStoreRuntime) {
  const keyFor = (scope: SyncScope) => scopeKey(validateScope(scope));

  async function getRemoteDeletePolicy(scope: SyncScope): Promise<RemoteDeletePolicyRecord> {
    const key = keyFor(scope); const db = await ctx.open();
    const tx = db.transaction(STORES.remoteDeletePolicies, 'readonly'); const done = transactionDone(tx);
    const raw = await requestValue(tx.objectStore(STORES.remoteDeletePolicies).get(key));
    await done;
    return raw ? readPolicy(raw, key, ctx.maxRecordBytes) : {
      scopeKey: key, policy: 'sync', casVersion: 0, generation: scope.generation, updatedAt: 0,
    };
  }

  async function setRemoteDeletePolicy(scope: SyncScope, input: {
    readonly policy: RemoteDeletePolicy; readonly expectedCasVersion: number; readonly now: number;
  }): Promise<RemoteDeletePolicyRecord> {
    ctx.assertWritable(); const key = keyFor(scope); if (!isRemoteDeletePolicy(input.policy)) {
      throw new SyncStateError('remote_delete_policy_invalid');
    }
    safeInteger(input.expectedCasVersion, 'expectedCasVersion'); safeInteger(input.now, 'now', 1);
    let result!: RemoteDeletePolicyRecord;
    const db = await ctx.writableDatabase();
    await runTransaction(db, [STORES.scopes, STORES.remoteDeletePolicies], 'readwrite', async (tx) => {
      const recorded = await requireActiveScope(tx, key);
      const policies = tx.objectStore(STORES.remoteDeletePolicies);
      const prior = await requestValue(policies.get(key));
      const current = prior ? readPolicy(prior, key, ctx.maxRecordBytes) : {
        scopeKey: key, policy: 'sync' as const, casVersion: 0, generation: recorded.generation, updatedAt: 0,
      };
      if (current.casVersion !== input.expectedCasVersion) throw new SyncStateError('remote_delete_policy_stale');
      result = readPolicy({
        scopeKey: key, policy: input.policy, casVersion: current.casVersion + 1,
        generation: recorded.generation, updatedAt: input.now,
      }, key, ctx.maxRecordBytes);
      policies.put(result);
    });
    return clone(result);
  }

  async function getRemoteDeleteDecision(scope: SyncScope, decisionId: string): Promise<RemoteDeleteDecisionRecord | null> {
    const key = keyFor(scope); boundedString(decisionId, 'decisionId');
    const db = await ctx.open(); const tx = db.transaction(STORES.remoteDeleteDecisions, 'readonly');
    const done = transactionDone(tx);
    const raw = await requestValue(tx.objectStore(STORES.remoteDeleteDecisions).get([key, decisionId]));
    await done; return raw ? clone(readDecision(raw, key, ctx.maxRecordBytes)) : null;
  }

  async function listRemoteDeleteDecisions(scope: SyncScope, states?: readonly RemoteDeleteDecisionState[]):
    Promise<RemoteDeleteDecisionRecord[]> {
    const key = keyFor(scope); const db = await ctx.open();
    const tx = db.transaction(STORES.remoteDeleteDecisions, 'readonly'); const done = transactionDone(tx);
    const rows = await cursorPage<UnknownRecord>(tx.objectStore(STORES.remoteDeleteDecisions),
      scopeRowsRange(key), 20_000);
    await done;
    return rows.map((row) => readDecision(row, key, ctx.maxRecordBytes))
      .filter((row) => !states || states.includes(row.state))
      .sort((left, right) => left.updatedAt - right.updatedAt || left.decisionId.localeCompare(right.decisionId));
  }

  async function getLocalSyncExclusion(scope: SyncScope, nativeId: string): Promise<LocalSyncExclusionRecord | null> {
    const key = keyFor(scope); const id = boundedString(nativeId, 'nativeId');
    const db = await ctx.open(); const tx = db.transaction(STORES.localSyncExclusions, 'readonly');
    const done = transactionDone(tx);
    const raw = await requestValue(tx.objectStore(STORES.localSyncExclusions).get([key, id]));
    await done; return raw ? clone(readExclusion(raw, key, ctx.maxRecordBytes)) : null;
  }

  async function listLocalSyncExclusions(scope: SyncScope): Promise<LocalSyncExclusionRecord[]> {
    const key = keyFor(scope); const db = await ctx.open();
    const tx = db.transaction(STORES.localSyncExclusions, 'readonly'); const done = transactionDone(tx);
    const rows = await cursorPage<UnknownRecord>(tx.objectStore(STORES.localSyncExclusions),
      scopeRowsRange(key), 20_000);
    await done; return rows.map((row) => readExclusion(row, key, ctx.maxRecordBytes));
  }

  async function parkRemoteDelete(scope: SyncScope, input: {
    readonly decision: Omit<RemoteDeleteDecisionRecord, 'scopeKey' | 'casVersion' | 'state' | 'action' | 'updatedAt'>
      & { readonly updatedAt: number };
  }): Promise<RemoteDeleteDecisionRecord> {
    ctx.assertWritable(); const key = keyFor(scope); let result!: RemoteDeleteDecisionRecord;
    const db = await ctx.writableDatabase();
    await runTransaction(db, [STORES.scopes, STORES.pullEvents, STORES.remoteDeleteDecisions], 'readwrite',
      async (tx) => {
        const recorded = await requireActiveScope(tx, key);
        if (recorded.generation !== input.decision.generation) throw new SyncStateError('remote_delete_generation_fenced');
        const events = tx.objectStore(STORES.pullEvents);
        const event = await requestValue(events.get([key, input.decision.eventId])) as UnknownRecord | undefined;
        if (!event || event.pageId !== input.decision.pageId) throw new SyncStateError('pull_event_state_invalid');
        const decisions = tx.objectStore(STORES.remoteDeleteDecisions);
        const existing = await requestValue(decisions.get([key, input.decision.decisionId]));
        if (existing) {
          result = readDecision(existing, key, ctx.maxRecordBytes);
          if (result.eventId !== input.decision.eventId || result.effectDigest !== input.decision.effectDigest
              || result.deleteRevision !== input.decision.deleteRevision) {
            throw new SyncStateError('remote_delete_decision_conflict');
          }
          if (event.state === 'staged') events.put({ ...event, state: 'awaiting_confirmation' });
          return;
        }
        if (event.state !== 'staged' && event.state !== 'awaiting_confirmation') {
          throw new SyncStateError('pull_event_state_invalid');
        }
        result = readDecision({
          ...input.decision, scopeKey: key, action: 'pending', state: 'pending', casVersion: 1,
          nativeIds: [...input.decision.nativeIds],
        }, key, ctx.maxRecordBytes);
        decisions.add(result);
        events.put({ ...event, state: 'awaiting_confirmation' });
      });
    return clone(result);
  }

  async function decideRemoteDelete(scope: SyncScope, input: {
    readonly decisionId: string; readonly action: RemoteDeleteAction; readonly expectedCasVersion: number;
    readonly deleteRevision: string; readonly generation: number; readonly now: number;
    readonly permissionGranted: boolean;
  }): Promise<RemoteDeleteDecisionRecord> {
    ctx.assertWritable(); const key = keyFor(scope); let result!: RemoteDeleteDecisionRecord;
    const db = await ctx.writableDatabase();
    await runTransaction(db, [STORES.scopes, STORES.pullEvents, STORES.remoteDeleteDecisions], 'readwrite',
      async (tx) => {
        const recorded = await requireActiveScope(tx, key);
        const decisions = tx.objectStore(STORES.remoteDeleteDecisions);
        const prior = readDecision(await requestValue(decisions.get([key, input.decisionId])),
          key, ctx.maxRecordBytes);
        result = await transitionDecision(tx, key, prior, recorded.generation, input, ctx.maxRecordBytes);
        decisions.put(result);
      });
    return clone(result);
  }

  async function settleRemoteDelete(scope: SyncScope, input: {
    readonly decisionId: string; readonly state: Extract<RemoteDeleteDecisionState, 'applied' | 'keep_local' | 'restored' | 'rejected'>;
    readonly expectedStates: readonly RemoteDeleteDecisionState[]; readonly now: number;
    readonly restoreOpId?: string; readonly error?: string;
    readonly pendingMappings?: readonly MappingInput[]; readonly deleteNativeIds?: readonly string[];
    readonly exclusions?: readonly Omit<LocalSyncExclusionRecord, 'scopeKey'>[];
    readonly unbindNativeIds?: readonly string[];
    readonly apiResultEvidence?: JsonObject;
  }): Promise<RemoteDeleteDecisionRecord> {
    ctx.assertWritable(); const key = keyFor(scope); let result!: RemoteDeleteDecisionRecord;
    const db = await ctx.writableDatabase();
    const stores = [STORES.scopes, STORES.pullEvents, STORES.remoteDeleteDecisions, STORES.localSyncExclusions,
      STORES.mappings];
    await runTransaction(db, stores, 'readwrite', async (tx) => {
      await requireActiveScope(tx, key);
      const decisions = tx.objectStore(STORES.remoteDeleteDecisions);
      const prior = readDecision(await requestValue(decisions.get([key, input.decisionId])),
        key, ctx.maxRecordBytes);
      if (prior.state === input.state && (!input.restoreOpId || prior.restoreOpId === input.restoreOpId)) {
        result = prior; return;
      }
      if (!input.expectedStates.includes(prior.state)) throw new SyncStateError('remote_delete_decision_stale');
      const events = tx.objectStore(STORES.pullEvents);
      const event = await requestValue(events.get([key, prior.eventId])) as UnknownRecord | undefined;
      if (!event) throw new SyncStateError('pull_event_state_invalid');
      if (input.state === 'applied' || input.state === 'keep_local' || input.state === 'restored') {
        if (!['awaiting_confirmation', 'staged', 'intent_prepared', 'browser_call_started',
          'native_event_observed', 'authority_committed'].includes(String(event.state))) {
          throw new SyncStateError('pull_event_state_invalid');
        }
        if (event.state !== 'authority_committed' && event.state !== 'page_complete') {
          events.put({
            ...event, state: 'authority_committed',
            pendingMappings: (input.pendingMappings ?? []).map((row) => validateMapping(key, row, ctx.maxRecordBytes)),
            pendingDeleteNativeIds: input.deleteNativeIds ?? [],
            apiResultEvidence: input.apiResultEvidence ?? { recovery: input.state },
          });
        }
      }
      if (input.exclusions) {
        const exclusions = tx.objectStore(STORES.localSyncExclusions);
        for (const row of input.exclusions) {
          exclusions.put(readExclusion({ ...row, scopeKey: key }, key, ctx.maxRecordBytes));
        }
      }
      if (input.unbindNativeIds) {
        const mappings = tx.objectStore(STORES.mappings);
        for (const nativeId of input.unbindNativeIds) mappings.delete([key, nativeId]);
      }
      const { error: _error, restoreOpId: _restoreOpId, ...rest } = prior;
      result = readDecision({
        ...rest, state: input.state, casVersion: prior.casVersion + 1, updatedAt: input.now,
        action: input.state === 'rejected' ? prior.action
          : input.state === 'applied' ? 'apply' : input.state === 'keep_local' ? 'keep_local' : 'restore',
        ...(input.restoreOpId || prior.restoreOpId ? { restoreOpId: input.restoreOpId ?? prior.restoreOpId } : {}),
        ...(input.error ? { error: input.error } : {}),
      }, key, ctx.maxRecordBytes);
      decisions.put(result);
    });
    return clone(result);
  }

  return {
    getRemoteDeletePolicy, setRemoteDeletePolicy, getRemoteDeleteDecision, listRemoteDeleteDecisions,
    getLocalSyncExclusion, listLocalSyncExclusions, parkRemoteDelete, decideRemoteDelete, settleRemoteDelete,
    putLocalSyncExclusion,
  };

  async function putLocalSyncExclusion(scope: SyncScope, row: Omit<LocalSyncExclusionRecord, 'scopeKey'>):
    Promise<LocalSyncExclusionRecord> {
    ctx.assertWritable(); const key = keyFor(scope);
    const record = validateLocalSyncExclusion(key, { ...row, scopeKey: key }, ctx.maxRecordBytes);
    const db = await ctx.writableDatabase();
    await runTransaction(db, [STORES.scopes, STORES.localSyncExclusions], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key);
      tx.objectStore(STORES.localSyncExclusions).put(record);
    });
    return clone(record);
  }
}

async function transitionDecision(tx: IDBTransaction, key: string, prior: RemoteDeleteDecisionRecord,
  liveGeneration: number, input: {
    readonly action: RemoteDeleteAction; readonly expectedCasVersion: number; readonly deleteRevision: string;
    readonly generation: number; readonly now: number; readonly permissionGranted: boolean;
  }, maxBytes: number): Promise<RemoteDeleteDecisionRecord> {
  if (prior.state === 'applied' && input.action === 'apply') return prior;
  if (prior.state === 'keep_local' && input.action === 'keep_local') return prior;
  if ((prior.state === 'restoring' || prior.state === 'restored') && input.action === 'restore') return prior;
  if (prior.casVersion !== input.expectedCasVersion) throw new SyncStateError('remote_delete_decision_stale');
  if (prior.deleteRevision !== input.deleteRevision) throw new SyncStateError('remote_delete_revision_stale');
  if (!input.permissionGranted) throw new SyncStateError('permission_required');
  if (liveGeneration !== input.generation || prior.generation !== input.generation) {
    throw new SyncStateError('remote_delete_generation_fenced');
  }
  if (prior.state !== 'pending' && prior.state !== 'applying' && prior.state !== 'restoring') {
    throw new SyncStateError('remote_delete_decision_stale');
  }
  const events = tx.objectStore(STORES.pullEvents);
  const event = await requestValue(events.get([key, prior.eventId])) as UnknownRecord | undefined;
  if (!event || (event.state !== 'awaiting_confirmation' && event.state !== 'staged'
      && event.state !== 'authority_committed')) {
    throw new SyncStateError('pull_event_state_invalid');
  }
  const nextState: RemoteDeleteDecisionState = input.action === 'apply' ? 'applying'
    : input.action === 'keep_local' ? 'pending' : 'restoring';
  if (input.action === 'apply' && event.state === 'awaiting_confirmation') {
    events.put({ ...event, state: 'staged' });
  }
  const restoreOpId = input.action === 'restore'
    ? (prior.restoreOpId ?? remoteDeleteRestoreOpId(prior.decisionId)) : prior.restoreOpId;
  return readDecision({
    ...prior, action: input.action, state: nextState, casVersion: prior.casVersion + 1, updatedAt: input.now,
    ...(restoreOpId ? { restoreOpId } : {}),
  }, key, maxBytes);
}

function readPolicy(input: unknown, key: string, maxBytes: number): RemoteDeletePolicyRecord {
  const row = strictObject(input, ['scopeKey', 'policy', 'casVersion', 'generation', 'updatedAt'], 'remote delete policy');
  if (row.scopeKey !== key || !isRemoteDeletePolicy(row.policy)) throw new SyncStateError('remote_delete_policy_invalid');
  const record: RemoteDeletePolicyRecord = {
    scopeKey: key, policy: row.policy, casVersion: safeInteger(row.casVersion, 'casVersion'),
    generation: safeInteger(row.generation, 'generation', 1), updatedAt: safeInteger(row.updatedAt, 'updatedAt'),
  };
  validateRecord(record, maxBytes); return record;
}

function readDecision(input: unknown, key: string, maxBytes: number): RemoteDeleteDecisionRecord {
  const row = strictObject(input, [
    'scopeKey', 'decisionId', 'eventId', 'pageId', 'operationId', 'effectId', 'effectDigest', 'targetId',
    'deleteRevision', 'generation', 'nativeIds', 'nodeKind', 'title', 'policy', 'action', 'state',
    'casVersion', 'updatedAt', 'restoreOpId', 'error',
  ], 'remote delete decision', ['restoreOpId', 'error']);
  if (row.scopeKey !== key || !isRemoteDeletePolicy(row.policy)
      || !DECISION_STATES.includes(row.state as RemoteDeleteDecisionState)
      || !NODE_KINDS.includes(row.nodeKind as typeof NODE_KINDS[number])
      || (row.action !== 'pending' && row.action !== 'apply' && row.action !== 'restore' && row.action !== 'keep_local')) {
    throw new SyncStateError('remote_delete_decision_invalid');
  }
  if (!Array.isArray(row.nativeIds) || row.nativeIds.some((id) => typeof id !== 'string')) {
    throw new SyncStateError('remote_delete_decision_invalid');
  }
  const record: RemoteDeleteDecisionRecord = {
    scopeKey: key, decisionId: boundedString(row.decisionId, 'decisionId'),
    eventId: boundedString(row.eventId, 'eventId'), pageId: boundedString(row.pageId, 'pageId'),
    operationId: boundedString(row.operationId, 'operationId'), effectId: boundedString(row.effectId, 'effectId'),
    effectDigest: boundedString(row.effectDigest, 'effectDigest'), targetId: boundedString(row.targetId, 'targetId'),
    deleteRevision: boundedString(row.deleteRevision, 'deleteRevision'),
    generation: safeInteger(row.generation, 'generation', 1),
    nativeIds: row.nativeIds.map((id) => boundedString(id, 'nativeId')),
    nodeKind: row.nodeKind as RemoteDeleteDecisionRecord['nodeKind'],
    title: boundedString(row.title || 'Untitled', 'title', 512), policy: row.policy, action: row.action,
    state: row.state as RemoteDeleteDecisionState, casVersion: safeInteger(row.casVersion, 'casVersion', 1),
    updatedAt: safeInteger(row.updatedAt, 'updatedAt', 1),
    ...(row.restoreOpId === undefined ? {} : { restoreOpId: boundedString(row.restoreOpId, 'restoreOpId') }),
    ...(row.error === undefined ? {} : { error: boundedString(row.error, 'error', 128) }),
  };
  validateRecord(record, maxBytes); return record;
}

export function validateLocalSyncExclusion(key: string, input: unknown, maxBytes: number): LocalSyncExclusionRecord {
  return readExclusion(input, key, maxBytes);
}

function readExclusion(input: unknown, key: string, maxBytes: number): LocalSyncExclusionRecord {
  const row = strictObject(input, ['scopeKey', 'nativeId', 'decisionId', 'rootNativeId', 'generation',
    'sourceKind', 'priorColpId'], 'local sync exclusion', ['sourceKind', 'priorColpId']);
  if (row.scopeKey !== key) throw new SyncStateError('remote_delete_decision_invalid');
  const sourceKind = row.sourceKind === undefined ? undefined : String(row.sourceKind);
  if (sourceKind !== undefined && sourceKind !== 'remote_delete' && sourceKind !== 'range_exit') {
    throw new SyncStateError('exclusion_source_invalid');
  }
  const record: LocalSyncExclusionRecord = {
    scopeKey: key, nativeId: boundedString(row.nativeId, 'nativeId'),
    decisionId: boundedString(row.decisionId, 'decisionId'),
    rootNativeId: boundedString(row.rootNativeId, 'rootNativeId'),
    generation: safeInteger(row.generation, 'generation', 1),
    ...(sourceKind ? { sourceKind: sourceKind as LocalExclusionSourceKind } : {}),
    ...(row.priorColpId === undefined ? {} : { priorColpId: boundedString(row.priorColpId, 'priorColpId') }),
  };
  validateRecord(record, maxBytes); return record;
}

