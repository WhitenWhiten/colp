import { boundedString, clone, safeInteger, strictObject, validateRecord } from './codec.js';
import { cursorPage, requestValue, requireActiveScope, runTransaction, scopeRowsRange, transactionDone } from './idb.js';
import { INDEXES, STORES } from './schema.js';
import { scopeKey } from './scope-key.js';
import type { SyncStoreRuntime } from './runtime.js';
import { SyncStateError, type JsonObject, type ScopePreviewRecord, type SyncScope } from './types.js';

export interface BoundaryCommandRecord {
  readonly scopeKey: string; readonly commandId: string; readonly previewId: string;
  readonly kind: 'first-run' | 'range'; readonly requestDigest: string; readonly boundaryVersion: string;
  readonly treeDigest: string; readonly state: 'pending' | 'failed' | 'committed';
  readonly payload: JsonObject; readonly completedSteps: readonly string[];
  readonly createdAt: number; readonly updatedAt: number;
  readonly error?: string; readonly result?: JsonObject; readonly committedBoundaryVersion?: string;
}

/** The browser tree is read before admission. Only durable facts participate in
 * this transaction; no Chrome API call can leave it half committed. A failed
 * command continues to own the boundary until its remaining steps are resumed. */
export function createBoundaryCommandRepository(ctx: SyncStoreRuntime) {
  async function getBoundaryCommand(scope: SyncScope, commandId: string): Promise<BoundaryCommandRecord | null> {
    const key = scopeKey(scope);
    const value = await ctx.readOne(STORES.boundaryCommands, [key, boundedString(commandId, 'commandId')]);
    return value ? readCommand(value, key, ctx.maxRecordBytes) : null;
  }

  async function listPendingBoundaryCommands(scope: SyncScope): Promise<BoundaryCommandRecord[]> {
    const key = scopeKey(scope); const db = await ctx.open();
    const tx = db.transaction(STORES.boundaryCommands, 'readonly'); const done = transactionDone(tx);
    const index = tx.objectStore(STORES.boundaryCommands).index(INDEXES.boundaryCommandByState);
    const rows = (await Promise.all(['pending', 'failed'].map(state =>
      cursorPage<BoundaryCommandRecord>(index, IDBKeyRange.only([key, state]), 2)))).flat();
    await done;
    return rows.map(row => readCommand(row, key, ctx.maxRecordBytes));
  }

  async function admitBoundaryCommand(scope: SyncScope, input: Omit<BoundaryCommandRecord,
    'scopeKey' | 'state' | 'completedSteps' | 'createdAt' | 'updatedAt' | 'result' | 'error' | 'committedBoundaryVersion'> & {
      readonly now?: number;
    }): Promise<BoundaryCommandRecord> {
    const key = scopeKey(scope); const now = input.now ?? Date.now();
    const { now: _now, ...facts } = input;
    const proposed = readCommand({ ...facts, scopeKey: key, state: 'pending', completedSteps: [],
      createdAt: now, updatedAt: now }, key, ctx.maxRecordBytes);
    let result = proposed;
    const db = await ctx.writableDatabase();
    await runTransaction(db, [STORES.scopes, STORES.previews, STORES.boundaryCommands, STORES.advancedPlans], 'readwrite', async tx => {
      const recorded = await requireActiveScope(tx, key);
      const commands = tx.objectStore(STORES.boundaryCommands);
      const existing = await requestValue(commands.get([key, input.commandId]));
      if (existing) {
        result = readCommand(existing, key, ctx.maxRecordBytes);
        if (result.kind !== input.kind || result.previewId !== input.previewId
            || result.requestDigest !== input.requestDigest) throw new SyncStateError('confirmation_conflict');
        return;
      }
      const pending = (await Promise.all(['pending', 'failed'].map(state =>
        cursorPage<BoundaryCommandRecord>(commands.index(INDEXES.boundaryCommandByState),
          IDBKeyRange.only([key, state]), 1)))).flat();
      if (pending.length) throw new SyncStateError('sync_busy');
      const advanced = await cursorPage<{ state: string }>(tx.objectStore(STORES.advancedPlans), scopeRowsRange(key), 100_001);
      if (advanced.some(plan => plan.state !== 'completed')) throw new SyncStateError('sync_busy');
      const preview = await requestValue(tx.objectStore(STORES.previews).get([key, input.previewId])) as ScopePreviewRecord | undefined;
      if (!preview || preview.expiresAt <= now) throw new SyncStateError('preview_stale');
      if (preview.consumedAt !== undefined) throw new SyncStateError('duplicate_confirm');
      if ((recorded.boundaryVersion ?? '0') !== input.boundaryVersion
          || preview.boundaryVersion !== input.boundaryVersion || preview.treeDigest !== input.treeDigest
          || (input.kind === 'range') !== (preview.kind === 'range')) throw new SyncStateError('preview_stale');
      if (input.kind === 'first-run' && recorded.firstRun !== 'none' && recorded.firstRun !== 'deferred'
          || input.kind === 'range' && recorded.firstRun !== 'completed') throw new SyncStateError('preview_stale');
      tx.objectStore(STORES.previews).put({ ...preview, consumedAt: now, consumedBy: input.commandId });
      commands.add(proposed);
      if (input.kind === 'first-run') tx.objectStore(STORES.scopes).put({ ...recorded, firstRun: 'running' });
    });
    return clone(result);
  }

  async function advanceBoundaryCommand(scope: SyncScope, commandId: string, input: {
    readonly step?: string; readonly error?: string; readonly result?: JsonObject; readonly now?: number;
  }): Promise<BoundaryCommandRecord> {
    const key = scopeKey(scope); let result!: BoundaryCommandRecord;
    const db = await ctx.writableDatabase();
    await runTransaction(db, [STORES.scopes, STORES.boundaryCommands], 'readwrite', async tx => {
      const scopeRecord = await requireActiveScope(tx, key);
      const commands = tx.objectStore(STORES.boundaryCommands);
      const prior = readCommand(await requestValue(commands.get([key, commandId])), key, ctx.maxRecordBytes);
      if (prior.state === 'committed') { result = prior; return; }
      if ((scopeRecord.boundaryVersion ?? '0') !== prior.boundaryVersion) throw new SyncStateError('preview_stale');
      const { error: _error, ...rest } = prior;
      const nextVersion = String(safeInteger(Number(prior.boundaryVersion), 'boundaryVersion') + 1);
      result = readCommand({ ...rest, state: input.result ? 'committed' : input.error ? 'failed' : 'pending',
        updatedAt: input.now ?? Date.now(),
        completedSteps: [...new Set([...prior.completedSteps, ...(input.step ? [input.step] : [])])],
        ...(input.error ? { error: input.error } : {}),
        ...(input.result ? { result: input.result, committedBoundaryVersion: nextVersion } : {}),
      }, key, ctx.maxRecordBytes);
      commands.put(result);
      if (input.result) tx.objectStore(STORES.scopes).put({ ...scopeRecord, boundaryVersion: nextVersion });
    });
    return clone(result);
  }

  return { getBoundaryCommand, listPendingBoundaryCommands, admitBoundaryCommand, advanceBoundaryCommand };
}

