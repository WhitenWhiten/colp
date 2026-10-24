import { boundedString } from './codec.js';
import { cursorPage, requestValue, requireActiveScope, runTransaction } from './idb.js';
import { DISMISSED_REJECTION_CODE, DISMISSIBLE_OPERATION_TYPES, isSettledRejection } from './open-issue-facts.js';
import { pullIssueFactId, pullIssueRange } from './pull-issue-repository.js';
import { consumedRejectionFactId } from './queue-issue-repository.js';
import { DEPENDENT_HOLDS } from './queue-hold.js';
import { validateQueueRecord } from './queue-validate.js';
import type { SyncStoreRuntime } from './runtime.js';
import { INDEXES, STORES } from './schema.js';
import { scopeKey, validateScope } from './scope-key.js';
import type { QueueOperation, SyncScope, UnknownRecord } from './types.js';

/** The mappings that stand for a bookmark that is not here yet. */
const NOT_LANDED = /^(?:recovery:|sidecar:|unmounted:|pending:)/u;

export interface DismissOutcome {
  /** Closed: no longer an open issue. */
  readonly closed: readonly string[];
  /** Not closed: gone already, changed since it was read, or not something that can be dismissed. */
  readonly refused: readonly string[];
}

/** How a refused or held upload reads once a person has said to keep this browser's version. */
function dismissedUpload(row: QueueOperation): QueueOperation | undefined {
  if (!DISMISSIBLE_OPERATION_TYPES.has(String(row.payload.type))) return undefined;
  // The server consumed its sequence and refused it: the receipt stays, the issue closes.
  if (row.status === 'terminal') return row.recovery?.resultStatus === 'rejected' ? { ...row, recovery: undefined } : undefined;
  if (row.status === 'rejected') return isSettledRejection(row) ? undefined : { ...row, recovery: { code: DISMISSED_REJECTION_CODE } };
  // Held changes that wait for another one follow it; only a change held for its own problem is dismissed.
  if (row.status === 'set_aside') {
    return DEPENDENT_HOLDS.has(row.recovery?.code ?? '') ? undefined
      : { ...row, status: 'rejected', recovery: { code: DISMISSED_REJECTION_CODE } };
  }
  return undefined;
}

/**
 * Closing an item from this browser (K5): the part of "Dismiss" that touches storage. Nothing here deletes a
 * bookmark, a mapping or a queued byte that has not been refused; a closed upload stays as history, a closed
 * remote item loses only the hold that kept later changes to it from applying.
 */
export function createIssueActionsRepository(ctx: SyncStoreRuntime) {
  /**
   * Uploads that did not go through, closed. A refused or held content change or move becomes settled history
   * (`rejected`, `dismissed`), exactly like a change that was captured afresh; the changes that waited behind
   * it are then released by the next pass as they are for any settled holder.
   */
  async function dismissQueueIssues(input: SyncScope, opIds: readonly string[]): Promise<DismissOutcome> {
    ctx.assertWritable(); const key = scopeKey(validateScope(input));
    const wanted = [...new Set(opIds.map(opId => boundedString(opId, 'opId')))];
    const closed: string[] = []; const refused: string[] = [];
    await runTransaction(await ctx.writableDatabase(), [STORES.scopes, STORES.queue, STORES.diagnostics], 'readwrite', async tx => {
      await requireActiveScope(tx, key);
      const queue = tx.objectStore(STORES.queue);
      for (const opId of wanted) {
        const value = await requestValue(queue.index(INDEXES.queueByOpId).get([key, opId]));
        const row = value ? validateQueueRecord(value, ctx.maxRecordBytes) : undefined;
        const next = row ? dismissedUpload(row) : undefined;
        if (!row || !next) { refused.push(opId); continue; }
        queue.put(validateQueueRecord(next, ctx.maxRecordBytes));
        if (row.status === 'terminal') tx.objectStore(STORES.diagnostics).delete(consumedRejectionFactId(key, opId));
        closed.push(opId);
      }
    });
    return { closed, refused };
  }

  /** Remote items this browser set aside, closed: the hold ends and this browser keeps the version it has. */
  async function dismissPullIssues(input: SyncScope, nodeIds: readonly string[]): Promise<DismissOutcome> {
    ctx.assertWritable(); const key = scopeKey(validateScope(input));
    const wanted = [...new Set(nodeIds.map(nodeId => boundedString(nodeId, 'nodeId')))];
    const closed: string[] = []; const refused: string[] = [];
    await runTransaction(await ctx.writableDatabase(), [STORES.scopes, STORES.diagnostics], 'readwrite', async tx => {
      await requireActiveScope(tx, key);
      const rows = tx.objectStore(STORES.diagnostics);
      for (const nodeId of wanted) {
        const id = pullIssueFactId(key, nodeId);
        const row = await requestValue(rows.get(id)) as UnknownRecord | undefined;
        // A hold that a conflict decision settles is not closed from here.
        if (row?.kind !== 'pull_issue' || Array.isArray(row.conflictOpIds) && row.conflictOpIds.length > 0) { refused.push(nodeId); continue; }
        rows.delete(id); closed.push(nodeId);
      }
    });
    return { closed, refused };
  }

  /**
   * A remote item that was set aside when it was to be created, and whose bookmark is here by now (a first sync,
   * a rebuild or a later change put it in place), has nothing left to repair. Updates are never closed this way:
   * the node being here says nothing about whether the change that failed was applied.
   */
  async function closeLandedPullIssues(input: SyncScope): Promise<number> {
    ctx.assertWritable(); const key = scopeKey(validateScope(input));
    let closed = 0;
    await runTransaction(await ctx.writableDatabase(), [STORES.scopes, STORES.diagnostics, STORES.pullEvents, STORES.mappings], 'readwrite', async tx => {
      await requireActiveScope(tx, key);
      const rows = tx.objectStore(STORES.diagnostics);
      const issues = await cursorPage<UnknownRecord>(rows.index(INDEXES.diagnosticByScope), pullIssueRange(key), Number.MAX_SAFE_INTEGER);
      for (const issue of issues) {
        if (issue.kind !== 'pull_issue' || Array.isArray(issue.conflictOpIds) && issue.conflictOpIds.length > 0) continue;
        const event = await requestValue(tx.objectStore(STORES.pullEvents).get([key, String(issue.eventId)])) as UnknownRecord | undefined;
        const kind = (event?.payload as { readonly effect?: { readonly kind?: unknown } } | undefined)?.effect?.kind;
        if (kind !== 'node_created' && kind !== 'node_restored') continue;
        const mapping = await requestValue(tx.objectStore(STORES.mappings).index(INDEXES.mappingByColpId)
          .get([key, String(issue.nodeId)])) as UnknownRecord | undefined;
        if (typeof mapping?.nativeId !== 'string' || NOT_LANDED.test(mapping.nativeId)) continue;
        rows.delete(String(issue.id)); closed += 1;
      }
    });
    return closed;
  }

  return { dismissQueueIssues, dismissPullIssues, closeLandedPullIssues };
}