function readCommand(input: unknown, key: string, maxBytes: number): BoundaryCommandRecord {
  const row = strictObject(clone(input), ['scopeKey', 'commandId', 'previewId', 'kind', 'requestDigest',
    'boundaryVersion', 'treeDigest', 'state', 'payload', 'completedSteps', 'createdAt', 'updatedAt',
    'error', 'result', 'committedBoundaryVersion'], 'boundary command', ['error', 'result', 'committedBoundaryVersion']);
  if (row.scopeKey !== key || !['first-run', 'range'].includes(String(row.kind))
      || !['pending', 'failed', 'committed'].includes(String(row.state))
      || !Array.isArray(row.completedSteps) || !row.payload || typeof row.payload !== 'object'
      || Array.isArray(row.payload) || row.result !== undefined && (!row.result || typeof row.result !== 'object'
        || Array.isArray(row.result))) throw new SyncStateError('boundary_command_invalid');
  const result: BoundaryCommandRecord = {
    scopeKey: key, commandId: boundedString(row.commandId, 'commandId'), previewId: boundedString(row.previewId, 'previewId'),
    kind: row.kind as BoundaryCommandRecord['kind'], requestDigest: boundedString(row.requestDigest, 'requestDigest'),
    boundaryVersion: boundedString(row.boundaryVersion, 'boundaryVersion'), treeDigest: boundedString(row.treeDigest, 'treeDigest'),
    state: row.state as BoundaryCommandRecord['state'], payload: row.payload as JsonObject,
    completedSteps: row.completedSteps.map(step => boundedString(step, 'step')),
    createdAt: safeInteger(row.createdAt, 'createdAt'), updatedAt: safeInteger(row.updatedAt, 'updatedAt'),
    ...(row.error === undefined ? {} : { error: boundedString(row.error, 'error') }),
    ...(row.result === undefined ? {} : { result: row.result as JsonObject }),
    ...(row.committedBoundaryVersion === undefined ? {} : {
      committedBoundaryVersion: boundedString(row.committedBoundaryVersion, 'committedBoundaryVersion'),
    }),
  };
  validateRecord(result, maxBytes); return result;
}
